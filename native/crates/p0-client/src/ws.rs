//! WebSocket `effect/rpc` transport with 5s Ping / 15s liveness timeout, an `Ack` per `Chunk`,
//! `U+001E` frame-part reassembly, and jittered exponential backoff reconnect.
//!
//! The read loop never awaits a consumer: stream values go to unbounded per-request channels and
//! are acked once queued. A slow UI therefore cannot stall pings or other requests (or deadlock a
//! caller that awaits a unary reply while its stream channel is full).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt as _, StreamExt as _};
use http::HeaderValue;
use p0_protocol::{
    DispatchCommandResult, FramePartAssembler, LaunchThreadInput, LaunchThreadResult,
    ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION, OrchestrationCommand,
    RPC_ORCHESTRATION_DISPATCH_COMMAND, RPC_ORCHESTRATION_FORCE_STOP_THREAD,
    RPC_ORCHESTRATION_LAUNCH_THREAD, RPC_ORCHESTRATION_SUBSCRIBE_SHELL,
    RPC_ORCHESTRATION_SUBSCRIBE_THREAD, RPC_SECRETS_ANSWER_REQUEST, RPC_SERVER_GET_CONFIG,
    RPC_SERVER_GET_SETTINGS, RPC_SERVER_PROBE, RPC_SERVER_REFRESH_PROVIDERS,
    RPC_SERVER_UPDATE_SETTINGS, RequestId, RpcClientFrame, RpcExit, RpcServerFrame,
    SOCKET_FRAME_PARTS_QUERY_PARAM, SecretRequestAnswerInput, ServerConfig, ServerProbeResult,
    ShellStreamItem, SubscribeShellInput, SubscribeThreadInput, ThreadStreamItem,
    decode_server_frame, encode_client_frame,
};
use rand::RngExt as _;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tracing::{debug, info, warn};
use url::Url;

use crate::auth::{AuthMode, current_client_os, issue_bearer_token};
use crate::error::ClientError;

const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(5);
const DEFAULT_LIVENESS_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);
const RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
const HEALTHY_RESET_AFTER: Duration = Duration::from_secs(30);

/// How long to wait before signing in again after the `n`th consecutive revocation of our
/// desktop session, or `None` to stop until the user asks. Another desktop GUI on the same `p0d`
/// revokes us whenever it signs in; without this, two GUIs would sign each other out forever.
pub fn revoked_session_retry_delay(consecutive_revocations: u32) -> Option<Duration> {
    match consecutive_revocations {
        0 | 1 => Some(Duration::ZERO),
        2 => Some(Duration::from_secs(5)),
        3 => Some(Duration::from_secs(30)),
        _ => None,
    }
}

/// Transport connection status exposed to the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting {
        attempt: u32,
        next_retry_ms: u64,
        last_error: String,
    },
    /// Another desktop client signed in to this `p0d`, which revoked our session. `retry_in_ms`
    /// is `None` once we stopped signing back in automatically; `reconnect_now` resumes.
    SignedOutElsewhere {
        retry_in_ms: Option<u64>,
    },
    AuthFailed(String),
}

#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub http_base_url: String,
    pub auth: AuthMode,
    pub ping_interval: Duration,
    pub liveness_timeout: Duration,
    pub request_timeout: Duration,
    /// See [`revoked_session_retry_delay`]; replaceable so tests need not wait.
    pub revoked_retry_delay: fn(u32) -> Option<Duration>,
}

impl ClientConfig {
    pub fn new(http_base_url: impl Into<String>, auth: AuthMode) -> Self {
        Self {
            http_base_url: http_base_url.into(),
            auth,
            ping_interval: DEFAULT_PING_INTERVAL,
            liveness_timeout: DEFAULT_LIVENESS_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            revoked_retry_delay: revoked_session_retry_delay,
        }
    }
}

enum ActorCmd {
    Unary {
        id: u64,
        tag: String,
        payload: Value,
        reply: oneshot::Sender<Result<Value, ClientError>>,
    },
    Stream {
        id: u64,
        tag: String,
        payload: Value,
        sink: mpsc::UnboundedSender<Result<Value, ClientError>>,
    },
    Interrupt {
        id: u64,
    },
    ReconnectNow,
    Shutdown,
}

