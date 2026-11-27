//! Client authentication modes and local desktop bootstrap token exchange.
//!
//! Mirrors `packages/shared/src/desktopBootstrapToken.ts` and `apps/p0d/internal/auth`:
//! the client shares a 32-byte base64url secret file (mode `0600`) with `p0d` via
//! `--desktop-bootstrap-secret-file`, and sends an HMAC-SHA256 derived token (never
//! the raw secret) to `POST /oauth/token`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
    let windows = [current.saturating_sub(1), current, current.saturating_add(1)];
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

/// Loads an existing valid bootstrap secret file (0600 on Unix, base64url decoding to >= 32 bytes),
/// or generates a fresh 32-byte random base64url secret (without trailing newline) and writes it
/// atomically with mode `0600`.
pub fn ensure_bootstrap_secret_file(path: &Path) -> Result<String, ClientError> {
    if let Some(existing) = read_valid_bootstrap_secret_file(path) {
        return Ok(existing);
    }
    generate_bootstrap_secret_file(path)
}

/// Reads and validates an existing bootstrap secret file. Returns `None` if missing, malformed,
/// too short, or (on Unix) readable by group/other.
pub fn read_valid_bootstrap_secret_file(path: &Path) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let meta = std::fs::metadata(path).ok()?;
        if !meta.is_file() || (meta.permissions().mode() & 0o077) != 0 {
            return None;
        }
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let secret = raw.trim_end_matches(['\r', '\n']);
    if secret.is_empty() || secret.len() != raw.len() {
        // Ensure the stored file itself has no trailing newline (key must match exact file bytes).
        return None;
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(secret)
        .or_else(|_| URL_SAFE.decode(secret))
        .ok()?;
    if decoded.len() < DESKTOP_BOOTSTRAP_SECRET_MIN_BYTES {
        return None;
    }
    Some(secret.to_owned())
}

/// Generates a random 32-byte secret, encodes it as unpadded base64url (no trailing newline),
/// and writes it atomically to `path` with mode `0600` (on Unix).
pub fn generate_bootstrap_secret_file(path: &Path) -> Result<String, ClientError> {
    let mut bytes = [0u8; DESKTOP_BOOTSTRAP_SECRET_MIN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    let secret = URL_SAFE_NO_PAD.encode(bytes);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let tmp_path = tmp_sibling(path);
    write_secret_file(&tmp_path, secret.as_bytes())?;
    std::fs::rename(&tmp_path, path)?;
    Ok(secret)
}

fn tmp_sibling(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_else(|| "bootstrap-secret".into());
    name.push(".tmp");
    path.with_file_name(name)
}

#[cfg(unix)]
fn write_secret_file(path: &Path, contents: &[u8]) -> Result<(), ClientError> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
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
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(ClientError::Auth(format!(
            "POST /oauth/token failed with {status}: {body}"
        )));
    }
    let parsed: AccessTokenResponse = response.json().await?;
    Ok(parsed)
}

/// Resolves a bearer credential for the given [`AuthMode`].
pub async fn resolve_bearer_token(
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
