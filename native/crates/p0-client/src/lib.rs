pub mod auth;
pub mod error;
pub mod p0d;
pub mod stores;
pub mod sync;
pub mod user_input;
pub mod ws;

pub use auth::{
    AuthMode, DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS, derive_desktop_bootstrap_token,
    ensure_desktop_secret_file, exchange_desktop_bootstrap, generate_desktop_secret_file,
    is_electron_desktop_secret, is_valid_desktop_bootstrap_token, read_desktop_secret_file,
};
pub use error::ClientError;
pub use p0d::{P0dLaunchConfig, P0dProcess, ReadyFilePayload};
pub use stores::{ShellState, ShellStore, ThreadState, ThreadStore};
pub use sync::{run_durable_stream, wait_until_connected};
pub use ws::{ClientConfig, ConnectionState, RpcClient, Subscription, revoked_session_retry_delay};