enum PendingCall {
    Unary(oneshot::Sender<Result<Value, ClientError>>),
    Stream(mpsc::UnboundedSender<Result<Value, ClientError>>),
}

/// Handle to a live streaming RPC subscription. Dropping it sends `Interrupt` to the server.
pub struct Subscription<T> {
    id: u64,
    rx: mpsc::UnboundedReceiver<Result<Value, ClientError>>,
    cmd_tx: mpsc::UnboundedSender<ActorCmd>,
    _marker: std::marker::PhantomData<T>,
}

impl<T: DeserializeOwned> Subscription<T> {
    pub async fn recv(&mut self) -> Option<Result<T, ClientError>> {
        let raw = self.rx.recv().await?;
        Some(raw.and_then(|val| serde_json::from_value(val).map_err(ClientError::from)))
    }
}

impl<T> Drop for Subscription<T> {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(ActorCmd::Interrupt { id: self.id });
    }
}

/// Cloneable async RPC client backed by a supervised WebSocket connection.
#[derive(Clone)]
pub struct RpcClient {
    cmd_tx: mpsc::UnboundedSender<ActorCmd>,
    state_rx: watch::Receiver<ConnectionState>,
    next_id: Arc<AtomicU64>,
    request_timeout: Duration,
}

impl RpcClient {
    /// Spawns the connection supervisor task and returns immediately.
    pub fn connect(config: ClientConfig) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (state_tx, state_rx) = watch::channel(ConnectionState::Connecting);
        let request_timeout = config.request_timeout;

        tokio::spawn(run_supervisor(config, cmd_rx, state_tx));

