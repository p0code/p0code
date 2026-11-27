//! Spawning and attaching to the native Go daemon `p0d`, the same way the Electron app does
//! (`apps/desktop/src/backend/DesktopBackendService.ts`), so both GUIs pointed at one home share
//! one `p0d`: the same ready file, secret file, log file, binary lookup order and `serve` flags.
//!
//! `p0-gpui` never spawns `apps/server` directly; `p0d` owns the lazy Node sidecar.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tracing::{info, warn};

use crate::auth::{ensure_desktop_secret_file, read_desktop_secret_file};
use crate::error::ClientError;

const READY_FILE_NAME: &str = "p0d-ready.json";
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;
/// p0d gives its Node sidecar up to 10 seconds to stop before it exits itself.
const STOP_GRACE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyFilePayload {
    pub pid: u32,
    pub port: u16,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct P0dLaunchConfig {
    /// `--p0d-bin` / `P0D_BIN`; plays the role of Electron's `backendBinaryPath` setting.
    pub configured_binary: Option<PathBuf>,
    /// `p0d serve --home`; the Node sidecar keeps its data in the same folder.
    pub home_dir: PathBuf,
    pub host: String,
    /// `0` picks a free port, as Electron does on loopback.
    pub port: u16,
    pub ready_file: PathBuf,
    pub secret_file: PathBuf,
    pub log_file: PathBuf,
    /// `--legacy-server` command, already quoted for p0d's splitter.
    pub legacy_server: Option<String>,
    pub startup_timeout: Duration,
}

impl P0dLaunchConfig {
    pub fn for_home(home_dir: impl Into<PathBuf>) -> Self {
        let home_dir = home_dir.into();
        Self {
            configured_binary: None,
            ready_file: home_dir.join(READY_FILE_NAME),
            secret_file: home_dir.join("secrets").join("desktop-bootstrap-secret"),
            log_file: home_dir.join("logs").join("p0d.log"),
            home_dir,
            host: "127.0.0.1".to_owned(),
            port: 0,
            legacy_server: None,
            startup_timeout: Duration::from_secs(30),
        }
    }

    /// The arguments Electron's `p0dServeArgs` passes.
    pub fn serve_args(&self) -> Vec<std::ffi::OsString> {
        let mut args: Vec<std::ffi::OsString> = vec![
            "serve".into(),
            "--home".into(),
            self.home_dir.clone().into(),
            "--host".into(),
            self.host.clone().into(),
            "--port".into(),
            self.port.to_string().into(),
            "--ready-file".into(),
            self.ready_file.clone().into(),
            "--desktop-bootstrap-secret-file".into(),
            self.secret_file.clone().into(),
        ];
        if let Some(legacy) = &self.legacy_server {
            args.push("--legacy-server".into());
            args.push(legacy.into());
        }
        args
    }
}

/// Handle to either an attached or child-spawned `p0d` daemon.
pub struct P0dProcess {
    url: String,
    pid: u32,
    bootstrap_secret: Option<String>,
    child: Option<Child>,
    ready_file: Option<PathBuf>,
}

impl P0dProcess {
    /// Attaches to a healthy `p0d` already serving this home (one Electron or an earlier launch
    /// started), otherwise starts one as a child that stops when this handle shuts down.
    pub async fn attach_or_spawn(cfg: P0dLaunchConfig) -> Result<Self, ClientError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()?;

        if let Some(existing) = read_healthy(&http, &cfg.ready_file).await {
            info!(url = %existing.url, pid = existing.pid, "attached to existing p0d");
            return Ok(Self {
                url: existing.url,
                pid: existing.pid,
                // The running p0d only knows the secret it read at start; never rotate it here.
                bootstrap_secret: read_desktop_secret_file(&cfg.secret_file),
                child: None,
                ready_file: None,
            });
        }

        Self::spawn(cfg, &http).await
    }

    async fn spawn(cfg: P0dLaunchConfig, http: &reqwest::Client) -> Result<Self, ClientError> {
        if cfg.legacy_server.is_some()
            && cfg.home_dir.file_name().and_then(|n| n.to_str()) != Some("userdata")
        {
            return Err(ClientError::Process(format!(
                "p0d keeps the Node sidecar's data in a folder named \"userdata\", but the home is {}. Pass --home <dir>/userdata.",
                cfg.home_dir.display()
            )));
        }
        let binary = find_p0d_binary(&p0d_binary_candidates(
            cfg.configured_binary.as_deref(),
            std::env::current_exe().ok().as_deref(),
            &repo_roots(),
            dirs_home().as_deref(),
            std::env::var_os("PATH").as_deref(),
        ))
        .ok_or_else(|| {
            ClientError::Process(
                "no p0d binary found; build it with `cd apps/p0d && go build`, install it to ~/.p0code/bin, or pass --p0d-bin".to_owned(),
            )
        })?;

        std::fs::create_dir_all(&cfg.home_dir)?;
        let _ = std::fs::remove_file(&cfg.ready_file);
        let secret = ensure_desktop_secret_file(&cfg.secret_file)?;
        let log = open_log(&cfg.log_file)?;

        let mut cmd = Command::new(&binary);
        cmd.args(cfg.serve_args())
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            // Same sidecar environment Electron sets; p0d itself ignores these.
            .env("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD", "false")
            .env_remove("T3CODE_PORT")
            .env_remove("T3CODE_MODE")
            .env_remove("T3CODE_HOST");

        info!(binary = %binary.display(), home = %cfg.home_dir.display(), "spawning p0d");
        let mut child = cmd.spawn().map_err(|err| {
            ClientError::Process(format!("failed to spawn {}: {err}", binary.display()))
        })?;
        let pid = child.id().unwrap_or_default();

        let deadline = Instant::now() + cfg.startup_timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                return Err(ClientError::Process(format!(
                    "p0d exited before becoming ready ({status}); see {}",
                    cfg.log_file.display()
                )));
            }
            if let Some(ready) = read_healthy(http, &cfg.ready_file).await {
                info!(url = %ready.url, pid, "p0d is ready");
                return Ok(Self {
                    url: ready.url,
                    pid,
                    bootstrap_secret: Some(secret),
                    child: Some(child),
                    ready_file: Some(cfg.ready_file),
                });
            }
            if Instant::now() >= deadline {
                terminate(pid);
                let _ = tokio::time::timeout(STOP_GRACE, child.wait()).await;
                let _ = child.start_kill();
                return Err(ClientError::Process(format!(
                    "p0d did not answer /healthz within {}s; see {}",
                    cfg.startup_timeout.as_secs(),
                    cfg.log_file.display()
                )));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn spawned(&self) -> bool {
        self.child.is_some()
    }

    pub fn bootstrap_secret(&self) -> Option<&str> {
        self.bootstrap_secret.as_deref()
    }

    /// Stops a `p0d` this handle started (SIGTERM, then SIGKILL after the sidecar's grace).
    pub async fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Some(pid) = child.id() {
                terminate(pid);
            }
            if tokio::time::timeout(STOP_GRACE, child.wait())
                .await
                .is_err()
            {
                warn!(pid = self.pid, "p0d ignored SIGTERM; killing it");
                let _ = child.kill().await;
            }
        }
        if let Some(path) = self.ready_file.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for P0dProcess {
    fn drop(&mut self) {
        // SIGTERM lets p0d stop its sidecar; a p0d that outlives us is reattached next launch.
        if let Some(pid) = self.child.as_ref().and_then(Child::id) {
            terminate(pid);
        }
    }
}

#[cfg(unix)]
fn terminate(pid: u32) {
    if let Ok(pid) = i32::try_from(pid)
        && pid > 0
    {
        // SAFETY: `pid` is a child this process spawned and still owns (not yet reaped).
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
}

#[cfg(not(unix))]
fn terminate(_pid: u32) {}

fn open_log(path: &Path) -> Result<std::fs::File, ClientError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > LOG_ROTATE_BYTES) {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        let _ = std::fs::rename(path, rotated);
    }
    Ok(std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?)
}

