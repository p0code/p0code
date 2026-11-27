//! Client authentication modes and local desktop bootstrap token exchange.
//!
//! Mirrors `packages/shared/src/desktopBootstrapToken.ts` and `apps/p0d/internal/auth`:
//! the client shares the GUI's secret file (mode `0600`) with `p0d` via
//! `--desktop-bootstrap-secret-file`, and sends an HMAC-SHA256 derived token (never
//! the raw secret) to `POST /oauth/token`.
//!
//! Every exchange revokes the subject's earlier desktop sessions (PROTOCOL.md §6), so two GUIs
//! signed in to one `p0d` sign each other out. The supervisor in `ws.rs` therefore reuses its
//! token across reconnects and re-exchanges only after a 401, with growing backoff.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac as _};
use p0_protocol::{AccessTokenResponse, TokenExchangeRequest};
use rand::Rng as _;
use sha2::Sha256;

use crate::error::ClientError;

/// Window size (12 hours in milliseconds) for desktop bootstrap token derivation.
pub const DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS: u64 = 12 * 60 * 60 * 1000;

/// Minimum decoded byte length required for the desktop bootstrap secret.
pub const DESKTOP_BOOTSTRAP_SECRET_MIN_BYTES: usize = 32;

type HmacSha256 = Hmac<Sha256>;

/// Authentication strategy used by [`crate::RpcClient`].
#[derive(Debug, Clone)]
pub enum AuthMode {
    /// Local desktop bootstrap: derive a time-windowed HMAC-SHA256 token from the shared
    /// bootstrap secret (written to `--desktop-bootstrap-secret-file`) and exchange it at
    /// `POST /oauth/token` for a bearer session token.
    LocalBootstrap {
        secret: String,
        client_label: String,
    },
    /// Pre-issued bearer token (e.g., for attaching to an existing dev server).
    BearerToken(String),
    /// Remote DPoP pairing (ES256 keypair in OS keychain + single-use DPoP proofs).
    /// Out of scope for Phase 1; see `native/apps/p0-gpui/PARITY.md`.
    Dpop { key_id: String },
}

pub fn current_client_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Derives the lower-case hex HMAC-SHA256 bootstrap token for a given `now_ms`.
///
/// Matches `currentDesktopBootstrapToken` in `packages/shared/src/desktopBootstrapToken.ts`:
/// `hex(HMAC-SHA256(key = secret_utf8, msg = "t3-desktop-bootstrap:" + floor(now_ms / 43200000)))`.
pub fn derive_desktop_bootstrap_token(secret: &str, now_ms: u64) -> String {
    let window = now_ms / DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;
    derive_desktop_bootstrap_token_for_window(secret, window)
}

pub fn derive_desktop_bootstrap_token_for_window(secret: &str, window: u64) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(format!("t3-desktop-bootstrap:{window}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Validates a presented bootstrap token against the previous, current, and next 12-hour windows.
pub fn is_valid_desktop_bootstrap_token(secret: &str, presented: &str, now_ms: u64) -> bool {
    let current = now_ms / DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;
    let windows = [
        current.saturating_sub(1),
        current,
        current.saturating_add(1),
    ];
    windows
        .into_iter()
        .any(|w| derive_desktop_bootstrap_token_for_window(secret, w) == presented)
}

pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reads the desktop secret the way `p0d` does (`apps/p0d/internal/auth/desktop.go`): trimmed text
/// that decodes as base64url to at least 32 bytes. The HMAC key is that trimmed text. A file that
/// is valid but readable by others has its mode repaired to `0600` instead of being rotated, as
/// Electron does, because a running `p0d` only knows the secret it read at its own start.
pub fn read_desktop_secret_file(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let secret = raw.trim();
    let decoded = URL_SAFE_NO_PAD
        .decode(secret)
        .or_else(|_| URL_SAFE.decode(secret))
        .ok()?;
    if decoded.len() < DESKTOP_BOOTSTRAP_SECRET_MIN_BYTES {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if meta.permissions().mode() & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).ok()?;
        }
    }
    Some(secret.to_owned())
}