        Self {
            cmd_tx,
            state_rx,
            next_id: Arc::new(AtomicU64::new(1)),
            request_timeout,
        }
    }

    pub fn connection_state(&self) -> ConnectionState {
        self.state_rx.borrow().clone()
    }

    pub fn subscribe_connection_state(&self) -> watch::Receiver<ConnectionState> {
        self.state_rx.clone()
    }

    /// Waits until the transport reaches `Connected` or fails permanently (`AuthFailed`). A client
    /// signed out by another desktop app keeps waiting: `reconnect_now` resumes it.
    pub async fn wait_connected(&self, timeout: Duration) -> Result<(), ClientError> {
        let mut rx = self.state_rx.clone();
        let wait = async {
            loop {
                let current = rx.borrow().clone();
                match current {
                    ConnectionState::Connected => return Ok(()),
                    ConnectionState::AuthFailed(msg) => return Err(ClientError::Auth(msg)),
                    _ => {
                        if rx.changed().await.is_err() {
                            return Err(ClientError::Closed);
                        }
                    }
                }
            }
        };
        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| ClientError::Timeout)?
    }

    pub async fn reconnect_now(&self) {
        let _ = self.cmd_tx.send(ActorCmd::ReconnectNow);
    }

    pub async fn shutdown(&self) {
        let _ = self.cmd_tx.send(ActorCmd::Shutdown);
    }

    /// Performs a unary RPC call. Never auto-replayed on reconnect.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        tag: &str,
        payload: &P,
    ) -> Result<R, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let value = serde_json::to_value(payload)?;
        let (reply_tx, reply_rx) = oneshot::channel();

        self.cmd_tx
            .send(ActorCmd::Unary {
                id,
                tag: tag.to_owned(),
                payload: value,
                reply: reply_tx,
            })
            .map_err(|_| ClientError::Closed)?;

        let result = tokio::time::timeout(self.request_timeout, reply_rx)
            .await
            .map_err(|_| {
                let _ = self.cmd_tx.send(ActorCmd::Interrupt { id });
                ClientError::Timeout
            })?
            .map_err(|_| ClientError::Closed)??;

        Ok(serde_json::from_value(result)?)
    }

    /// Opens a streaming RPC subscription (`stream: true`).
    pub async fn subscribe<P: Serialize, T: DeserializeOwned>(
        &self,
        tag: &str,
        payload: &P,
    ) -> Result<Subscription<T>, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let value = serde_json::to_value(payload)?;
        let (sink_tx, sink_rx) = mpsc::unbounded_channel();

        self.cmd_tx
            .send(ActorCmd::Stream {
                id,
                tag: tag.to_owned(),
                payload: value,
                sink: sink_tx,
            })
            .map_err(|_| ClientError::Closed)?;

        Ok(Subscription {
            id,
            rx: sink_rx,
            cmd_tx: self.cmd_tx.clone(),
            _marker: std::marker::PhantomData,
        })
    }

    pub async fn probe(&self) -> Result<ServerProbeResult, ClientError> {
        self.request(RPC_SERVER_PROBE, &json!({})).await
    }

    pub async fn get_config(&self) -> Result<ServerConfig, ClientError> {
        self.request(RPC_SERVER_GET_CONFIG, &json!({})).await
    }

    pub async fn subscribe_shell(
        &self,
        input: SubscribeShellInput,
    ) -> Result<Subscription<ShellStreamItem>, ClientError> {
        self.subscribe(RPC_ORCHESTRATION_SUBSCRIBE_SHELL, &input)
            .await
    }

    pub async fn subscribe_thread(
        &self,
        input: SubscribeThreadInput,
    ) -> Result<Subscription<ThreadStreamItem>, ClientError> {
        self.subscribe(RPC_ORCHESTRATION_SUBSCRIBE_THREAD, &input)
            .await
    }

    pub async fn dispatch_command(
        &self,
        command: &OrchestrationCommand,
    ) -> Result<DispatchCommandResult, ClientError> {
        self.request(RPC_ORCHESTRATION_DISPATCH_COMMAND, command)
            .await
    }

    pub async fn launch_thread(
        &self,
        input: &LaunchThreadInput,
    ) -> Result<LaunchThreadResult, ClientError> {
        self.request(RPC_ORCHESTRATION_LAUNCH_THREAD, input).await
    }

    pub async fn force_stop_thread(&self, thread_id: &str) -> Result<Value, ClientError> {
        self.request(
            RPC_ORCHESTRATION_FORCE_STOP_THREAD,
            &json!({ "threadId": thread_id }),
        )
        .await
    }

    pub async fn answer_secret_request(
        &self,
        input: &SecretRequestAnswerInput,
    ) -> Result<Value, ClientError> {
        self.request(RPC_SECRETS_ANSWER_REQUEST, input).await
    }

    pub async fn get_settings(&self) -> Result<Value, ClientError> {
        self.request(RPC_SERVER_GET_SETTINGS, &json!({})).await
    }

    pub async fn refresh_providers(&self) -> Result<Value, ClientError> {
        self.request(RPC_SERVER_REFRESH_PROVIDERS, &json!({})).await
    }

    pub async fn update_settings(&self, patch: &Value) -> Result<Value, ClientError> {
        self.request(RPC_SERVER_UPDATE_SETTINGS, &json!({ "patch": patch }))
            .await
    }
}

pub fn build_ws_url(http_base_url: &str) -> Result<Url, ClientError> {
    let mut url = Url::parse(http_base_url)
        .map_err(|e| ClientError::Transport(format!("invalid url: {e}")))?;
    match url.scheme() {
        "http" => {
            url.set_scheme("ws").ok();
        }
        "https" => {
            url.set_scheme("wss").ok();
        }
        "ws" | "wss" => {}
        other => {
            return Err(ClientError::Transport(format!(
                "unsupported url scheme: {other}"
            )));
        }
    }
    url.set_path("/ws");
    url.query_pairs_mut()
        .clear()
        .append_pair(
            ORCHESTRATION_PROTOCOL_QUERY_PARAM,
            &ORCHESTRATION_PROTOCOL_VERSION.to_string(),
        )
        .append_pair(SOCKET_FRAME_PARTS_QUERY_PARAM, "1")
        .append_pair("clientSurface", "desktop")
        .append_pair("clientOs", current_client_os());
    Ok(url)
}