async fn read_healthy(http: &reqwest::Client, ready_file: &Path) -> Option<ReadyFilePayload> {
    let payload = read_ready_file(ready_file)?;
    probe_healthz(http, &payload.url).await.then_some(payload)
}

fn read_ready_file(path: &Path) -> Option<ReadyFilePayload> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(raw.trim()).ok()
}

pub async fn probe_healthz(http: &reqwest::Client, base_url: &str) -> bool {
    let url = format!("{}/healthz", base_url.trim_end_matches('/'));
    match http.get(&url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

fn binary_name() -> &'static str {
    if cfg!(windows) { "p0d.exe" } else { "p0d" }
}

/// The `<goos>-<goarch>` folder `apps/p0d/scripts/build.sh` writes for this host.
fn dist_target() -> String {
    let goarch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{}-{goarch}", std::env::consts::OS)
}

/// Electron's `p0dBinaryCandidates` order: the bundled binary, the configured path,
/// `~/.p0code/bin`, a dev checkout's `apps/p0d/dist/<os>-<arch>`, then `PATH`. A native build has
/// no `resources/` folder of its own, so "bundled" means next to the executable.
pub fn p0d_binary_candidates(
    configured: Option<&Path>,
    current_exe: Option<&Path>,
    repo_roots: &[PathBuf],
    home: Option<&Path>,
    path_env: Option<&std::ffi::OsStr>,
) -> Vec<PathBuf> {
    let name = binary_name();
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |candidate: PathBuf| {
        if !candidate.as_os_str().is_empty() && !out.contains(&candidate) {
            out.push(candidate);
        }
    };
    if let Some(dir) = current_exe.and_then(Path::parent) {
        push(dir.join("resources").join("p0d").join(name));
        push(dir.join(name));
    }
    if let Some(path) = configured {
        push(path.to_path_buf());
    }
    if let Some(home) = home {
        push(home.join(".p0code").join("bin").join(name));
    }
    for root in repo_roots {
        push(
            root.join("apps")
                .join("p0d")
                .join("dist")
                .join(dist_target())
                .join(name),
        );
    }
    if let Some(path_env) = path_env {
        for dir in std::env::split_paths(path_env) {
            push(dir.join(name));
        }
    }
    out
}

/// The first candidate that is an absolute path to an executable file.
pub fn find_p0d_binary(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|c| c.is_absolute() && is_executable(c))
        .cloned()
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Checkouts this binary runs from (dev builds): the first ancestor of the working directory and
/// of the executable that holds `apps/p0d/go.mod`.
pub fn repo_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let starts = [
        std::env::current_dir().ok(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf)),
    ];
    for start in starts.into_iter().flatten() {
        if let Some(root) = start
            .ancestors()
            .find(|dir| dir.join("apps").join("p0d").join("go.mod").is_file())
            && !roots.iter().any(|r| r == root)
        {
            roots.push(root.to_path_buf());
        }
    }
    roots
}

