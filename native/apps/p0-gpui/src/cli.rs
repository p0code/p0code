use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Clone, Parser)]
#[command(name = "p0-gpui", about = "Native GPUI desktop client for p0code")]
pub struct Cli {
    /// Data directory for p0d (defaults to ~/.p0code/userdata or $P0CODE_HOME/userdata).
    #[arg(long, value_name = "DIR")]
    pub home: Option<PathBuf>,

    /// Connect directly to an existing p0d/server HTTP URL instead of spawning p0d.
    #[arg(long, value_name = "HTTP_URL")]
    pub url: Option<String>,

    /// Pre-issued bearer token (optional, used with --url).
    #[arg(long, env = "P0CODE_BEARER_TOKEN")]
    pub token: Option<String>,

    /// Explicit path to the p0d binary.
    #[arg(long, env = "P0D_BIN", value_name = "PATH")]
    pub p0d_bin: Option<PathBuf>,

    /// Command p0d runs for its Node sidecar (`--legacy-server`). Defaults to `node` with this
    /// checkout's built `apps/server/dist/bin.mjs`, as the Electron dev app does.
    #[arg(long, env = "P0D_LEGACY_SERVER", value_name = "CMD")]
    pub legacy_server: Option<String>,

    /// Run headless connectivity smoke check: connect, fetch shell snapshot, print counts, exit.
    #[arg(long)]
    pub smoke: bool,
}

impl Cli {
    /// Resolves the userdata directory, matching Electron's `DesktopStatePaths.ts`:
    /// `$P0CODE_HOME/userdata` -> `$T3CODE_HOME/userdata` -> `~/.p0code/userdata`.
    pub fn resolved_home(&self) -> PathBuf {
        if let Some(home) = &self.home {
            return home.clone();
        }
        if let Ok(env_home) = std::env::var("P0CODE_HOME").or_else(|_| std::env::var("T3CODE_HOME"))
        {
            let trimmed = env_home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("userdata");
            }
        }
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".p0code")
            .join("userdata")
    }
}
