//! Tokio <-> GPUI bridge managing `P0dProcess`, `RpcClient`, `ShellStore`, `ThreadStore`,
//! and reactive change notification counters (coalesced on the UI side at <=60 Hz).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use p0_client::{
    AuthMode, ClientConfig, ClientError, ConnectionState, P0dLaunchConfig, P0dProcess, RpcClient,
    ShellState, ShellStore, ThreadState, ThreadStore, read_valid_bootstrap_secret_file,
};
use p0_protocol::{
    ApprovalDecision, DispatchMode, ModelSelection, OrchestrationCommand, RuntimeMode,
    SecretRequestAnswer, SecretRequestAnswerInput, ServerConfig, SubscribeShellInput,
    SubscribeThreadInput,
};
use tokio::runtime::Runtime;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::{info, warn};
use uuid::Uuid;

use crate::cli::Cli;

pub struct AppBridge {
    rt: Runtime,
    client: RpcClient,
    shell_store: Arc<ShellStore>,
    thread_store: Arc<ThreadStore>,
    server_config: watch::Receiver<Option<ServerConfig>>,
    last_error: Arc<Mutex<Option<String>>>,
    version: Arc<AtomicU64>,
    thread_sub_task: Mutex<Option<JoinHandle<()>>>,
    _p0d: Mutex<Option<P0dProcess>>,
}

impl AppBridge {
    pub fn start(cli: &Cli) -> Result<Arc<Self>, ClientError> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;

        let (base_url, auth, p0d_proc) = rt.block_on(resolve_connection(cli))?;
        let client = RpcClient::connect(ClientConfig::new(base_url, auth));

        let shell_store = Arc::new(ShellStore::new());
        let thread_store = Arc::new(ThreadStore::new());
        let (cfg_tx, cfg_rx) = watch::channel(None);
        let last_error = Arc::new(Mutex::new(None));
        let version = Arc::new(AtomicU64::new(1));

        // Bump version whenever connection state changes and re-subscribe shell + config.
        {
            let client_c = client.clone();
            let shell_c = shell_store.clone();
            let version_c = version.clone();
            let err_c = last_error.clone();
            let mut conn_rx = client.subscribe_connection_state();
            rt.spawn(async move {
                let mut shell_task: Option<JoinHandle<()>> = None;
                loop {
                    let state = conn_rx.borrow().clone();
                    version_c.fetch_add(1, Ordering::Release);
                    if matches!(state, ConnectionState::Connected) {
                        // Fetch server.getConfig
                        let cfg_client = client_c.clone();
                        let cfg_tx_c = cfg_tx.clone();
                        let v_cfg = version_c.clone();
                        tokio::spawn(async move {
                            match cfg_client.get_config().await {
                                Ok(cfg) => {
                                    let _ = cfg_tx_c.send(Some(cfg));
                                    v_cfg.fetch_add(1, Ordering::Release);
                                }
                                Err(err) => {
                                    warn!(error = %err, "server.getConfig failed");
                                }
                            }
                        });

                        // Restart shell subscription from last known sequence
                        if let Some(prev) = shell_task.take() {
                            prev.abort();
                        }
                        let s_client = client_c.clone();
                        let s_store = shell_c.clone();
                        let s_ver = version_c.clone();
                        let s_err = err_c.clone();
                        shell_task = Some(tokio::spawn(async move {
                            let seq = s_store.snapshot().last_sequence;
                            let input = SubscribeShellInput {
                                after_sequence: (seq > 0).then_some(seq),
                                http_snapshot_fallback: None,
                                request_completion_marker: Some(true),
                            };
                            match s_client.subscribe_shell(input).await {
                                Ok(mut sub) => {
                                    while let Some(item) = sub.recv().await {
                                        match item {
                                            Ok(ev) => {
                                                s_store.apply(ev);
                                                s_ver.fetch_add(1, Ordering::Release);
                                            }
                                            Err(err) => {
                                                warn!(error = %err, "shell stream error");
                                                *s_err.lock().unwrap() = Some(err.to_string());
                                                s_ver.fetch_add(1, Ordering::Release);
                                                break;
                                            }
                                        }
                                    }
                                }
                                Err(err) => {
                                    warn!(error = %err, "failed to subscribe shell");
                                    *s_err.lock().unwrap() = Some(err.to_string());
                                    s_ver.fetch_add(1, Ordering::Release);
                                }
                            }
                        }));
                    }
                    if conn_rx.changed().await.is_err() {
                        break;
                    }
                }
            });
        }