/// The format Electron writes and keeps (`readOrCreateDesktopSecretFile`): 64 lowercase hex chars.
pub fn is_electron_desktop_secret(secret: &str) -> bool {
    secret.len() == 64
        && secret
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Returns the secret a `p0d` started now should use, creating it when missing.
///
/// Anything other than Electron's format is replaced, because Electron rotates such a file on its
/// next launch and would lock this client out of a `p0d` it started.
pub fn ensure_desktop_secret_file(path: &Path) -> Result<String, ClientError> {
    if let Some(existing) = read_desktop_secret_file(path)
        && is_electron_desktop_secret(&existing)
    {
        return Ok(existing);
    }
    generate_desktop_secret_file(path)
}

/// Writes a fresh secret exactly as Electron does: 32 random bytes as hex plus a newline, mode
/// `0600`, in a `0700` directory, through a temporary file and rename.
pub fn generate_desktop_secret_file(path: &Path) -> Result<String, ClientError> {
    let mut bytes = [0u8; DESKTOP_BOOTSTRAP_SECRET_MIN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    let secret = hex::encode(bytes);

    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let tmp_path = tmp_sibling(path);
    let _ = std::fs::remove_file(&tmp_path);
    write_secret_file(&tmp_path, format!("{secret}\n").as_bytes())?;
    std::fs::rename(&tmp_path, path)?;
    Ok(secret)
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<(), ClientError> {
    use std::os::unix::fs::DirBuilderExt as _;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    Ok(())
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> Result<(), ClientError> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}

fn tmp_sibling(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_else(|| "desktop-bootstrap-secret".into());
    name.push(".tmp");
    path.with_file_name(name)
}

#[cfg(unix)]
fn write_secret_file(path: &Path, contents: &[u8]) -> Result<(), ClientError> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn write_secret_file(path: &Path, contents: &[u8]) -> Result<(), ClientError> {
    std::fs::write(path, contents)?;
    Ok(())
}

/// Exchanges a derived HMAC-SHA256 desktop bootstrap token at `POST /oauth/token`.
///
/// Sends `application/x-www-form-urlencoded` without `scope`, `DPoP`, or proxy forwarding headers.
pub async fn exchange_desktop_bootstrap(
    http: &reqwest::Client,
    http_base_url: &str,
    secret: &str,
    client_label: &str,
) -> Result<AccessTokenResponse, ClientError> {
    let url = format!("{}/oauth/token", http_base_url.trim_end_matches('/'));
    let derived_token = derive_desktop_bootstrap_token(secret, now_epoch_ms());
    let form =
        TokenExchangeRequest::desktop_bootstrap(derived_token, client_label, current_client_os());

    let response = http.post(&url).form(&form).send().await?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(60);
        return Err(ClientError::RateLimited {
            retry_after: Duration::from_secs(retry_after),
        });
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(ClientError::Auth(format!(
            "POST /oauth/token failed with {status}: {}",
            body.chars().take(300).collect::<String>()
        )));
    }
    let parsed: AccessTokenResponse = response.json().await?;
    Ok(parsed)
}

/// Obtains a fresh bearer credential for the given [`AuthMode`].
pub async fn issue_bearer_token(
    http: &reqwest::Client,
    http_base_url: &str,
    mode: &AuthMode,
) -> Result<String, ClientError> {
    match mode {
        AuthMode::LocalBootstrap {
            secret,
            client_label,
        } => {
            let token =
                exchange_desktop_bootstrap(http, http_base_url, secret, client_label).await?;
            Ok(token.access_token)
        }
        AuthMode::BearerToken(token) => Ok(token.clone()),
        AuthMode::Dpop { .. } => Err(ClientError::Unimplemented(
            "Remote DPoP pairing is not implemented yet; see native/apps/p0-gpui/PARITY.md",
        )),
    }
}
