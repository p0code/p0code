//! Tokio <-> GPUI bridge: owns the `p0d` handle, the RPC client and the stores. Every change
//! wakes the UI through one `Notify`; the UI coalesces wakeups to one repaint per frame, so an
//! idle window does no work at all.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use p0_client::{
    AuthMode, ClientConfig, ClientError, ConnectionState, P0dLaunchConfig, P0dProcess, RpcClient,
    ShellState, ShellStore, ThreadState, ThreadStore, read_desktop_secret_file, run_durable_stream,
    wait_until_connected,
};
use p0_protocol::{
    ApprovalDecision, ArchivedShellSnapshot, DatabaseStorageStatus, DispatchMode,
    HostResourcesSnapshot, LaunchInitialMessage, LaunchThreadInput, ModelSelection,
    OrchestrationCommand, PeerLinkSummary, PluginInfo, PluginsSnapshot,
    RPC_ORCHESTRATION_SUBSCRIBE_SHELL, RPC_ORCHESTRATION_SUBSCRIBE_THREAD, RPC_PLUGINS_SUBSCRIBE,
    RPC_SCHEDULED_TASKS_SUBSCRIBE, RPC_SERVER_GET_DATABASE_STORAGE,
    RPC_SERVER_GET_STORAGE_CLEANUP_REPORT, RuntimeMode, ScheduledTaskListResult,
    SecretRequestAnswer, SecretRequestAnswerInput, ServerConfig, ServerProcessDiagnosticsResult,
    ServerRemoveKeybindingInput, ServerTraceDiagnosticsResult, ServerUpsertKeybindingInput,
    ShellStreamItem, StorageCleanupReport, SubscribeShellInput, SubscribeThreadInput,
    ThreadStreamItem, WorkspaceStrategy,
};
use serde_json::Value;
use tokio::runtime::Runtime;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tracing::{info, warn};
use uuid::Uuid;

use crate::cli::Cli;
use crate::terminal::{DEFAULT_TERMINAL_ID, SharedTerminal, apply_event};
use p0_terminal::rpc::{
    TERMINAL_ATTACH, TERMINAL_RESIZE, TERMINAL_WRITE, TerminalAttachInput,
    TerminalAttachStreamEvent, TerminalResizeInput, TerminalWriteInput,
};

pub struct AppBridge {
    rt: Runtime,
    client: RpcClient,
    base_url: String,
    shell: Arc<ShellStore>,
    thread: Arc<ThreadStore>,
    config: Arc<Mutex<Option<ServerConfig>>>,
    settings: Arc<Mutex<Option<Value>>>,
    archived_snapshot: Arc<Mutex<Option<ArchivedShellSnapshot>>>,
    peer_links: Arc<Mutex<Option<Vec<PeerLinkSummary>>>>,
    plugins: Arc<Mutex<Option<Vec<PluginInfo>>>>,
    storage_cleanup_report: Arc<Mutex<Option<Option<StorageCleanupReport>>>>,
    database_storage: Arc<Mutex<Option<Option<DatabaseStorageStatus>>>>,
    scheduled_tasks: Arc<Mutex<Option<ScheduledTaskListResult>>>,
    host_resources: Arc<Mutex<Option<HostResourcesSnapshot>>>,
    process_diagnostics: Arc<Mutex<Option<ServerProcessDiagnosticsResult>>>,
    trace_diagnostics: Arc<Mutex<Option<ServerTraceDiagnosticsResult>>>,
    notice: Arc<Mutex<Option<String>>>,
    changed: Arc<Notify>,
    thread_task: Mutex<Option<JoinHandle<()>>>,
    terminal_task: Mutex<Option<JoinHandle<()>>>,
    plugins_task: Mutex<Option<JoinHandle<()>>>,
    storage_tasks: Mutex<Option<(JoinHandle<()>, JoinHandle<()>)>>,
    scheduled_tasks_task: Mutex<Option<JoinHandle<()>>>,
    p0d: Mutex<Option<P0dProcess>>,
}

/// Errors worth a banner: a dropped socket already shows in the connection chip.
fn is_user_visible(err: &ClientError) -> bool {
    !matches!(err, ClientError::Transport(_) | ClientError::Closed)
}

impl AppBridge {
    pub fn start(cli: &Cli) -> Result<Arc<Self>, ClientError> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let (base_url, auth, p0d) = rt.block_on(resolve_connection(cli))?;
        let client = rt.block_on(async { RpcClient::connect(ClientConfig::new(&base_url, auth)) });

