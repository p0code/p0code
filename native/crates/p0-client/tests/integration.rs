use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use p0_client::{
    AuthMode, ClientConfig, ClientError, ConnectionState, RpcClient, ShellStore, ThreadStore,
    derive_desktop_bootstrap_token, ensure_desktop_secret_file, is_valid_desktop_bootstrap_token,
    read_desktop_secret_file,
};
use p0_protocol::{
    ApprovalDecision, DispatchMode, ModelSelection, OrchestrationCommand, SOCKET_FRAME_PART_BYTES,
    ShellStreamItem, SubscribeShellInput, SubscribeThreadInput, ThreadStreamItem, TurnItem,
    split_socket_frame,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

struct FakeServerState {
    secret: String,
    /// The one live session token; each exchange replaces (revokes) the previous one.
    issued_token: Mutex<String>,
    exchanges: AtomicUsize,
    shell_acks: AtomicUsize,
    ws_connections: AtomicUsize,
    drop_first_ws_after_probe: bool,
    /// Simulates another desktop client signing in right after every connection.
    revoke_after_connect: AtomicBool,
    /// Chunks to flood a subscribeShell with, ignoring Acks.
    flood_shell_chunks: AtomicUsize,
}

async fn start_fake_server(
    secret: String,
    drop_first_ws_after_probe: bool,
) -> (String, Arc<FakeServerState>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(FakeServerState {
        secret,
        issued_token: Mutex::new(String::new()),
        exchanges: AtomicUsize::new(0),
        shell_acks: AtomicUsize::new(0),
        ws_connections: AtomicUsize::new(0),
        drop_first_ws_after_probe,
        revoke_after_connect: AtomicBool::new(false),
        flood_shell_chunks: AtomicUsize::new(0),
    });
    let state_clone = state.clone();

    let handle = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let st = state_clone.clone();
            tokio::spawn(async move {
                handle_conn(stream, st).await;
            });
        }
    });

    (format!("http://{addr}"), state, handle)
}