/// Quotes for p0d's `--legacy-server` splitter: inside double quotes only `\"` and `\\` escape.
pub fn format_legacy_server_command(argv: &[&str]) -> String {
    argv.iter()
        .map(|arg| {
            let escaped = arg.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The sidecar command Electron passes, with `node` in place of Electron-as-Node: the built
/// server of a dev checkout in web mode. `None` when no checkout or `node` is found.
pub fn default_legacy_server_command() -> Option<String> {
    let entry = repo_roots()
        .into_iter()
        .map(|root| {
            root.join("apps")
                .join("server")
                .join("dist")
                .join("bin.mjs")
        })
        .find(|p| p.is_file())?;
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(node_name))
        .find(|p| is_executable(p))?;
    Some(format_legacy_server_command(&[
        node.to_str()?,
        "--title=p0code-backend",
        entry.to_str()?,
        "--mode",
        "web",
        "--no-browser",
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_follow_electron_order() {
        let exe = Path::new("/opt/p0code/p0-gpui");
        let roots = vec![PathBuf::from("/src/p0code")];
        let path_env = std::env::join_paths(["/usr/local/bin", "/usr/bin"]).unwrap();
        let got = p0d_binary_candidates(
            Some(Path::new("/custom/p0d")),
            Some(exe),
            &roots,
            Some(Path::new("/home/u")),
            Some(&path_env),
        );
        let expected: Vec<PathBuf> = [
            "/opt/p0code/resources/p0d/p0d".to_owned(),
            "/opt/p0code/p0d".to_owned(),
            "/custom/p0d".to_owned(),
            "/home/u/.p0code/bin/p0d".to_owned(),
            format!("/src/p0code/apps/p0d/dist/{}/p0d", dist_target()),
            "/usr/local/bin/p0d".to_owned(),
            "/usr/bin/p0d".to_owned(),
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect();
        if cfg!(unix) {
            assert_eq!(got, expected);
        }
    }

    #[test]
    fn find_skips_missing_and_relative_candidates() {
        let dir = std::env::temp_dir().join(format!("p0d-find-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("p0d");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = find_p0d_binary(&[PathBuf::from("p0d"), dir.join("missing"), bin.clone()]);
        assert_eq!(found, Some(bin));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_command_quotes_like_electron() {
        assert_eq!(
            format_legacy_server_command(&["/a b/node", "x\"y", "c\\d"]),
            r#""/a b/node" "x\"y" "c\\d""#
        );
    }

    #[test]
    fn serve_args_match_electron() {
        let mut cfg = P0dLaunchConfig::for_home("/h/userdata");
        cfg.legacy_server = Some("\"node\"".to_owned());
        let args: Vec<String> = cfg
            .serve_args()
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect();
        assert_eq!(
            args,
            [
                "serve",
                "--home",
                "/h/userdata",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--ready-file",
                "/h/userdata/p0d-ready.json",
                "--desktop-bootstrap-secret-file",
                "/h/userdata/secrets/desktop-bootstrap-secret",
                "--legacy-server",
                "\"node\""
            ]
        );
    }
}