        let bridge = Arc::new(Self {
            rt,
            client,
            base_url,
            shell: Arc::new(ShellStore::new()),
            thread: Arc::new(ThreadStore::new()),
            config: Arc::new(Mutex::new(None)),
            settings: Arc::new(Mutex::new(None)),
            archived_snapshot: Arc::new(Mutex::new(None)),
            peer_links: Arc::new(Mutex::new(None)),
            plugins: Arc::new(Mutex::new(None)),
            storage_cleanup_report: Arc::new(Mutex::new(None)),
            database_storage: Arc::new(Mutex::new(None)),
            scheduled_tasks: Arc::new(Mutex::new(None)),
            host_resources: Arc::new(Mutex::new(None)),
            process_diagnostics: Arc::new(Mutex::new(None)),
            trace_diagnostics: Arc::new(Mutex::new(None)),
            notice: Arc::new(Mutex::new(None)),
            changed: Arc::new(Notify::new()),
            thread_task: Mutex::new(None),
            terminal_task: Mutex::new(None),
            plugins_task: Mutex::new(None),
            storage_tasks: Mutex::new(None),
            scheduled_tasks_task: Mutex::new(None),
            p0d: Mutex::new(p0d),
        });
        bridge.spawn_background();
        Ok(bridge)
    }

    fn spawn_background(&self) {
        // Connection state changes repaint the chip.
        let mut state_rx = self.client.subscribe_connection_state();
        let changed = self.changed.clone();
        self.rt.spawn(async move {
            while state_rx.changed().await.is_ok() {
                changed.notify_one();
            }
        });

        let shell = self.shell.clone();
        let shell_apply = self.shell.clone();
        let changed = self.changed.clone();
        let notice = self.notice.clone();
        self.rt.spawn(run_durable_stream(
            self.client.clone(),
            RPC_ORCHESTRATION_SUBSCRIBE_SHELL,
            move || {
                let state = shell.snapshot();
                SubscribeShellInput {
                    after_sequence: state.synchronized.then_some(state.last_sequence),
                    ..SubscribeShellInput::default()
                }
            },
            move |item: ShellStreamItem| {
                let snapshot = matches!(item, ShellStreamItem::Snapshot { .. });
                shell_apply.apply(item);
                if snapshot {
                    let state = shell_apply.snapshot();
                    info!(
                        projects = state.projects.len(),
                        threads = state.threads.len(),
                        "shell snapshot"
                    );
                }
                changed.notify_one();
            },
            move |err| {
                if is_user_visible(err) {
                    *notice.lock().unwrap() = Some(err.to_string());
                }
            },
        ));

        // Config and settings are fetched on every (re)connect.
        let client = self.client.clone();
        let config = self.config.clone();
        let settings = self.settings.clone();
        let changed = self.changed.clone();
        self.rt.spawn(async move {
            let mut state_rx = client.subscribe_connection_state();
            loop {
                if !wait_until_connected(&client).await {
                    return;
                }
                match client.get_config().await {
                    Ok(cfg) => *config.lock().unwrap() = Some(cfg),
                    Err(err) => warn!(error = %err, "server.getConfig failed"),
                }
                match client.get_settings().await {
                    Ok(value) => *settings.lock().unwrap() = Some(value),
                    Err(err) => warn!(error = %err, "server.getSettings failed"),
                }
                changed.notify_one();
                // Wait for this connection to end before fetching again.
                loop {
                    if !matches!(*state_rx.borrow_and_update(), ConnectionState::Connected) {
                        break;
                    }
                    if state_rx.changed().await.is_err() {
                        return;
                    }
                }
            }
        });
    }

    /// Resolves after the next change; wakeups that happen while nobody waits are kept.
    pub async fn changed(&self) {
        self.changed.notified().await;
    }

    fn touch(&self) {
        self.changed.notify_one();
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn connection_state(&self) -> ConnectionState {
        self.client.connection_state()
    }

    pub fn shell_state(&self) -> ShellState {
        self.shell.snapshot()
    }

    pub fn thread_state(&self) -> ThreadState {
        self.thread.snapshot()
    }

    pub fn server_config(&self) -> Option<ServerConfig> {
        self.config.lock().unwrap().clone()
    }

    pub fn server_settings(&self) -> Option<Value> {
        self.settings.lock().unwrap().clone()
    }

    pub fn archived_snapshot(&self) -> Option<ArchivedShellSnapshot> {
        self.archived_snapshot.lock().unwrap().clone()
    }

    pub fn peer_links(&self) -> Option<Vec<PeerLinkSummary>> {
        self.peer_links.lock().unwrap().clone()
    }

    pub fn plugins(&self) -> Option<Vec<PluginInfo>> {
        self.plugins.lock().unwrap().clone()
    }

    pub fn storage_cleanup_report(&self) -> Option<Option<StorageCleanupReport>> {
        self.storage_cleanup_report.lock().unwrap().clone()
    }

    pub fn database_storage(&self) -> Option<Option<DatabaseStorageStatus>> {
        self.database_storage.lock().unwrap().clone()
    }

    pub fn ensure_storage_subscribed(&self) {
        let mut slot = self.storage_tasks.lock().unwrap();
        if slot.is_some() {
            return;
        }
        let report_slot = self.storage_cleanup_report.clone();
        let changed_r = self.changed.clone();
        let notice_r = self.notice.clone();
        let report_task = self.rt.spawn(run_durable_stream(
            self.client.clone(),
            RPC_SERVER_GET_STORAGE_CLEANUP_REPORT,
            || serde_json::json!({}),
            move |report: Option<StorageCleanupReport>| {
                *report_slot.lock().unwrap() = Some(report);
                changed_r.notify_one();
            },
            move |err| {
                if is_user_visible(err) {
                    *notice_r.lock().unwrap() = Some(err.to_string());
                }
            },
        ));
        let db_slot = self.database_storage.clone();
        let changed_d = self.changed.clone();
        let notice_d = self.notice.clone();
        let db_task = self.rt.spawn(run_durable_stream(
            self.client.clone(),
            RPC_SERVER_GET_DATABASE_STORAGE,
            || serde_json::json!({}),
            move |status: Option<DatabaseStorageStatus>| {
                *db_slot.lock().unwrap() = Some(status);
                changed_d.notify_one();
            },
            move |err| {
                if is_user_visible(err) {
                    *notice_d.lock().unwrap() = Some(err.to_string());
                }
            },
        ));
        *slot = Some((report_task, db_task));
    }

    pub fn run_storage_cleanup(&self) {
        let client = self.client.clone();
        let report_slot = self.storage_cleanup_report.clone();
        self.run(
            "Storage cleanup",
            async move { client.run_storage_cleanup().await },
            move |report| *report_slot.lock().unwrap() = Some(Some(report)),
        );
    }

    pub fn reclaim_database_space(&self) {
        let client = self.client.clone();
        self.run(
            "Reclaim database space",
            async move { client.reclaim_database_space().await },
            |_| {},
        );
    }

    pub fn scheduled_tasks(&self) -> Option<ScheduledTaskListResult> {
        self.scheduled_tasks.lock().unwrap().clone()
    }

    pub fn ensure_scheduled_tasks_subscribed(&self) {
        let mut slot = self.scheduled_tasks_task.lock().unwrap();
        if slot.is_some() {
            return;
        }
        let tasks = self.scheduled_tasks.clone();
        let changed = self.changed.clone();
        let notice = self.notice.clone();
        *slot = Some(self.rt.spawn(run_durable_stream(
            self.client.clone(),
            RPC_SCHEDULED_TASKS_SUBSCRIBE,
            || serde_json::json!({}),
            move |snap: ScheduledTaskListResult| {
                *tasks.lock().unwrap() = Some(snap);
                changed.notify_one();
            },
            move |err| {
                if is_user_visible(err) {
                    *notice.lock().unwrap() = Some(err.to_string());
                }
            },
        )));
    }

    pub fn set_scheduled_task_enabled(&self, id: String, enabled: bool) {
        let client = self.client.clone();
        self.run(
            "Scheduled task",
            async move { client.set_scheduled_task_enabled(&id, enabled).await },
            |_| {},
        );
    }

    pub fn run_scheduled_task_now(&self, id: String) {
        let client = self.client.clone();
        self.run(
            "Run scheduled task",
            async move { client.run_scheduled_task_now(&id).await },
            |_| {},
        );
    }

    pub fn delete_scheduled_task(&self, id: String) {
        let client = self.client.clone();
        self.run(
            "Delete scheduled task",
            async move { client.delete_scheduled_task(&id).await },
            |_| {},
        );
    }

    pub fn host_resources(&self) -> Option<HostResourcesSnapshot> {
        self.host_resources.lock().unwrap().clone()
    }

    pub fn process_diagnostics(&self) -> Option<ServerProcessDiagnosticsResult> {
        self.process_diagnostics.lock().unwrap().clone()
    }

    pub fn trace_diagnostics(&self) -> Option<ServerTraceDiagnosticsResult> {
        self.trace_diagnostics.lock().unwrap().clone()
    }

    pub fn refresh_diagnostics(&self) {
        let c1 = self.client.clone();
        let hr = self.host_resources.clone();
        self.run(
            "Host resources",
            async move { c1.get_host_resources().await },
            move |snap| *hr.lock().unwrap() = Some(snap),
        );
        let c2 = self.client.clone();
        let pd = self.process_diagnostics.clone();
        self.run(
            "Process diagnostics",
            async move { c2.get_process_diagnostics().await },
            move |snap| *pd.lock().unwrap() = Some(snap),
        );
        let c3 = self.client.clone();
        let td = self.trace_diagnostics.clone();
        self.run(
            "Trace diagnostics",
            async move { c3.get_trace_diagnostics().await },
            move |snap| *td.lock().unwrap() = Some(snap),
        );
    }

    pub fn ensure_plugins_subscribed(&self) {
        let mut slot = self.plugins_task.lock().unwrap();
        if slot.is_some() {
            return;
        }
        let plugins = self.plugins.clone();
        let changed = self.changed.clone();
        let notice = self.notice.clone();
        *slot = Some(self.rt.spawn(run_durable_stream(
            self.client.clone(),
            RPC_PLUGINS_SUBSCRIBE,
            || serde_json::json!({}),
            move |snap: PluginsSnapshot| {
                *plugins.lock().unwrap() = Some(snap.plugins);
                changed.notify_one();
            },
            move |err| {
                if is_user_visible(err) {
                    *notice.lock().unwrap() = Some(err.to_string());
                }
            },
        )));
    }

    pub fn set_plugin_enabled(&self, plugin_id: String, enabled: bool) {
        let client = self.client.clone();
        let plugins = self.plugins.clone();
        self.run(
            "Plugins",
            async move { client.set_plugin_enabled(&plugin_id, enabled).await },
            move |snap| *plugins.lock().unwrap() = Some(snap.plugins),
        );
    }

    pub fn refresh_peer_links(&self) {
        let client = self.client.clone();
        let links = self.peer_links.clone();
        self.run(
            "Linked environments",
            async move { client.list_peer_links().await },
            move |res| *links.lock().unwrap() = Some(res.links),
        );
    }

    pub fn unlink_peer(&self, environment_id: String) {
        let client = self.client.clone();
        let links = self.peer_links.clone();
        self.run(
            "Unlink environment",
            async move {
                client.unlink_peer(&environment_id).await?;
                client.list_peer_links().await
            },
            move |res| *links.lock().unwrap() = Some(res.links),
        );
    }

    pub fn refresh_archived_threads(&self) {
        let client = self.client.clone();
        let archived = self.archived_snapshot.clone();
        self.run(
            "Archived threads",
            async move { client.get_archived_shell_snapshot().await },
            move |snap| *archived.lock().unwrap() = Some(snap),
        );
    }

    pub fn unarchive_thread(&self, thread_id: String) {
        let client = self.client.clone();
        let archived = self.archived_snapshot.clone();
        let cmd = OrchestrationCommand::ThreadUnarchive {
            command_id: Uuid::new_v4().to_string(),
            thread_id,
        };
        self.run(
            "Unarchive",
            async move {
                client.dispatch_command(&cmd).await?;
                client.get_archived_shell_snapshot().await
            },
            move |snap| *archived.lock().unwrap() = Some(snap),
        );
    }

    pub fn delete_thread(&self, thread_id: String) {
        let client = self.client.clone();
        let archived = self.archived_snapshot.clone();
        let cmd = OrchestrationCommand::ThreadDelete {
            command_id: Uuid::new_v4().to_string(),
            thread_id,
            only_if_unused: None,
        };
        self.run(
            "Delete thread",
            async move {
                client.dispatch_command(&cmd).await?;
                client.get_archived_shell_snapshot().await
            },
            move |snap| *archived.lock().unwrap() = Some(snap),
        );
    }

    pub fn notice(&self) -> Option<String> {
        self.notice.lock().unwrap().clone()
    }

    pub fn clear_notice(&self) {
        *self.notice.lock().unwrap() = None;
        self.touch();
    }

    pub fn reconnect_now(&self) {
        let client = self.client.clone();
        self.rt.spawn(async move { client.reconnect_now().await });
    }

    /// Runs a mutation once; its failure becomes the banner. Mutations are never retried.
    fn run<T: Send + 'static>(
        &self,
        label: &'static str,
        fut: impl Future<Output = Result<T, ClientError>> + Send + 'static,
        on_ok: impl FnOnce(T) + Send + 'static,
    ) {
        let notice = self.notice.clone();
        let changed = self.changed.clone();
        self.rt.spawn(async move {
            match fut.await {
                Ok(value) => on_ok(value),
                Err(err) => {
                    warn!(error = %err, "{label} failed");
                    *notice.lock().unwrap() = Some(format!("{label}: {err}"));
                }
            }
            changed.notify_one();
        });
    }

    fn dispatch(&self, label: &'static str, command: OrchestrationCommand) {
        let client = self.client.clone();
        self.run(
            label,
            async move { client.dispatch_command(&command).await },
            |_| {},
        );
    }

    pub fn select_thread(&self, thread_id: String) {
        let mut slot = self.thread_task.lock().unwrap();
        if let Some(prev) = slot.take() {
            prev.abort();
        }
        self.thread.reset(Some(thread_id.clone()));
        self.touch();

        let store = self.thread.clone();
        let apply_store = self.thread.clone();
        let changed = self.changed.clone();
        let notice = self.notice.clone();
        let payload_id = thread_id.clone();
        *slot = Some(self.rt.spawn(run_durable_stream(
            self.client.clone(),
            RPC_ORCHESTRATION_SUBSCRIBE_THREAD,
            move || SubscribeThreadInput {
                thread_id: payload_id.clone(),
                after_sequence: store.snapshot().resume_cursor(),
                request_completion_marker: None,
            },
            move |item: ThreadStreamItem| {
                if apply_store.apply_for(&thread_id, item) {
                    changed.notify_one();
                }
            },
            move |err| {
                if is_user_visible(err) {
                    *notice.lock().unwrap() = Some(err.to_string());
                }
            },
        )));
    }

    /// One read-only request, awaited from the UI; the caller decides how to show a failure.
    pub fn query<P, R>(
        &self,
        method: &'static str,
        input: P,
    ) -> impl Future<Output = Result<R, String>> + use<P, R>
    where
        P: serde::Serialize + Send + Sync + 'static,
        R: serde::de::DeserializeOwned + Send + 'static,
    {
        let client = self.client.clone();
        let task = self
            .rt
            .spawn(async move { client.request::<P, R>(method, &input).await });
        async move {
            match task.await {
                Ok(result) => result.map_err(|err| err.to_string()),
                Err(err) => Err(err.to_string()),
            }
        }
    }

    pub fn upload_attachment(
        &self,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<p0_protocol::ChatAttachment, String>> + use<> {
        let client = self.client.clone();
        let base_url = self.base_url.clone();
        let task = self.rt.spawn(async move {
            p0_client::attachments::upload_attachment(&client, &base_url, name, mime_type, bytes)
                .await
        });
        async move {
            match task.await {
                Ok(result) => result.map_err(|err| err.to_string()),
                Err(err) => Err(err.to_string()),
            }
        }
    }

    pub fn fetch_attachment_bytes(
        &self,
        attachment: p0_protocol::ChatAttachment,
    ) -> impl Future<Output = Result<Vec<u8>, String>> + use<> {
        let client = self.client.clone();
        let base_url = self.base_url.clone();
        let task = self.rt.spawn(async move {
            p0_client::attachments::fetch_attachment_bytes(&client, &base_url, &attachment).await
        });
        async move {
            match task.await {
                Ok(result) => result.map_err(|err| err.to_string()),
                Err(err) => Err(err.to_string()),
            }
        }
    }

    /// Closes the open thread's stream (New thread shows an empty feed).
    pub fn clear_thread(&self) {
        if let Some(prev) = self.thread_task.lock().unwrap().take() {
            prev.abort();
        }
        self.thread.reset(None);
        self.touch();
    }

    pub fn send_message(
        &self,
        thread_id: String,
        text: String,
        attachments: Vec<Value>,
        model_selection: Option<ModelSelection>,
        active_run_id: Option<String>,
    ) {
        self.dispatch(
            "Send",
            OrchestrationCommand::MessageDispatch {
                created_by: "user".to_owned(),
                creation_source: "web".to_owned(),
                command_id: Uuid::new_v4().to_string(),
                thread_id,
                message_id: Uuid::new_v4().to_string(),
                text,
                attachments,
                model_selection,
                dispatch_mode: if active_run_id.is_some() {
                    DispatchMode::QueueAfterActive
                } else {
                    DispatchMode::StartImmediately
                },
            },
        );
    }

    /// Starts a thread in `project_id`'s root checkout; `on_started` gets the new thread id.
    pub fn launch_thread(
        &self,
        project_id: String,
        model_selection: ModelSelection,
        runtime_mode: RuntimeMode,
        text: Option<String>,
        attachments: Vec<Value>,
        on_started: impl FnOnce(String) + Send + 'static,
    ) {
        let client = self.client.clone();
        let input = LaunchThreadInput {
            command_id: Uuid::new_v4().to_string(),
            project_id,
            title: "New thread".to_owned(),
            generate_title: Some(true),
            model_selection,
            runtime_mode,
            interaction_mode: Default::default(),
            workspace_strategy: WorkspaceStrategy::Root { branch: None },
            initial_message: text.map(|text| LaunchInitialMessage {
                message_id: Some(Uuid::new_v4().to_string()),
                text,
                attachments,
            }),
        };
        self.run(
            "New thread",
            async move { client.launch_thread(&input).await },
            move |result| on_started(result.thread_id),
        );
    }

    pub fn stop_thread(&self, thread_id: String, active_run_id: Option<String>) {
        let command_id = Uuid::new_v4().to_string();
        let command = match active_run_id {
            Some(run_id) => OrchestrationCommand::RunInterrupt {
                command_id,
                thread_id,
                run_id,
                reason: Some("user_stop".to_owned()),
            },
            None => OrchestrationCommand::ThreadStop {
                command_id,
                thread_id,
                reason: Some("user_stop".to_owned()),
            },
        };
        self.dispatch("Stop", command);
    }

    pub fn respond_approval(
        &self,
        thread_id: String,
        request_id: String,
        decision: ApprovalDecision,
    ) {
        self.dispatch(
            "Approval",
            OrchestrationCommand::RuntimeRequestRespond {
                command_id: Uuid::new_v4().to_string(),
                thread_id,
                request_id,
                decision: Some(decision),
                feedback: None,
                answers: None,
            },
        );
    }

    pub fn answer_user_input(
        &self,
        thread_id: String,
        request_id: String,
        answers: serde_json::Map<String, Value>,
    ) {
        self.dispatch(
            "Answer",
            OrchestrationCommand::RuntimeRequestRespond {
                command_id: Uuid::new_v4().to_string(),
                thread_id,
                request_id,
                decision: None,
                feedback: None,
                answers: Some(Value::Object(answers)),
            },
        );
    }

    /// The answer's plaintext lives only until the request is written to the socket.
    pub fn answer_secret_request(
        &self,
        thread_id: String,
        turn_item_id: String,
        answer: SecretRequestAnswer,
    ) {
        let client = self.client.clone();
        let input = SecretRequestAnswerInput {
            thread_id,
            turn_item_id,
            answer,
        };
        self.run(
            "Secret",
            async move {
                let result = client.answer_secret_request(&input).await;
                zeroize_answer(input.answer);
                result
            },
            |_| {},
        );
    }

    pub fn set_runtime_mode(&self, thread_id: String, runtime_mode: RuntimeMode) {
        self.dispatch(
            "Runtime mode",
            OrchestrationCommand::ThreadRuntimeModeSet {
                command_id: Uuid::new_v4().to_string(),
                thread_id,
                runtime_mode,
            },
        );
    }

    pub fn set_model_selection(&self, thread_id: String, model_selection: ModelSelection) {
        self.dispatch(
            "Model",
            OrchestrationCommand::ThreadModelSelectionSet {
                command_id: Uuid::new_v4().to_string(),
                thread_id,
                model_selection,
            },
        );
    }

    /// Patches server settings; the server's answer replaces the local copy.
    pub fn update_settings(&self, patch: Value) {
        let client = self.client.clone();
        let settings = self.settings.clone();
        self.run(
            "Settings",
            async move { client.update_settings(&patch).await },
            move |value| *settings.lock().unwrap() = Some(value),
        );
    }

    /// Patches server settings and re-fetches `server.getConfig` (for provider/model changes).
    pub fn update_settings_and_refresh_config(&self, patch: Value) {
        let client = self.client.clone();
        let settings = self.settings.clone();
        let config = self.config.clone();
        self.run(
            "Settings",
            async move {
                let updated = client.update_settings(&patch).await?;
                let cfg = client.get_config().await?;
                Ok((updated, cfg))
            },
            move |(updated, cfg)| {
                *settings.lock().unwrap() = Some(updated);
                *config.lock().unwrap() = Some(cfg);
            },
        );
    }

    pub fn refresh_providers(&self) {
        let client = self.client.clone();
        let config = self.config.clone();
        self.run(
            "Providers",
            async move {
                client.refresh_providers().await?;
                client.get_config().await
            },
            move |cfg| *config.lock().unwrap() = Some(cfg),
        );
    }

    pub fn upsert_keybinding(&self, input: ServerUpsertKeybindingInput) {
        let client = self.client.clone();
        let config = self.config.clone();
        self.run(
            "Keybindings",
            async move { client.upsert_keybinding(&input).await },
            move |res| {
                if let Some(cfg) = config.lock().unwrap().as_mut() {
                    cfg.keybindings = res.keybindings;
                    cfg.issues = res.issues;
                }
            },
        );
    }

    pub fn remove_keybinding(&self, input: ServerRemoveKeybindingInput) {
        let client = self.client.clone();
        let config = self.config.clone();
        self.run(
            "Keybindings",
            async move { client.remove_keybinding(&input).await },
            move |res| {
                if let Some(cfg) = config.lock().unwrap().as_mut() {
                    cfg.keybindings = res.keybindings;
                    cfg.issues = res.issues;
                }
            },
        );
    }

    /// Attaches the thread's default terminal (opening it in `cwd` when it is not running).
    pub fn attach_terminal(
        &self,
        thread_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> SharedTerminal {
        self.detach_terminal();
        let shared = crate::terminal::new_shared(cols, rows);
        let client = self.client.clone();
        let changed = self.changed.clone();
        let term = shared.clone();
        let input = TerminalAttachInput {
            thread_id: thread_id.clone(),
            terminal_id: DEFAULT_TERMINAL_ID.to_owned(),
            cwd: Some(cwd),
            cols: Some(cols),
            rows: Some(rows),
            ..TerminalAttachInput::default()
        };
        *self.terminal_task.lock().unwrap() = Some(self.rt.spawn(async move {
            let result = async {
                let mut sub = client
                    .subscribe::<_, TerminalAttachStreamEvent>(TERMINAL_ATTACH, &input)
                    .await?;
                while let Some(event) = sub.recv().await {
                    let reply = apply_event(&mut term.lock().unwrap(), event?);
                    changed.notify_one();
                    if !reply.is_empty() {
                        let write = TerminalWriteInput {
                            thread_id: input.thread_id.clone(),
                            terminal_id: input.terminal_id.clone(),
                            data: String::from_utf8_lossy(&reply).into_owned(),
                            reply: Some(true),
                            ..TerminalWriteInput::default()
                        };
                        client.request::<_, Value>(TERMINAL_WRITE, &write).await?;
                    }
                }
                Ok::<_, ClientError>(())
            }
            .await;
            if let Err(err) = result {
                term.lock().unwrap().status = Some(err.to_string());
                changed.notify_one();
            }
        }));
        shared
    }

    /// Hides the terminal; its session keeps running on the server.
    pub fn detach_terminal(&self) {
        if let Some(task) = self.terminal_task.lock().unwrap().take() {
            task.abort();
        }
    }

    pub fn terminal_write(&self, thread_id: String, data: String) {
        let client = self.client.clone();
        let input = TerminalWriteInput {
            thread_id,
            terminal_id: DEFAULT_TERMINAL_ID.to_owned(),
            data,
            ..TerminalWriteInput::default()
        };
        self.run(
            "Terminal",
            async move { client.request::<_, Value>(TERMINAL_WRITE, &input).await },
            |_| {},
        );
    }

    pub fn terminal_resize(&self, thread_id: String, cols: u16, rows: u16) {
        let client = self.client.clone();
        let input = TerminalResizeInput {
            thread_id,
            terminal_id: DEFAULT_TERMINAL_ID.to_owned(),
            cols,
            rows,
        };
        self.run(
            "Terminal",
            async move { client.request::<_, Value>(TERMINAL_RESIZE, &input).await },
            |_| {},
        );
    }

    /// Stops a `p0d` this app started. An attached one keeps running for its other clients.
    pub fn shutdown(&self) {
        let p0d = self.p0d.lock().unwrap().take();
        let client = self.client.clone();
        self.rt.block_on(async move {
            client.shutdown().await;
            if let Some(mut p0d) = p0d {
                p0d.shutdown().await;
            }
        });
    }

    /// `--smoke`: connect, probe, read config and the shell snapshot, print counts, exit.
    pub fn run_smoke(cli: &Cli) -> Result<(), ClientError> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        rt.block_on(async move {
            let started = std::time::Instant::now();
            let (base_url, auth, mut p0d) = resolve_connection(cli).await?;
            let spawned = p0d.as_ref().is_some_and(P0dProcess::spawned);
            let client = RpcClient::connect(ClientConfig::new(base_url.clone(), auth));
            let result = async {
                client.wait_connected(Duration::from_secs(20)).await?;
                let probe = client.probe().await?;
                info!(server_time = ?probe.server_time, "server.probe succeeded");
                let cfg = client.get_config().await?;
                let store = ShellStore::new();
                let mut shell = client
                    .subscribe_shell(SubscribeShellInput::default())
                    .await?;
                while !store.snapshot().synchronized {
                    let item = tokio::time::timeout(Duration::from_secs(60), shell.recv())
                        .await
                        .map_err(|_| ClientError::Timeout)?
                        .ok_or(ClientError::Closed)??;
                    store.apply(item);
                }
                let snap = store.snapshot();
                println!(
                    "p0-gpui smoke ok: url={base_url} p0d={} providers={} projects={} threads={} archived={} sequence={} elapsed_ms={}",
                    if spawned { "spawned" } else { "attached" },
                    cfg.providers.len(),
                    snap.projects.len(),
                    snap.threads.len(),
                    snap.archived_threads.len(),
                    snap.last_sequence,
                    started.elapsed().as_millis()
                );
                Ok(())
            }
            .await;
            client.shutdown().await;
            if let Some(p0d) = p0d.as_mut() {
                p0d.shutdown().await;
            }
            result
        })
    }
}

