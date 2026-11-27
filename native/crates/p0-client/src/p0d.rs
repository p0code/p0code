//! Spawning and attaching to the native Go daemon `p0d`.
//!
//! `p0-gpui` never spawns `apps/server` directly; `p0d` owns the legacy Node sidecar.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tracing::{debug, info, warn};

use crate::auth::{ensure_bootstrap_secret_file, read_valid_bootstrap_secret_file};
use crate::error::ClientError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyFilePayload {
    pub pid: u32,
    pub port: u16,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct P0dLaunchConfig {
    /// Explicit path to the `p0d` binary. When `None`, resolves via `P0D_BIN`, sibling
    /// directory, or `PATH`.
    pub binary_path: Option<PathBuf>,
    /// Data directory passed to `p0d serve --home <dir>`.
    pub home_dir: PathBuf,
    /// Host to bind (defaults to `127.0.0.1`).
    pub host: String,
    /// Port to bind (`0` picks a free port).
    pub port: u16,
    /// Path where `p0d` writes `{pid, port, url}` atomically once ready.
    pub ready_file: PathBuf,
    /// Path for the 32-byte base64url bootstrap secret (`--desktop-bootstrap-secret-file`).
    pub bootstrap_secret_file: PathBuf,
    /// Optional `--legacy-server` command passed through to `p0d`.
    pub legacy_server: Option<String>,
    /// Maximum time to wait for `p0d` to write its ready file and answer `/healthz`.
    pub startup_timeout: Duration,
}

impl P0dLaunchConfig {
    pub fn for_home(home_dir: impl Into<PathBuf>) -> Self {
        let home_dir = home_dir.into();
        let ready_file = home_dir.join("p0d-ready.json");
        let bootstrap_secret_file = home_dir.join("secrets").join("desktop-bootstrap-secret");
        Self {
            binary_path: None,
            home_dir,
            host: "127.0.0.1".to_owned(),
            port: 0,
            ready_file,
            bootstrap_secret_file,
            legacy_server: None,
            startup_timeout: Duration::from_secs(15),
        }
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
    /// Attaches to an already-running `p0d` described by `cfg.ready_file` if `/healthz`
    /// answers 200 OK; otherwise spawns `p0d serve` as a managed child process and waits
    /// for `--ready-file` and `/healthz`.
    pub async fn attach_or_spawn(cfg: P0dLaunchConfig) -> Result<Self, ClientError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()?;

        if let Some(existing) = try_attach_existing(&http, &cfg.ready_file).await {
            let secret = read_valid_bootstrap_secret_file(&cfg.bootstrap_secret_file);
            info!(url = %existing.url, pid = existing.pid, "attached to existing p0d");
            return Ok(Self {
                url: existing.url,
                pid: existing.pid,
                bootstrap_secret: secret,
                child: None,
                ready_file: None,
            });
        }

        Self::spawn(cfg, &http).await
    }

    async fn spawn(cfg: P0dLaunchConfig, http: &reqwest::Client) -> Result<Self, ClientError> {
        std::fs::create_dir_all(&cfg.home_dir)?;
        if cfg.ready_file.exists() {
            let _ = std::fs::remove_file(&cfg.ready_file);
        }

        // Keep the bootstrap secret file stable across launches (reuse existing valid file).
        let secret = ensure_bootstrap_secret_file(&cfg.bootstrap_secret_file)?;
        let binary = resolve_p0d_binary(cfg.binary_path.as_deref())?;

        let mut cmd = Command::new(&binary);
        cmd.arg("serve")
            .arg("--home")
            .arg(&cfg.home_dir)
            .arg("--host")
            .arg(&cfg.host)
            .arg("--port")
            .arg(cfg.port.to_string())
            .arg("--ready-file")
            .arg(&cfg.ready_file)
            .arg("--desktop-bootstrap-secret-file")
            .arg(&cfg.bootstrap_secret_file)
            .kill_on_drop(true);

        if let Some(legacy) = &cfg.legacy_server {
            cmd.arg("--legacy-server").arg(legacy);
        }

        info!(binary = %binary.display(), home = %cfg.home_dir.display(), "spawning p0d");
        let mut child = cmd.spawn().map_err(|err| {
            ClientError::Process(format!("failed to spawn {}: {err}", binary.display()))
        })?;

        let deadline = Instant::now() + cfg.startup_timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                return Err(ClientError::Process(format!(
                    "p0d exited before becoming ready (status: {status})"
                )));
            }

            if let Some(ready) = read_ready_file(&cfg.ready_file)
                && probe_healthz(http, &ready.url).await
            {
                info!(url = %ready.url, pid = ready.pid, "p0d is ready");
                return Ok(Self {
                    url: ready.url,
                    pid: ready.pid,
                    bootstrap_secret: Some(secret),
                    child: Some(child),
                    ready_file: Some(cfg.ready_file),
                });
            }

            if Instant::now() >= deadline {
                let _ = child.start_kill();
                return Err(ClientError::Process(format!(
                    "timed out waiting for p0d ready file {} and /healthz",
                    cfg.ready_file.display()
                )));
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn bootstrap_secret(&self) -> Option<&str> {
        self.bootstrap_secret.as_deref()
    }

    /// Gracefully stops the spawned `p0d` child (if this handle spawned it).
    pub async fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            debug!(pid = self.pid, "stopping spawned p0d child");
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        if let Some(path) = self.ready_file.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for P0dProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take()
            && let Err(err) = child.start_kill()
        {
            warn!(error = %err, "failed to kill p0d child on drop");
        }
    }
}

async fn try_attach_existing(
    http: &reqwest::Client,
    ready_file: &Path,
) -> Option<ReadyFilePayload> {
    let payload = read_ready_file(ready_file)?;
    if probe_healthz(http, &payload.url).await {
        Some(payload)
    } else {
        None
    }
}

fn read_ready_file(path: &Path) -> Option<ReadyFilePayload> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub async fn probe_healthz(http: &reqwest::Client, base_url: &str) -> bool {
    let url = format!("{}/healthz", base_url.trim_end_matches('/'));
    match http.get(&url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

fn resolve_p0d_binary(explicit: Option<&Path>) -> Result<PathBuf, ClientError> {
    if let Some(path) = explicit {
        return Ok(path.to_path_buf());
    }
    if let Ok(env_bin) = std::env::var("P0D_BIN") {
        let trimmed = env_bin.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join(if cfg!(windows) { "p0d.exe" } else { "p0d" });
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    Ok(PathBuf::from(if cfg!(windows) { "p0d.exe" } else { "p0d" }))
}
