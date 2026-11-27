//! Durable read streams: `subscribeShell`, `subscribeThread` and `subscribeServerConfig` are
//! re-subscribed after every reconnect from the caller's cursor. Mutations are never replayed.

use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::ClientError;
use crate::ws::{ConnectionState, RpcClient};

const RETRY_BASE: Duration = Duration::from_millis(250);
const RETRY_MAX: Duration = Duration::from_secs(10);

/// Waits until the transport is connected. Returns `false` once the client has shut down.
pub async fn wait_until_connected(client: &RpcClient) -> bool {
    let mut rx = client.subscribe_connection_state();
    loop {
        if matches!(*rx.borrow_and_update(), ConnectionState::Connected) {
            return true;
        }
        if matches!(*rx.borrow(), ConnectionState::Disconnected) || rx.changed().await.is_err() {
            return false;
        }
    }
}

/// Runs `tag` for as long as the client lives. `payload` is called before every (re)subscribe so
/// it can carry the latest cursor; `on_item` sees every value; `on_error` sees stream failures
/// (transport drops included) before the next attempt.
pub async fn run_durable_stream<P, T>(
    client: RpcClient,
    tag: &'static str,
    mut payload: impl FnMut() -> P,
    mut on_item: impl FnMut(T),
    mut on_error: impl FnMut(&ClientError),
) where
    P: Serialize,
    T: DeserializeOwned,
{
    let mut failures: u32 = 0;
    loop {
        if !wait_until_connected(&client).await {
            return;
        }
        match client.subscribe::<P, T>(tag, &payload()).await {
            Ok(mut sub) => {
                while let Some(item) = sub.recv().await {
                    match item {
                        Ok(value) => {
                            failures = 0;
                            on_item(value);
                        }
                        Err(err) => {
                            on_error(&err);
                            break;
                        }
                    }
                }
            }
            Err(err) => on_error(&err),
        }
        failures = failures.saturating_add(1);
        let delay = RETRY_BASE
            .saturating_mul(1u32 << failures.min(6))
            .min(RETRY_MAX);
        tokio::time::sleep(delay).await;
    }
}