        Ok(Arc::new(Self {
            rt,
            client,
            shell_store,
            thread_store,
            server_config: cfg_rx,
            last_error,
            version,
            thread_sub_task: Mutex::new(None),
            _p0d: Mutex::new(p0d_proc),
        }))
    }

    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    pub fn connection_state(&self) -> ConnectionState {
        self.client.connection_state()
    }

    pub fn shell_state(&self) -> ShellState {
        self.shell_store.snapshot()
    }

    pub fn thread_state(&self) -> ThreadState {
        self.thread_store.snapshot()
    }

    pub fn server_config(&self) -> Option<ServerConfig> {
        self.server_config.borrow().clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }

    pub fn clear_error(&self) {
        *self.last_error.lock().unwrap() = None;
        self.version.fetch_add(1, Ordering::Release);
    }

    pub fn reconnect_now(&self) {
        let client = self.client.clone();
        self.rt.spawn(async move {
            client.reconnect_now().await;
        });
    }

    pub fn select_thread(&self, thread_id: String) {
        let mut slot = self.thread_sub_task.lock().unwrap();
        if let Some(prev) = slot.take() {
            prev.abort();
        }
        self.thread_store.reset(Some(thread_id.clone()));
        self.version.fetch_add(1, Ordering::Release);

        let client = self.client.clone();
        let store = self.thread_store.clone();
        let ver = self.version.clone();
        let err_slot = self.last_error.clone();

        *slot = Some(self.rt.spawn(async move {
            let input = SubscribeThreadInput {
                thread_id: thread_id.clone(),
                after_sequence: None,
                request_completion_marker: Some(true),
            };
            match client.subscribe_thread(input).await {
                Ok(mut sub) => {
                    while let Some(item) = sub.recv().await {
                        match item {
                            Ok(ev) => {
                                store.apply(ev);
                                ver.fetch_add(1, Ordering::Release);
                            }
                            Err(err) => {
                                warn!(error = %err, thread = %thread_id, "thread stream error");
                                *err_slot.lock().unwrap() = Some(err.to_string());
                                ver.fetch_add(1, Ordering::Release);
                                break;
                            }
                        }
                    }
                }
                Err(err) => {
                    warn!(error = %err, thread = %thread_id, "failed to subscribe thread");
                    *err_slot.lock().unwrap() = Some(err.to_string());
                    ver.fetch_add(1, Ordering::Release);
                }
            }
        }));
    }

    pub fn send_message(
        &self,
        thread_id: String,
        text: String,
        model_selection: Option<ModelSelection>,
        active_run_id: Option<String>,
    ) {
        let client = self.client.clone();
        let err_slot = self.last_error.clone();
        let ver = self.version.clone();
        let dispatch_mode = if active_run_id.is_some() {
            DispatchMode::QueueAfterActive
        } else {
            DispatchMode::StartImmediately
        };
        let cmd = OrchestrationCommand::MessageDispatch {
            command_id: Uuid::new_v4().to_string(),
            thread_id,
            message_id: Uuid::new_v4().to_string(),
            text,
            attachments: Vec::new(),
            model_selection,
            dispatch_mode,
        };
        self.rt.spawn(async move {
            if let Err(err) = client.dispatch_command(&cmd).await {
                warn!(error = %err, "message.dispatch failed");
                *err_slot.lock().unwrap() = Some(err.to_string());
                ver.fetch_add(1, Ordering::Release);
            }
        });
    }

    pub fn stop_thread(&self, thread_id: String, active_run_id: Option<String>) {
        let client = self.client.clone();
        let err_slot = self.last_error.clone();
        let ver = self.version.clone();
        let cmd = if let Some(run_id) = active_run_id {
            OrchestrationCommand::RunInterrupt {
                command_id: Uuid::new_v4().to_string(),
                thread_id,
                run_id,
                reason: Some("user_stop".to_owned()),
            }
        } else {
            OrchestrationCommand::ThreadStop {
                command_id: Uuid::new_v4().to_string(),
                thread_id,
                reason: Some("user_stop".to_owned()),
            }
        };
        self.rt.spawn(async move {
            if let Err(err) = client.dispatch_command(&cmd).await {
                warn!(error = %err, "stop command failed");
                *err_slot.lock().unwrap() = Some(err.to_string());
                ver.fetch_add(1, Ordering::Release);
            }
        });
    }

    pub fn respond_approval(
        &self,
        thread_id: String,
        request_id: String,
        decision: ApprovalDecision,
    ) {
        let client = self.client.clone();
        let err_slot = self.last_error.clone();
        let ver = self.version.clone();
        let cmd = OrchestrationCommand::RuntimeRequestRespond {
            command_id: Uuid::new_v4().to_string(),
            thread_id,
            request_id,
            decision: Some(decision),
            feedback: None,
            answers: None,
        };
        self.rt.spawn(async move {
            if let Err(err) = client.dispatch_command(&cmd).await {
                warn!(error = %err, "runtime-request.respond failed");
                *err_slot.lock().unwrap() = Some(err.to_string());
                ver.fetch_add(1, Ordering::Release);
            }
        });
    }

    pub fn answer_user_input(
        &self,
        thread_id: String,
        request_id: String,
        answers: serde_json::Value,
    ) {
        let client = self.client.clone();
        let err_slot = self.last_error.clone();
        let ver = self.version.clone();
        let cmd = OrchestrationCommand::RuntimeRequestRespond {
            command_id: Uuid::new_v4().to_string(),
            thread_id,
            request_id,
            decision: None,
            feedback: None,
            answers: Some(answers),
        };
        self.rt.spawn(async move {
            if let Err(err) = client.dispatch_command(&cmd).await {
                warn!(error = %err, "user_input respond failed");
                *err_slot.lock().unwrap() = Some(err.to_string());
                ver.fetch_add(1, Ordering::Release);
            }
        });
    }

    pub fn answer_secret_request(
        &self,
        thread_id: String,
        turn_item_id: String,
        answer: SecretRequestAnswer,
    ) {
        let client = self.client.clone();
        let err_slot = self.last_error.clone();
        let ver = self.version.clone();
        let input = SecretRequestAnswerInput {
            thread_id,
            turn_item_id,
            answer,
        };
        self.rt.spawn(async move {
            if let Err(err) = client.answer_secret_request(&input).await {
                warn!(error = %err, "secrets.answerRequest failed");
                *err_slot.lock().unwrap() = Some(err.to_string());
                ver.fetch_add(1, Ordering::Release);
            }
        });
    }

    pub fn set_runtime_mode(&self, thread_id: String, runtime_mode: RuntimeMode) {
        let client = self.client.clone();
        let err_slot = self.last_error.clone();
        let ver = self.version.clone();
        let cmd = OrchestrationCommand::ThreadRuntimeModeSet {
            command_id: Uuid::new_v4().to_string(),
            thread_id,
            runtime_mode,
        };
        self.rt.spawn(async move {
            if let Err(err) = client.dispatch_command(&cmd).await {
                warn!(error = %err, "thread.runtime-mode.set failed");
                *err_slot.lock().unwrap() = Some(err.to_string());
                ver.fetch_add(1, Ordering::Release);
            }
        });
    }

    pub fn set_model_selection(&self, thread_id: String, model_selection: ModelSelection) {
        let client = self.client.clone();
        let err_slot = self.last_error.clone();
        let ver = self.version.clone();
        let cmd = OrchestrationCommand::ThreadModelSelectionSet {
            command_id: Uuid::new_v4().to_string(),
            thread_id,
            model_selection,
        };
        self.rt.spawn(async move {
            if let Err(err) = client.dispatch_command(&cmd).await {
                warn!(error = %err, "thread.model-selection.set failed");
                *err_slot.lock().unwrap() = Some(err.to_string());
                ver.fetch_add(1, Ordering::Release);
            }
        });
    }

    /// Runs the headless `--smoke` flow: connect, probe, wait for shell snapshot, print counts.
    pub fn run_smoke(cli: &Cli) -> Result<(), ClientError> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;

        rt.block_on(async move {
            let (base_url, auth, mut p0d_proc) = resolve_connection(cli).await?;
            let client = RpcClient::connect(ClientConfig::new(base_url.clone(), auth));
            client.wait_connected(Duration::from_secs(15)).await?;

            let probe = client.probe().await?;
            info!(server_time = ?probe.server_time, "server.probe succeeded");

            let store = ShellStore::new();
            let mut shell_rx = client
                .subscribe_shell(SubscribeShellInput::default())
                .await?;

            let first = tokio::time::timeout(Duration::from_secs(15), shell_rx.recv())
                .await
                .map_err(|_| ClientError::Timeout)?
                .ok_or(ClientError::Closed)??;
            store.apply(first);

            let snap = store.snapshot();
            println!(
                "p0-gpui smoke ok: url={} projects={} threads={} archived={} sequence={}",
                base_url,
                snap.projects.len(),
                snap.threads.len(),
                snap.archived_threads.len(),
                snap.last_sequence
            );

            client.shutdown().await;
            if let Some(proc) = p0d_proc.as_mut() {
                proc.shutdown().await;
            }
            Ok(())
        })
    }
}