async fn handle_conn(mut stream: TcpStream, state: Arc<FakeServerState>) {
    let mut buf = vec![0u8; 8192];
    let n = match stream.peek(&mut buf).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    let first_line = head.lines().next().unwrap_or("");

    if first_line.starts_with("GET /ws?") {
        handle_ws(stream, state).await;
        return;
    }

    // Read full HTTP request (headers + Content-Length body).
    let mut req_bytes = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        let read = match stream.read(&mut tmp).await {
            Ok(0) | Err(_) => return,
            Ok(r) => r,
        };
        req_bytes.extend_from_slice(&tmp[..read]);
        if let Some(pos) = req_bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let header_str = String::from_utf8_lossy(&req_bytes[..header_end]).to_string();
    let content_length: usize = header_str
        .lines()
        .find_map(|line| {
            let (k, v) = line.split_once(':')?;
            if k.eq_ignore_ascii_case("content-length") {
                v.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    while req_bytes.len() < header_end + content_length {
        let read = match stream.read(&mut tmp).await {
            Ok(0) | Err(_) => break,
            Ok(r) => r,
        };
        req_bytes.extend_from_slice(&tmp[..read]);
    }
    let body = String::from_utf8_lossy(&req_bytes[header_end..]).to_string();

    if first_line.starts_with("GET /healthz") {
        let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nok\n";
        let _ = stream.write_all(resp.as_bytes()).await;
        return;
    }

    if first_line.starts_with("POST /oauth/token") {
        // Verify no forbidden proxy/DPoP headers were sent.
        for line in header_str.lines().skip(1) {
            if let Some((k, _)) = line.split_once(':') {
                let lower = k.trim().to_ascii_lowercase();
                assert!(
                    lower != "dpop"
                        && lower != "x-forwarded-for"
                        && lower != "forwarded"
                        && lower != "x-real-ip",
                    "unexpected header on local /oauth/token: {k}"
                );
            }
        }
        let params: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(
            params.get("grant_type").map(String::as_str),
            Some("urn:ietf:params:oauth:grant-type:token-exchange")
        );
        assert_eq!(
            params.get("subject_token_type").map(String::as_str),
            Some("urn:t3:params:oauth:token-type:environment-bootstrap")
        );
        assert_eq!(
            params.get("requested_token_type").map(String::as_str),
            Some("urn:ietf:params:oauth:token-type:access_token")
        );
        assert!(
            !params.contains_key("scope"),
            "local bootstrap must not send scope"
        );

        let subject_token = params.get("subject_token").cloned().unwrap_or_default();
        // Must NEVER be the raw secret!
        assert_ne!(
            subject_token, state.secret,
            "client sent raw secret instead of HMAC token!"
        );

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        if is_valid_desktop_bootstrap_token(&state.secret, &subject_token, now_ms) {
            let n = state.exchanges.fetch_add(1, Ordering::SeqCst) + 1;
            let token = format!("v1.session.token.{n}");
            *state.issued_token.lock().unwrap() = token.clone();
            let payload = json!({
                "access_token": token,
                "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "token_type": "Bearer",
                "expires_in": 2592000,
                "scope": "orchestration:read orchestration:operate"
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                payload.len(),
                payload
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        } else {
            let payload = json!({"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential"}).to_string();
            let resp = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                payload.len(),
                payload
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        }
        return;
    }

    let _ = stream
        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
        .await;
}

#[allow(clippy::result_large_err)]
async fn handle_ws(stream: TcpStream, state: Arc<FakeServerState>) {
    let expected_auth = format!("Bearer {}", state.issued_token.lock().unwrap());
    let mut query_ok = false;

    let ws = match tokio_tungstenite::accept_hdr_async(
        stream,
        |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
         resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
            let uri = req.uri().to_string();
            query_ok = uri.contains("orchestrationProtocol=2")
                && uri.contains("frameParts=1")
                && uri.contains("clientSurface=desktop");
            let auth_ok = req
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                == Some(expected_auth.as_str());
            if !auth_ok {
                let mut reject =
                    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some(
                        "revoked".to_owned(),
                    ));
                *reject.status_mut() = http::StatusCode::UNAUTHORIZED;
                return Err(reject);
            }
            Ok(resp)
        },
    )
    .await
    {
        Ok(ws) => ws,
        Err(_) => return,
    };

    assert!(query_ok, "WS upgrade missing required query params");

    let conn_num = state.ws_connections.fetch_add(1, Ordering::SeqCst);
    let (mut tx, mut rx) = ws.split();
    if state.revoke_after_connect.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
        state.issued_token.lock().unwrap().clear();
        let _ = tx.close().await;
        return;
    }
    let mut pending_shell_req: Option<Value> = None;

    while let Some(Ok(msg)) = rx.next().await {
        let Message::Text(text) = msg else { continue };
        let val: Value = match serde_json::from_str(text.as_str()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match val.get("_tag").and_then(Value::as_str) {
            Some("Ping") => {
                let _ = tx.send(Message::Text(r#"{"_tag":"Pong"}"#.into())).await;
            }
            Some("Ack") => {
                if pending_shell_req.as_ref() == val.get("requestId") {
                    let count = state.shell_acks.fetch_add(1, Ordering::SeqCst) + 1;
                    if count == 1 {
                        // Send a delta only AFTER the first Ack arrived (proves Ack backpressure).
                        let delta = json!({
                            "_tag": "Chunk",
                            "requestId": val["requestId"],
                            "values": [{
                                "kind": "thread.updated",
                                "sequence": 43,
                                "location": "active",
                                "thread": {
                                    "id": "thread-1",
                                    "projectId": "proj-1",
                                    "title": "Updated Title",
                                    "providerInstanceId": "replay",
                                    "modelSelection": {"instanceId": "replay", "model": "replay-default"},
                                    "runtimeMode": "full-access",
                                    "interactionMode": "default",
                                    "status": "running",
                                    "itemCount": 3,
                                    "visibleItemCount": 3,
                                    "createdAt": "2026-11-27T12:00:00.000Z",
                                    "updatedAt": "2026-11-27T12:01:00.000Z"
                                }
                            }]
                        });
                        let _ = tx.send(Message::Text(delta.to_string().into())).await;
                    }
                }
            }
            Some("Request") => {
                let id = val["id"].clone();
                let tag = val.get("tag").and_then(Value::as_str).unwrap_or("");
                match tag {
                    "server.probe" => {
                        let resp = json!({
                            "_tag": "Exit",
                            "requestId": id,
                            "exit": {"_tag": "Success", "value": {"serverTime": "2026-11-27T12:00:00.000Z"}}
                        });
                        let _ = tx.send(Message::Text(resp.to_string().into())).await;
                        if state.drop_first_ws_after_probe && conn_num == 0 {
                            let _ = tx.close().await;
                            return;
                        }
                    }
                    "server.getConfig" => {
                        // Make this response > 48 KiB to test U+001E frame-part splitting & reassembly!
                        let padding = "x".repeat(SOCKET_FRAME_PART_BYTES + 1024);
                        let resp = json!({
                            "_tag": "Exit",
                            "requestId": id,
                            "exit": {
                                "_tag": "Success",
                                "value": {
                                    "environment": {
                                        "environmentId": "env-fake-1",
                                        "label": "Fake Local",
                                        "platform": {"os": "linux", "arch": "x64"},
                                        "serverVersion": "0.1.0",
                                        "orchestrationProtocolVersion": 2,
                                        "capabilities": {}
                                    },
                                    "auth": {
                                        "policy": "desktop-managed-local",
                                        "bootstrapMethods": ["desktop-bootstrap"],
                                        "sessionMethods": ["bearer-access-token"],
                                        "sessionCookieName": "t3_session"
                                    },
                                    "cwd": "/tmp",
                                    "providers": [{
                                        "instanceId": "replay",
                                        "driver": "acp",
                                        "displayName": "Replay (dev)",
                                        "enabled": true,
                                        "installed": true,
                                        "status": "ready",
                                        "models": [{
                                            "slug": "replay-default",
                                            "name": "Replay Default",
                                            "isCustom": false
                                        }]
                                    }],
                                    "settings": {"_pad": padding}
                                }
                            }
                        });
                        for part in split_socket_frame(&resp.to_string(), SOCKET_FRAME_PART_BYTES) {
                            let _ = tx.send(Message::Text(part.into())).await;
                        }
                    }
                    "orchestration.subscribeShell"
                        if state.flood_shell_chunks.load(Ordering::SeqCst) > 0 =>
                    {
                        for n in 0..state.flood_shell_chunks.load(Ordering::SeqCst) {
                            let chunk = json!({
                                "_tag": "Chunk",
                                "requestId": id,
                                "values": [{"kind": "project.removed", "sequence": n + 1, "projectId": format!("p{n}")}]
                            });
                            let _ = tx.send(Message::Text(chunk.to_string().into())).await;
                        }
                    }
                    "orchestration.subscribeShell" => {
                        pending_shell_req = Some(id.clone());
                        let chunk = json!({
                            "_tag": "Chunk",
                            "requestId": id,
                            "values": [{
                                "kind": "snapshot",
                                "snapshot": {
                                    "schemaVersion": 2,
                                    "snapshotSequence": 42,
                                    "projects": [{
                                        "id": "proj-1",
                                        "title": "p0code",
                                        "workspaceRoot": "/tmp/p0code",
                                        "createdAt": "2026-11-27T11:00:00.000Z",
                                        "updatedAt": "2026-11-27T11:00:00.000Z"
                                    }],
                                    "threads": [{
                                        "id": "thread-1",
                                        "projectId": "proj-1",
                                        "title": "Initial Title",
                                        "providerInstanceId": "replay",
                                        "modelSelection": {"instanceId": "replay", "model": "replay-default"},
                                        "runtimeMode": "approval-required",
                                        "interactionMode": "default",
                                        "status": "idle",
                                        "itemCount": 1,
                                        "visibleItemCount": 1,
                                        "createdAt": "2026-11-27T12:00:00.000Z",
                                        "updatedAt": "2026-11-27T12:00:00.000Z"
                                    }],
                                    "archivedThreads": []
                                }
                            }]
                        });
                        let _ = tx.send(Message::Text(chunk.to_string().into())).await;
                    }
                    "orchestration.subscribeThread" => {
                        let chunk = json!({
                            "_tag": "Chunk",
                            "requestId": id,
                            "values": [
                                {
                                    "kind": "snapshot",
                                    "snapshotSequence": 42,
                                    "projection": {
                                        "thread": {
                                            "id": "thread-1",
                                            "projectId": "proj-1",
                                            "title": "Initial Title",
                                            "providerInstanceId": "replay",
                                            "modelSelection": {"instanceId": "replay", "model": "replay-default"},
                                            "runtimeMode": "approval-required",
                                            "interactionMode": "default",
                                            "createdAt": "2026-11-27T12:00:00.000Z",
                                            "updatedAt": "2026-11-27T12:00:00.000Z"
                                        },
                                        "runs": [],
                                        "runtimeRequests": [],
                                        "messages": [],
                                        "plans": [],
                                        "turnItems": [],
                                        "visibleTurnItems": [],
                                        "updatedAt": "2026-11-27T12:00:00.000Z"
                                    }
                                },
                                {
                                    "kind": "event",
                                    "sequence": 43,
                                    "event": {
                                        "type": "turn-item.updated",
                                        "occurredAt": "2026-11-27T12:01:00.000Z",
                                        "payload": {
                                            "type": "assistant_message",
                                            "id": "item-1",
                                            "threadId": "thread-1",
                                            "ordinal": 0,
                                            "status": "running",
                                            "updatedAt": "2026-11-27T12:01:00.000Z",
                                            "messageId": "msg-1",
                                            "text": "Streaming hello",
                                            "streaming": true
                                        }
                                    }
                                }
                            ]
                        });
                        let _ = tx.send(Message::Text(chunk.to_string().into())).await;
                    }
                    "orchestration.dispatchCommand" => {
                        let resp = json!({
                            "_tag": "Exit",
                            "requestId": id,
                            "exit": {"_tag": "Success", "value": {"sequence": 44}}
                        });
                        let _ = tx.send(Message::Text(resp.to_string().into())).await;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn desktop_secret_file_matches_electron_and_p0d() {
    let dir = std::env::temp_dir().join(format!("p0-auth-test-{}", uuid::Uuid::new_v4()));
    let path = dir.join("secrets").join("desktop-bootstrap-secret");

    // Created in Electron's format: 64 hex chars + newline, mode 0600, dir 0700.
    let s1 = ensure_desktop_secret_file(&path).unwrap();
    let s2 = ensure_desktop_secret_file(&path).unwrap();
    assert_eq!(s1, s2, "secret file must be reused stably across launches");
    assert!(p0_client::is_electron_desktop_secret(&s1));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{s1}\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
    }

    // A file Electron wrote is used as-is; a loose mode is repaired, not rotated.
    let electron = "ab".repeat(32);
    std::fs::write(&path, format!("{electron}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert_eq!(ensure_desktop_secret_file(&path).unwrap(), electron);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // p0d accepts any base64url secret of >= 32 bytes, so attaching reads it; starting a new p0d
    // replaces it, because Electron would rotate it on its next launch.
    let b64 = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB";
    std::fs::write(&path, b64).unwrap();
    assert_eq!(read_desktop_secret_file(&path).as_deref(), Some(b64));
    let replaced = ensure_desktop_secret_file(&path).unwrap();
    assert_ne!(replaced, b64);
    assert!(p0_client::is_electron_desktop_secret(&replaced));

    std::fs::write(&path, "too-short").unwrap();
    assert_eq!(read_desktop_secret_file(&path), None);

    let now_ms = 1_764_250_000_000u64;
    let tok = derive_desktop_bootstrap_token(&s1, now_ms);
    assert_eq!(tok.len(), 64);
    assert_ne!(tok, s1);
    assert!(is_valid_desktop_bootstrap_token(&s1, &tok, now_ms));
    assert!(is_valid_desktop_bootstrap_token(
        &s1,
        &tok,
        now_ms + p0_client::DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS
    ));
    assert!(!is_valid_desktop_bootstrap_token(
        &s1,
        &tok,
        now_ms + p0_client::DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 3
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn end_to_end_local_bootstrap_ws_rpc_frame_parts_ack_and_stores() {
    let secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let (base_url, state, server_task) = start_fake_server(secret.to_owned(), false).await;

    let client = RpcClient::connect(ClientConfig::new(
        base_url,
        AuthMode::LocalBootstrap {
            secret: secret.to_owned(),
            client_label: "p0-gpui-test".to_owned(),
        },
    ));
    client.wait_connected(Duration::from_secs(5)).await.unwrap();

    // 1. Unary probe
    let probe = client.probe().await.unwrap();
    assert_eq!(
        probe.server_time.as_deref(),
        Some("2026-11-27T12:00:00.000Z")
    );

    // 2. Large (>48 KiB) server.getConfig reassembled across U+001E frame parts
    let cfg = client.get_config().await.unwrap();
    assert_eq!(cfg.environment.environment_id, "env-fake-1");
    assert_eq!(cfg.providers.len(), 1);
    assert_eq!(cfg.providers[0].models[0].slug, "replay-default");

    // 3. subscribeShell + Ack backpressure + ShellStore delta
    let shell_store = ShellStore::new();
    let mut shell_rx = client
        .subscribe_shell(SubscribeShellInput::default())
        .await
        .unwrap();

    let first = shell_rx.recv().await.unwrap().unwrap();
    assert!(matches!(first, ShellStreamItem::Snapshot { .. }));
    shell_store.apply(first);
    assert_eq!(shell_store.snapshot().projects.len(), 1);
    assert_eq!(shell_store.snapshot().threads[0].title, "Initial Title");

    // Second event only arrives after our client sent Ack for the first chunk!
    let second = tokio::time::timeout(Duration::from_secs(3), shell_rx.recv())
        .await
        .expect("delta should arrive after Ack")
        .unwrap()
        .unwrap();
    shell_store.apply(second);
    assert_eq!(shell_store.snapshot().threads[0].title, "Updated Title");
    assert!(state.shell_acks.load(Ordering::SeqCst) >= 1);

    // 4. subscribeThread + ThreadStore snapshot + turn-item.updated delta
    let thread_store = ThreadStore::new();
    thread_store.reset(Some("thread-1".to_owned()));
    let mut thread_rx = client
        .subscribe_thread(SubscribeThreadInput {
            thread_id: "thread-1".to_owned(),
            after_sequence: None,
            request_completion_marker: None,
        })
        .await
        .unwrap();
    let t1 = thread_rx.recv().await.unwrap().unwrap();
    let t2 = thread_rx.recv().await.unwrap().unwrap();
    assert!(matches!(t1, ThreadStreamItem::Snapshot { .. }));
    assert!(matches!(t2, ThreadStreamItem::Event { .. }));
    assert!(thread_store.apply_for("thread-1", t1));
    assert!(thread_store.apply_for("thread-1", t2));
    let tstate = thread_store.snapshot();
    let proj = tstate.projection.unwrap();
    assert_eq!(proj.visible_turn_items.len(), 1);
    assert!(matches!(
        proj.visible_turn_items[0].item,
        TurnItem::AssistantMessage { .. }
    ));

    // 5. dispatchCommand (send message + approval respond)
    let res = client
        .dispatch_command(&OrchestrationCommand::MessageDispatch {
            created_by: "user".to_owned(),
            creation_source: "web".to_owned(),
            command_id: "cmd-1".to_owned(),
            thread_id: "thread-1".to_owned(),
            message_id: "msg-2".to_owned(),
            text: "Hello!".to_owned(),
            attachments: vec![],
            model_selection: Some(ModelSelection {
                instance_id: "replay".to_owned(),
                model: "replay-default".to_owned(),
                options: None,
            }),
            dispatch_mode: DispatchMode::StartImmediately,
        })
        .await
        .unwrap();
    assert_eq!(res.sequence, 44);

    let res2 = client
        .dispatch_command(&OrchestrationCommand::RuntimeRequestRespond {
            command_id: "cmd-2".to_owned(),
            thread_id: "thread-1".to_owned(),
            request_id: "req-1".to_owned(),
            decision: Some(ApprovalDecision::Accept),
            feedback: None,
            answers: None,
        })
        .await
        .unwrap();
    assert_eq!(res2.sequence, 44);

    client.shutdown().await;
    server_task.abort();
}

#[tokio::test]
async fn reconnects_after_server_drops_socket() {
    let secret = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    let (base_url, state, server_task) = start_fake_server(secret.to_owned(), true).await;

    let client = RpcClient::connect(ClientConfig::new(
        base_url,
        AuthMode::LocalBootstrap {
            secret: secret.to_owned(),
            client_label: "p0-gpui-reconnect-test".to_owned(),
        },
    ));
    client.wait_connected(Duration::from_secs(5)).await.unwrap();
    // First probe causes server to drop the socket right after replying.
    let _ = client.probe().await.unwrap();

    // Wait for supervisor to reconnect automatically.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    client.wait_connected(Duration::from_secs(5)).await.unwrap();
    assert!(state.ws_connections.load(Ordering::SeqCst) >= 2);
    let _ = client.probe().await.unwrap();
    // A reconnect reuses the session: signing in again would sign other desktop clients out.
    assert_eq!(state.exchanges.load(Ordering::SeqCst), 1);

    client.shutdown().await;
    server_task.abort();
}

#[tokio::test]
async fn dpop_mode_returns_clear_unimplemented_error() {
    let client = RpcClient::connect(ClientConfig::new(
        "http://127.0.0.1:1",
        AuthMode::Dpop {
            key_id: "remote-1".to_owned(),
        },
    ));
    let err = client
        .wait_connected(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert!(matches!(err, ClientError::Auth(_)));
    assert!(matches!(
        client.connection_state(),
        ConnectionState::AuthFailed(_)
    ));
    client.shutdown().await;
}

#[tokio::test]
async fn live_p0d_bootstrap_auth_and_probe() {
    let Ok(bin) = std::env::var("P0D_TEST_BIN") else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("p0-live-p0d-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("secrets")).unwrap();

    // Initialize minimal auth_sessions schema in temp statev2.sqlite + server signing key.
    let db_path = dir.join("statev2.sqlite");
    let ddl = "CREATE TABLE auth_sessions (\
        session_id TEXT PRIMARY KEY, subject TEXT NOT NULL, scopes TEXT NOT NULL, method TEXT NOT NULL,\
        client_label TEXT, client_ip_address TEXT, client_user_agent TEXT,\
        client_device_type TEXT NOT NULL DEFAULT 'unknown', client_os TEXT, client_browser TEXT,\
        issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_connected_at TEXT, revoked_at TEXT,\
        client_surface TEXT, client_app_version TEXT, proof_key_thumbprint TEXT)";
    let py = std::process::Command::new("python3")
        .arg("-c")
        .arg("import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit(); c.close()")
        .arg(&db_path)
        .arg(ddl)
        .status()
        .expect("python3 sqlite3 init");
    assert!(py.success(), "failed to initialize temp statev2.sqlite");

    let key_path = dir.join("secrets").join("server-signing-key.bin");
    std::fs::write(&key_path, [42u8; 32]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    let mut cfg = p0_client::P0dLaunchConfig::for_home(&dir);
    cfg.configured_binary = Some(bin.into());

    let mut proc = p0_client::P0dProcess::attach_or_spawn(cfg).await.unwrap();
    let secret = proc
        .bootstrap_secret()
        .expect("spawned p0d must carry bootstrap secret")
        .to_owned();

    let client = RpcClient::connect(ClientConfig::new(
        proc.url().to_owned(),
        AuthMode::LocalBootstrap {
            secret,
            client_label: "p0-gpui-live-test".to_owned(),
        },
    ));
    client
        .wait_connected(Duration::from_secs(10))
        .await
        .unwrap();
    let probe = client.probe().await.unwrap();
    assert!(probe.server_time.is_some());

    client.shutdown().await;
    proc.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn live_p0d_settings_roundtrip() {
    let (Ok(bin), Ok(legacy)) = (
        std::env::var("P0D_TEST_BIN"),
        std::env::var("P0D_LEGACY_SERVER"),
    ) else {
        return;
    };
    let root = std::env::temp_dir().join(format!("p0-live-settings-{}", uuid::Uuid::new_v4()));
    let home = root.join("userdata");
    std::fs::create_dir_all(&home).unwrap();

    let mut cfg = p0_client::P0dLaunchConfig::for_home(&home);
    cfg.configured_binary = Some(bin.into());
    cfg.legacy_server = Some(legacy);

    let mut proc = p0_client::P0dProcess::attach_or_spawn(cfg).await.unwrap();
    let secret = proc
        .bootstrap_secret()
        .expect("spawned p0d must carry bootstrap secret")
        .to_owned();

    let mut client_cfg = ClientConfig::new(
        proc.url().to_owned(),
        AuthMode::LocalBootstrap {
            secret,
            client_label: "p0-gpui-settings-test".to_owned(),
        },
    );
    client_cfg.request_timeout = Duration::from_secs(60);
    let client = RpcClient::connect(client_cfg);
    client
        .wait_connected(Duration::from_secs(45))
        .await
        .unwrap();

    // 1. Keybindings read + upsert + verify persistence + remove
    let config = client.get_config().await.unwrap();
    assert!(
        !config.keybindings.is_empty(),
        "server should return resolved keybindings"
    );
    let added = client
        .upsert_keybinding(&p0_protocol::ServerUpsertKeybindingInput {
            key: "mod+alt+shift+y".to_owned(),
            command: "sidebar.toggle".to_owned(),
            when: Some("!terminalFocus".to_owned()),
            replace: None,
        })
        .await
        .unwrap();
    assert!(
        added
            .keybindings
            .iter()
            .any(|k| k.command == "sidebar.toggle" && k.shortcut.to_wire_key() == "mod+alt+shift+y"),
        "upserted keybinding missing from result"
    );
    let config_after = client.get_config().await.unwrap();
    assert!(
        config_after
            .keybindings
            .iter()
            .any(|k| k.command == "sidebar.toggle" && k.shortcut.to_wire_key() == "mod+alt+shift+y"),
        "upserted keybinding did not persist in server.getConfig"
    );
    let removed = client
        .remove_keybinding(&p0_protocol::ServerRemoveKeybindingInput {
            key: "mod+alt+shift+y".to_owned(),
            command: "sidebar.toggle".to_owned(),
            when: Some("!terminalFocus".to_owned()),
        })
        .await
        .unwrap();
    assert!(
        !removed
            .keybindings
            .iter()
            .any(|k| k.command == "sidebar.toggle" && k.shortcut.to_wire_key() == "mod+alt+shift+y"),
        "removed keybinding still present"
    );

    // 2. Provider model preferences & idleCompaction round-trip
    let updated_prefs = client
        .update_settings(&json!({
            "idleCompaction": "beforeCacheExpires",
            "setModelFavorites": [{"provider": "codex", "model": "gpt-5", "favorite": true}],
            "setModelsHidden": [{"provider": "codex", "model": "gpt-4", "hidden": true}]
        }))
        .await
        .unwrap();
    assert_eq!(updated_prefs["idleCompaction"], "beforeCacheExpires");
    assert!(
        updated_prefs["favorites"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["provider"] == "codex" && f["model"] == "gpt-5")
    );
    assert!(
        updated_prefs["providerModelPreferences"]["codex"]["hiddenModels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m == "gpt-4")
    );

    // 3. Archived threads snapshot round-trip
    let archived = client.get_archived_shell_snapshot().await.unwrap();
    assert_eq!(archived.schema_version, 2);

    // 4. Peer links list round-trip
    let peers = client.list_peer_links().await.unwrap();
    assert!(peers.links.is_empty());

    // 5. Plugins subscription snapshot round-trip
    let mut plugins_sub = client.subscribe_plugins().await.unwrap();
    let plugins_snap = tokio::time::timeout(Duration::from_secs(10), plugins_sub.recv())
        .await
        .expect("plugins snapshot timeout")
        .expect("plugins stream ended")
        .unwrap();
    assert!(
        plugins_snap
            .plugins
            .iter()
            .all(|p| !p.manifest.id.is_empty()),
        "plugin manifests should decode ids"
    );

    // 6. Labs / Workflows settings round-trip
    let labs_updated = client
        .update_settings(&json!({
            "workflowsEnabled": true,
            "workflowSkippedRunsKept": 25
        }))
        .await
        .unwrap();
    assert_eq!(labs_updated["workflowsEnabled"], true);
    assert_eq!(labs_updated["workflowSkippedRunsKept"], 25);

    // 7. Maintenance settings & storage/database RPC round-trip
    let maint_updated = client
        .update_settings(&json!({
            "backgroundActivity": {
                "schemaVersion": 1,
                "profile": "battery-saver",
                "overrides": {}
            },
            "storageCleanup": {
                "logsAfterDays": 14
            }
        }))
        .await
        .unwrap();
    assert_eq!(
        maint_updated["backgroundActivity"]["profile"],
        "battery-saver"
    );
    assert_eq!(maint_updated["storageCleanup"]["logsAfterDays"], 14);
    let mut cleanup_sub = client.subscribe_storage_cleanup_report().await.unwrap();
    let _cleanup_report = tokio::time::timeout(Duration::from_secs(10), cleanup_sub.recv())
        .await
        .expect("storage cleanup report stream timeout")
        .expect("storage cleanup report stream ended")
        .unwrap();
    let mut db_sub = client.subscribe_database_storage().await.unwrap();
    let db_storage = tokio::time::timeout(Duration::from_secs(10), db_sub.recv())
        .await
        .expect("database storage stream timeout")
        .expect("database storage stream ended")
        .unwrap();
    if let Some(status) = db_storage {
        assert!(status.database_bytes >= 0.0);
        assert!(!status.compact_command.is_empty());
    }

    // 8. Threads settings round-trip
    let threads_updated = client
        .update_settings(&json!({
            "autoResumeLimitedThreads": true,
            "snoozeLimitedThreads": true,
            "sidebarAutoSettleAfterDays": 14,
            "responseStreamingMode": "turn",
            "defaultThreadEnvMode": "worktree"
        }))
        .await
        .unwrap();
    assert_eq!(threads_updated["autoResumeLimitedThreads"], true);
    assert_eq!(threads_updated["snoozeLimitedThreads"], true);
    assert_eq!(threads_updated["sidebarAutoSettleAfterDays"], 14);
    assert_eq!(threads_updated["responseStreamingMode"], "turn");
    assert_eq!(threads_updated["defaultThreadEnvMode"], "worktree");

    // 9. Worktrees settings round-trip
    let worktrees_updated = client
        .update_settings(&json!({
            "newWorktreesStartFromOrigin": false,
            "worktreeSubmodules": "recursive",
            "branchNamingMode": "semantic",
            "storageCleanup": {
                "worktreeOnDelete": true,
                "worktreeKeepWhen": "tracked-changes"
            }
        }))
        .await
        .unwrap();
    assert_eq!(worktrees_updated["newWorktreesStartFromOrigin"], false);
    assert_eq!(worktrees_updated["worktreeSubmodules"], "recursive");
    assert_eq!(worktrees_updated["branchNamingMode"], "semantic");
    assert_eq!(
        worktrees_updated["storageCleanup"]["worktreeOnDelete"],
        true
    );
    assert_eq!(
        worktrees_updated["storageCleanup"]["worktreeKeepWhen"],
        "tracked-changes"
    );

    // 10. Scheduled tasks stream & diagnostics RPC round-trip
    let mut sched_sub = client.subscribe_scheduled_tasks().await.unwrap();
    let sched_snap = tokio::time::timeout(Duration::from_secs(10), sched_sub.recv())
        .await
        .expect("scheduledTasks snapshot timeout")
        .expect("scheduledTasks stream ended")
        .unwrap();
    assert!(sched_snap.tasks.is_empty());

    let host_res = client.get_host_resources().await.unwrap();
    assert!(host_res.cpu_count >= 1);
    assert!(host_res.total_memory_bytes > 0.0);

    let proc_diag = client.get_process_diagnostics().await.unwrap();
    assert!(proc_diag.server_pid > 0);

    let trace_diag = client.get_trace_diagnostics().await.unwrap();
    assert!(!trace_diag.trace_file_path.is_empty());

    // 11. Projects, Source control, and Sharing & access settings round-trip
    let sc_access_updated = client
        .update_settings(&json!({
            "defaultAutoPull": true,
            "sourceControlWritingStyle": {
                "mode": "conventional_commits",
                "followChangeRequestTemplates": false
            },
            "pullRequestMergeMethod": "squash",
            "removeAgentCreditsOnMerge": true,
            "reviewGuidesEnabled": true,
            "requireConnectDeviceApproval": true,
            "enablePreviewTunnel": false
        }))
        .await
        .unwrap();
    assert_eq!(sc_access_updated["defaultAutoPull"], true);
    assert_eq!(
        sc_access_updated["sourceControlWritingStyle"]["mode"],
        "conventional_commits"
    );
    assert_eq!(sc_access_updated["pullRequestMergeMethod"], "squash");
    assert_eq!(sc_access_updated["removeAgentCreditsOnMerge"], true);
    assert_eq!(sc_access_updated["reviewGuidesEnabled"], true);
    assert_eq!(sc_access_updated["requireConnectDeviceApproval"], true);
    assert_eq!(sc_access_updated["enablePreviewTunnel"], false);

    client.shutdown().await;
    proc.shutdown().await;
    let _ = std::fs::remove_dir_all(&root);
}

fn local_client(base_url: String, secret: &str) -> ClientConfig {
    ClientConfig::new(
        base_url,
        AuthMode::LocalBootstrap {
            secret: secret.to_owned(),
            client_label: "p0-gpui-test".to_owned(),
        },
    )
}

#[tokio::test]
async fn revoked_session_signs_in_again_then_stops_instead_of_looping() {
    let secret = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    let (base_url, state, server_task) = start_fake_server(secret.to_owned(), false).await;
    let mut config = local_client(base_url, secret);
    config.revoked_retry_delay = |n| (n < 3).then_some(Duration::from_millis(20));
    let client = RpcClient::connect(config);
    client.wait_connected(Duration::from_secs(5)).await.unwrap();
    assert_eq!(state.exchanges.load(Ordering::SeqCst), 1);

    // One revocation: the client signs in again by itself and keeps working.
    state.revoke_after_connect.store(true, Ordering::SeqCst);
    client.reconnect_now().await;
    let mut rx = client.subscribe_connection_state();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                *rx.borrow_and_update(),
                ConnectionState::SignedOutElsewhere { retry_in_ms: None }
            ) {
                break;
            }
            rx.changed().await.unwrap();
        }
    })
    .await
    .expect("client must stop signing back in after repeated revocations");
    // Initial sign-in + one per allowed retry (revocations 1 and 2), then it parks.
    assert_eq!(state.exchanges.load(Ordering::SeqCst), 3);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        state.exchanges.load(Ordering::SeqCst),
        3,
        "parked client must not sign in"
    );

    // The user asks to sign in here again.
    state.revoke_after_connect.store(false, Ordering::SeqCst);
    client.reconnect_now().await;
    client.wait_connected(Duration::from_secs(5)).await.unwrap();
    assert_eq!(state.exchanges.load(Ordering::SeqCst), 4);
    let _ = client.probe().await.unwrap();

    client.shutdown().await;
    server_task.abort();
}

#[tokio::test]
async fn unread_stream_does_not_block_other_requests() {
    let secret = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    let (base_url, state, server_task) = start_fake_server(secret.to_owned(), false).await;
    state.flood_shell_chunks.store(6_000, Ordering::SeqCst);
    let client = RpcClient::connect(local_client(base_url, secret));
    client.wait_connected(Duration::from_secs(5)).await.unwrap();

    // Never read: the stream queue is bounded, and the read loop must not wait on it.
    let mut unread = client
        .subscribe_shell(SubscribeShellInput::default())
        .await
        .unwrap();
    let probe = tokio::time::timeout(Duration::from_secs(3), client.probe())
        .await
        .expect("probe must not wait behind an unread stream");
    probe.unwrap();
    assert_eq!(state.shell_acks.load(Ordering::SeqCst), 0);
    let mut count = 0;
    loop {
        match unread.recv().await {
            Some(Ok(_)) => count += 1,
            Some(Err(ClientError::Protocol(message))) => {
                assert!(message.contains("overflow"));
                break;
            }
            other => panic!("expected explicit stream overflow, got {other:?}"),
        }
        assert!(count <= 4096, "stream queue must be bounded");
    }

    client.shutdown().await;
    server_task.abort();
}

#[tokio::test]
async fn durable_stream_resubscribes_from_cursor_after_reconnect() {
    let secret = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
    let (base_url, state, server_task) = start_fake_server(secret.to_owned(), true).await;
    let client = RpcClient::connect(local_client(base_url, secret));
    let store = Arc::new(ShellStore::new());
    let payloads = Arc::new(Mutex::new(Vec::<Option<u64>>::new()));
    let task = tokio::spawn(p0_client::run_durable_stream(
        client.clone(),
        p0_protocol::RPC_ORCHESTRATION_SUBSCRIBE_SHELL,
        {
            let store = store.clone();
            let payloads = payloads.clone();
            move || {
                let seq = store.snapshot().last_sequence;
                let after = (seq > 0).then_some(seq);
                payloads.lock().unwrap().push(after);
                SubscribeShellInput {
                    after_sequence: after,
                    ..SubscribeShellInput::default()
                }
            }
        },
        {
            let store = store.clone();
            move |item: ShellStreamItem| store.apply(item)
        },
        |_| {},
    ));

    client.wait_connected(Duration::from_secs(5)).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while store.snapshot().last_sequence < 43 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    // The fake server drops the first socket after a probe.
    let _ = client.probe().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while payloads.lock().unwrap().len() < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("stream must be re-subscribed after reconnect");
    assert_eq!(payloads.lock().unwrap()[1], Some(43));
    assert!(state.ws_connections.load(Ordering::SeqCst) >= 2);

    task.abort();
    client.shutdown().await;
    server_task.abort();
}