async fn run_supervisor(
    config: ClientConfig,
    mut cmd_rx: mpsc::UnboundedReceiver<ActorCmd>,
    state_tx: watch::Sender<ConnectionState>,
) {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let ws_url = match build_ws_url(&config.http_base_url) {
        Ok(u) => u,
        Err(err) => {
            let _ = state_tx.send(ConnectionState::AuthFailed(err.to_string()));
            drain_until_shutdown(&mut cmd_rx).await;
            return;
        }
    };

    let mut attempt: u32 = 0;
    let mut revocations: u32 = 0;
    // Reused across reconnects: every exchange signs other desktop clients out.
    let mut token: Option<String> = None;

    loop {
        let _ = state_tx.send(if attempt == 0 {
            ConnectionState::Connecting
        } else {
            ConnectionState::Reconnecting {
                attempt,
                next_retry_ms: 0,
                last_error: String::new(),
            }
        });

        let fresh_token = token.is_none();
        let bearer = match &token {
            Some(t) => t.clone(),
            None => match issue_bearer_token(&http, &config.http_base_url, &config.auth).await {
                Ok(t) => {
                    token = Some(t.clone());
                    t
                }
                Err(ClientError::Unimplemented(msg)) => {
                    let _ = state_tx.send(ConnectionState::AuthFailed(msg.to_owned()));
                    drain_until_shutdown(&mut cmd_rx).await;
                    return;
                }
                Err(err) => {
                    attempt = attempt.saturating_add(1);
                    let delay = match &err {
                        ClientError::RateLimited { retry_after } => *retry_after,
                        _ => backoff_delay(attempt),
                    };
                    warn!(error = %err, attempt, delay_ms = delay.as_millis() as u64, "sign-in failed; retrying");
                    let _ = state_tx.send(ConnectionState::Reconnecting {
                        attempt,
                        next_retry_ms: delay.as_millis() as u64,
                        last_error: err.to_string(),
                    });
                    if wait_retry_or_shutdown(&mut cmd_rx, delay).await == Wake::Shutdown {
                        let _ = state_tx.send(ConnectionState::Disconnected);
                        return;
                    }
                    continue;
                }
            },
        };

        let mut req = match ws_url.as_str().into_client_request() {
            Ok(r) => r,
            Err(err) => {
                let _ = state_tx.send(ConnectionState::AuthFailed(err.to_string()));
                drain_until_shutdown(&mut cmd_rx).await;
                return;
            }
        };
        if let Ok(header) = HeaderValue::from_str(&format!("Bearer {bearer}")) {
            req.headers_mut()
                .insert(http::header::AUTHORIZATION, header);
        }

        let reason = match tokio_tungstenite::connect_async(req).await {
            Ok((ws_stream, _)) => {
                let connected_at = Instant::now();
                info!(url = %ws_url, "connected to p0d WebSocket");
                let _ = state_tx.send(ConnectionState::Connected);

                let outcome = run_session(ws_stream, &config, &mut cmd_rx).await;

                if connected_at.elapsed() >= HEALTHY_RESET_AFTER {
                    attempt = 0;
                    revocations = 0;
                }
                match outcome {
                    SessionOutcome::Shutdown => {
                        let _ = state_tx.send(ConnectionState::Disconnected);
                        return;
                    }
                    SessionOutcome::ReconnectNow => {
                        attempt = 0;
                        continue;
                    }
                    // Reconnect at once with the same token; a revoked one comes back as 401.
                    SessionOutcome::Disconnected(reason) if attempt == 0 => {
                        warn!(reason = %reason, "WebSocket disconnected; reconnecting");
                        attempt = 1;
                        continue;
                    }
                    SessionOutcome::Disconnected(reason) => reason,
                }
            }
            Err(tokio_tungstenite::tungstenite::Error::Http(resp))
                if resp.status() == http::StatusCode::UNAUTHORIZED =>
            {
                token = None;
                if matches!(config.auth, AuthMode::BearerToken(_)) {
                    let _ = state_tx.send(ConnectionState::AuthFailed(
                        "the server rejected the bearer token".to_owned(),
                    ));
                    drain_until_shutdown(&mut cmd_rx).await;
                    return;
                }
                if fresh_token {
                    "the server rejected a token it just issued".to_owned()
                } else {
                    revocations = revocations.saturating_add(1);
                    let delay = (config.revoked_retry_delay)(revocations);
                    warn!(
                        revocations,
                        ?delay,
                        "desktop session revoked by another sign-in"
                    );
                    let _ = state_tx.send(ConnectionState::SignedOutElsewhere {
                        retry_in_ms: delay.map(|d| d.as_millis() as u64),
                    });
                    let wake = match delay {
                        Some(delay) => wait_retry_or_shutdown(&mut cmd_rx, delay).await,
                        None => wait_retry_or_shutdown(&mut cmd_rx, Duration::MAX).await,
                    };
                    match wake {
                        Wake::Shutdown => {
                            let _ = state_tx.send(ConnectionState::Disconnected);
                            return;
                        }
                        Wake::UserRequested => {
                            revocations = 0;
                            attempt = 0;
                        }
                        Wake::Elapsed => {}
                    }
                    continue;
                }
            }
            Err(err) => format!("connect failed: {err}"),
        };

        attempt = attempt.saturating_add(1);
        let delay = backoff_delay(attempt);
        warn!(reason = %reason, attempt, delay_ms = delay.as_millis() as u64, "WebSocket unavailable");
        let _ = state_tx.send(ConnectionState::Reconnecting {
            attempt,
            next_retry_ms: delay.as_millis() as u64,
            last_error: reason,
        });
        match wait_retry_or_shutdown(&mut cmd_rx, delay).await {
            Wake::Shutdown => {
                let _ = state_tx.send(ConnectionState::Disconnected);
                return;
            }
            Wake::UserRequested => attempt = 0,
            Wake::Elapsed => {}
        }
    }
}