fn zeroize_answer(answer: SecretRequestAnswer) {
    use zeroize::Zeroize as _;
    match answer {
        SecretRequestAnswer::Save { mut secret } => secret.zeroize(),
        SecretRequestAnswer::SaveValues { values } => {
            for (_, mut value) in values {
                value.zeroize();
            }
        }
        SecretRequestAnswer::Decline => {}
    }
}

async fn resolve_connection(
    cli: &Cli,
) -> Result<(String, AuthMode, Option<P0dProcess>), ClientError> {
    let home = cli.resolved_home();
    let local_bootstrap = |secret: String| AuthMode::LocalBootstrap {
        secret,
        client_label: "p0code native".to_owned(),
    };
    if let Some(url) = &cli.url {
        let auth = match &cli.token {
            Some(token) => AuthMode::BearerToken(token.clone()),
            None => {
                read_desktop_secret_file(&home.join("secrets").join("desktop-bootstrap-secret"))
                    .map(local_bootstrap)
                    .ok_or_else(|| {
                        ClientError::Auth(
                            "--url needs --token or the desktop secret of the p0d serving it"
                                .to_owned(),
                        )
                    })?
            }
        };
        return Ok((url.clone(), auth, None));
    }

    let mut cfg = P0dLaunchConfig::for_home(&home);
    cfg.configured_binary = cli.p0d_bin.clone();
    cfg.legacy_server = cli
        .legacy_server
        .clone()
        .or_else(p0_client::p0d::default_legacy_server_command);
    let p0d = P0dProcess::attach_or_spawn(cfg).await?;
    let secret = p0d
        .bootstrap_secret()
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            ClientError::Auth(format!(
                "p0d at {} runs without a readable desktop secret in {}",
                p0d.url(),
                home.join("secrets").display()
            ))
        })?;
    Ok((p0d.url().to_owned(), local_bootstrap(secret), Some(p0d)))
}