async fn resolve_connection(
    cli: &Cli,
) -> Result<(String, AuthMode, Option<P0dProcess>), ClientError> {
    if let Some(url) = &cli.url {
        let auth = if let Some(token) = &cli.token {
            AuthMode::BearerToken(token.clone())
        } else {
            let secret_path = cli
                .resolved_home()
                .join("secrets")
                .join("desktop-bootstrap-secret");
            if let Some(secret) = read_valid_bootstrap_secret_file(&secret_path) {
                AuthMode::LocalBootstrap {
                    secret,
                    client_label: "p0-gpui".to_owned(),
                }
            } else {
                return Err(ClientError::Auth(
                    "connecting with --url requires --token or an existing desktop-bootstrap-secret"
                        .to_owned(),
                ));
            }
        };
        return Ok((url.clone(), auth, None));
    }

    let mut cfg = P0dLaunchConfig::for_home(cli.resolved_home());
    cfg.binary_path = cli.p0d_bin.clone();
    let proc = P0dProcess::attach_or_spawn(cfg).await?;
    let secret = proc
        .bootstrap_secret()
        .ok_or_else(|| {
            ClientError::Auth(
                "attached p0d has no readable desktop-bootstrap-secret; pass --token or restart p0d"
                    .to_owned(),
            )
        })?
        .to_owned();
    let url = proc.url().to_owned();
    Ok((
        url,
        AuthMode::LocalBootstrap {
            secret,
            client_label: "p0-gpui".to_owned(),
        },
        Some(proc),
    ))
}