enum SessionOutcome {
    Shutdown,
    ReconnectNow,
    Disconnected(String),
}

async fn run_session<S>(
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    config: &ClientConfig,
    cmd_rx: &mut mpsc::UnboundedReceiver<ActorCmd>,
) -> SessionOutcome
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let mut pending: HashMap<u64, PendingCall> = HashMap::new();
    let mut assembler = FramePartAssembler::new();

    let mut ping_ticker = tokio::time::interval(config.ping_interval);
    ping_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Skip immediate tick at t=0.
    ping_ticker.tick().await;

    let mut liveness_ticker = tokio::time::interval(Duration::from_secs(1));
    liveness_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_rx = Instant::now();

    let outcome = loop {
        tokio::select! {
            _ = ping_ticker.tick() => {
                if let Ok(text) = encode_client_frame(&RpcClientFrame::Ping)
                    && let Err(err) = ws_tx.send(Message::Text(text.into())).await
                {
                    break SessionOutcome::Disconnected(format!("ping send failed: {err}"));
                }
            }
            _ = liveness_ticker.tick() => {
                if last_rx.elapsed() >= config.liveness_timeout {
                    break SessionOutcome::Disconnected(format!(
                        "liveness timeout: no frame received for {}s",
                        config.liveness_timeout.as_secs()
                    ));
                }
            }
            maybe_cmd = cmd_rx.recv() => {
                let Some(cmd) = maybe_cmd else {
                    break SessionOutcome::Shutdown;
                };
                match cmd {
                    ActorCmd::Shutdown => {
                        let _ = ws_tx.close().await;
                        break SessionOutcome::Shutdown;
                    }
                    ActorCmd::ReconnectNow => {
                        let _ = ws_tx.close().await;
                        break SessionOutcome::ReconnectNow;
                    }
                    ActorCmd::Unary { id, tag, payload, reply } => {
                        let frame = RpcClientFrame::Request {
                            id: RequestId::Number(id),
                            tag,
                            payload,
                            headers: Vec::new(),
                            discard: None,
                        };
                        match encode_client_frame(&frame) {
                            Ok(text) => {
                                pending.insert(id, PendingCall::Unary(reply));
                                if let Err(err) = ws_tx.send(Message::Text(text.into())).await {
                                    break SessionOutcome::Disconnected(format!("write failed: {err}"));
                                }
                            }
                            Err(err) => {
                                let _ = reply.send(Err(ClientError::Protocol(err.to_string())));
                            }
                        }
                    }
                    ActorCmd::Stream { id, tag, payload, sink } => {
                        let frame = RpcClientFrame::Request {
                            id: RequestId::Number(id),
                            tag,
                            payload,
                            headers: Vec::new(),
                            discard: None,
                        };
                        match encode_client_frame(&frame) {
                            Ok(text) => {
                                pending.insert(id, PendingCall::Stream(sink));
                                if let Err(err) = ws_tx.send(Message::Text(text.into())).await {
                                    break SessionOutcome::Disconnected(format!("write failed: {err}"));
                                }
                            }
                            Err(err) => {
                                let _ = sink.send(Err(ClientError::Protocol(err.to_string())));
                            }
                        }
                    }
                    ActorCmd::Interrupt { id } => {
                        if pending.remove(&id).is_none() {
                            continue;
                        }
                        let frame = RpcClientFrame::Interrupt {
                            request_id: RequestId::Number(id),
                            interruptors: Vec::new(),
                        };
                        if let Ok(text) = encode_client_frame(&frame) {
                            let _ = ws_tx.send(Message::Text(text.into())).await;
                        }
                    }
                }
            }
            maybe_msg = ws_rx.next() => {
                let Some(msg_res) = maybe_msg else {
                    break SessionOutcome::Disconnected("server closed WebSocket".to_owned());
                };
                match msg_res {
                    Ok(Message::Text(text)) => {
                        // Every received frame (including partial U+001E parts) resets liveness.
                        last_rx = Instant::now();
                        let Some(complete) = assembler.push(text.as_str()) else {
                            continue;
                        };
                        let frame = match decode_server_frame(&complete) {
                            Ok(f) => f,
                            Err(err) => {
                                warn!(error = %err, "failed to decode server RPC frame");
                                continue;
                            }
                        };
                        match frame {
                            RpcServerFrame::Pong | RpcServerFrame::Unknown => {}
                            RpcServerFrame::Defect { defect } | RpcServerFrame::ClientProtocolError { defect } => {
                                break SessionOutcome::Disconnected(format!("socket defect: {defect}"));
                            }
                            RpcServerFrame::Chunk { request_id, values } => {
                                // Send Ack promptly for every Chunk so p0d / Node streams never stall.
                                let ack = RpcClientFrame::Ack {
                                    request_id: request_id.clone(),
                                };
                                if let Ok(ack_text) = encode_client_frame(&ack)
                                    && let Err(err) = ws_tx.send(Message::Text(ack_text.into())).await
                                {
                                    break SessionOutcome::Disconnected(format!("ack send failed: {err}"));
                                }
                                if let RequestId::Number(id) = request_id {
                                    let mut closed = false;
                                    if let Some(PendingCall::Stream(sink)) = pending.get(&id) {
                                        for value in values {
                                            if sink.send(Ok(value)).is_err() {
                                                closed = true;
                                                break;
                                            }
                                        }
                                    }
                                    if closed {
                                        pending.remove(&id);
                                        let intr = RpcClientFrame::Interrupt {
                                            request_id: RequestId::Number(id),
                                            interruptors: Vec::new(),
                                        };
                                        if let Ok(t) = encode_client_frame(&intr) {
                                            let _ = ws_tx.send(Message::Text(t.into())).await;
                                        }
                                    }
                                }
                            }
                            RpcServerFrame::Exit { request_id, exit } => {
                                if let RequestId::Number(id) = request_id
                                    && let Some(call) = pending.remove(&id)
                                {
                                    match (call, exit) {
                                        (PendingCall::Unary(reply), RpcExit::Success { value }) => {
                                            let _ = reply.send(Ok(value));
                                        }
                                        (PendingCall::Unary(reply), other) => {
                                            let msg = other
                                                .failure_message()
                                                .unwrap_or_else(|| "RPC failed".to_owned());
                                            let _ = reply.send(Err(ClientError::RpcFailure(msg)));
                                        }
                                        (PendingCall::Stream(_sink), RpcExit::Success { .. }) => {
                                            // Dropping sink closes the subscription cleanly.
                                        }
                                        (PendingCall::Stream(sink), other) => {
                                            let msg = other
                                                .failure_message()
                                                .unwrap_or_else(|| "Stream failed".to_owned());
                                            let _ = sink.send(Err(ClientError::RpcFailure(msg)));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        last_rx = Instant::now();
                        let _ = ws_tx.send(Message::Pong(payload)).await;
                    }
                    Ok(Message::Pong(_)) | Ok(Message::Binary(_)) | Ok(Message::Frame(_)) => {
                        last_rx = Instant::now();
                    }
                    Ok(Message::Close(frame)) => {
                        debug!(?frame, "received WebSocket close frame");
                        break SessionOutcome::Disconnected("server sent Close frame".to_owned());
                    }
                    Err(err) => {
                        break SessionOutcome::Disconnected(format!("read error: {err}"));
                    }
                }
            }
        }
    };

    // Fail every in-flight call on disconnect (never auto-replay mutations).
    for (_, call) in pending.drain() {
        match call {
            PendingCall::Unary(reply) => {
                let _ = reply.send(Err(ClientError::Transport(
                    "connection closed while request was in flight".to_owned(),
                )));
            }
            PendingCall::Stream(sink) => {
                let _ = sink.send(Err(ClientError::Transport(
                    "connection closed while stream was active".to_owned(),
                )));
            }
        }
    }

    outcome
}

fn backoff_delay(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(8);
    let base_ms = RETRY_BASE_DELAY.as_millis() as u64;
    let exp_ms = base_ms.saturating_mul(1u64 << shift);
    let capped_ms = exp_ms.min(RETRY_MAX_DELAY.as_millis() as u64);
    let jitter: u64 = rand::rng().random_range(0..=(capped_ms / 4).max(1));
    Duration::from_millis(capped_ms.saturating_add(jitter))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wake {
    Elapsed,
    UserRequested,
    Shutdown,
}

/// Sleeps for `delay` (`Duration::MAX` parks) while failing requests made in the meantime.
async fn wait_retry_or_shutdown(
    cmd_rx: &mut mpsc::UnboundedReceiver<ActorCmd>,
    delay: Duration,
) -> Wake {
    let sleep = tokio::time::sleep(delay.min(Duration::from_secs(60 * 60 * 24 * 365)));
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return Wake::Elapsed,
            maybe_cmd = cmd_rx.recv() => {
                match maybe_cmd {
                    None | Some(ActorCmd::Shutdown) => return Wake::Shutdown,
                    Some(ActorCmd::ReconnectNow) => return Wake::UserRequested,
                    Some(ActorCmd::Unary { reply, .. }) => {
                        let _ = reply.send(Err(ClientError::Transport("not connected".to_owned())));
                    }
                    Some(ActorCmd::Stream { sink, .. }) => {
                        let _ = sink.send(Err(ClientError::Transport("not connected".to_owned())));
                    }
                    Some(ActorCmd::Interrupt { .. }) => {}
                }
            }
        }
    }
}

async fn drain_until_shutdown(cmd_rx: &mut mpsc::UnboundedReceiver<ActorCmd>) {
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            ActorCmd::Shutdown => return,
            ActorCmd::Unary { reply, .. } => {
                let _ = reply.send(Err(ClientError::Auth("authentication failed".to_owned())));
            }
            ActorCmd::Stream { sink, .. } => {
                let _ = sink.send(Err(ClientError::Auth("authentication failed".to_owned())));
            }
            ActorCmd::Interrupt { .. } | ActorCmd::ReconnectNow => {}
        }
    }
}
