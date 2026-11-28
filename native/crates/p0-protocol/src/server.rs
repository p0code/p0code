//! Server probe, configuration, provider/model catalog, and mode wire types.
//!
//! Mirrors `packages/contracts/src/{server,modelSelection,providerPolicy}.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::{ExecutionEnvironmentDescriptor, ServerAuthDescriptor};

pub const RPC_SERVER_PROBE: &str = "server.probe";
pub const RPC_SERVER_GET_CONFIG: &str = "server.getConfig";
pub const RPC_SERVER_SUBSCRIBE_CONFIG: &str = "server.subscribeServerConfig";
pub const RPC_SERVER_GET_SETTINGS: &str = "server.getSettings";
pub const RPC_SERVER_UPDATE_SETTINGS: &str = "server.updateSettings";
pub const RPC_SERVER_REFRESH_PROVIDERS: &str = "server.refreshProviders";
pub const RPC_SERVER_UPSERT_KEYBINDING: &str = "server.upsertKeybinding";
pub const RPC_SERVER_REMOVE_KEYBINDING: &str = "server.removeKeybinding";
pub const RPC_PEER_LINKS_LIST: &str = "peerLinks.list";
pub const RPC_PEER_LINKS_UNLINK: &str = "peerLinks.unlink";
pub const RPC_PLUGINS_SUBSCRIBE: &str = "plugins.subscribe";
pub const RPC_PLUGINS_SET_ENABLED: &str = "plugins.setEnabled";
pub const RPC_SERVER_GET_STORAGE_CLEANUP_REPORT: &str = "server.getStorageCleanupReport";
pub const RPC_SERVER_RUN_STORAGE_CLEANUP: &str = "server.runStorageCleanup";
pub const RPC_SERVER_GET_DATABASE_STORAGE: &str = "server.getDatabaseStorage";
pub const RPC_SERVER_RECLAIM_DATABASE_SPACE: &str = "server.reclaimDatabaseSpace";
pub const RPC_SERVER_GET_HOST_RESOURCES: &str = "server.getHostResources";
pub const RPC_SERVER_GET_PROCESS_DIAGNOSTICS: &str = "server.getProcessDiagnostics";
pub const RPC_SERVER_GET_TRACE_DIAGNOSTICS: &str = "server.getTraceDiagnostics";
pub const RPC_SCHEDULED_TASKS_SUBSCRIBE: &str = "scheduledTasks.subscribe";
pub const RPC_SCHEDULED_TASKS_SET_ENABLED: &str = "scheduledTasks.setEnabled";
pub const RPC_SCHEDULED_TASKS_DELETE: &str = "scheduledTasks.delete";
pub const RPC_SCHEDULED_TASKS_RUN_NOW: &str = "scheduledTasks.runNow";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerProbeResult {
    #[serde(rename = "serverTime", default)]
    pub server_time: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    ApprovalRequired,
    AutoAcceptEdits,
    Auto,
    FullAccess,
    #[serde(other)]
    Unknown,
}

impl RuntimeMode {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::ApprovalRequired => "approval-required",
            Self::AutoAcceptEdits => "auto-accept-edits",
            Self::Auto => "auto",
            Self::FullAccess => "full-access",
            Self::Unknown => "approval-required",
        }
    }

    pub fn next_cycle(self) -> Self {
        match self {
            Self::ApprovalRequired => Self::AutoAcceptEdits,
            Self::AutoAcceptEdits => Self::Auto,
            Self::Auto => Self::FullAccess,
            Self::FullAccess | Self::Unknown => Self::ApprovalRequired,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderInteractionMode {
    #[default]
    Default,
    Plan,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelSelection {
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerProviderState {
    Ready,
    Warning,
    Error,
    Disabled,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerProviderAuth {
    pub status: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerProviderModel {
    pub slug: String,
    pub name: String,
    #[serde(rename = "shortName", default)]
    pub short_name: Option<String>,
    #[serde(rename = "subProvider", default)]
    pub sub_provider: Option<String>,
    #[serde(rename = "isCustom", default)]
    pub is_custom: bool,
    #[serde(rename = "isDefault", default)]
    pub is_default: Option<bool>,
    #[serde(rename = "isLegacy", default)]
    pub is_legacy: Option<bool>,
    #[serde(default)]
    pub capabilities: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerProvider {
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub driver: String,
    #[serde(rename = "displayName", default)]
    pub display_name: Option<String>,
    #[serde(rename = "accentColor", default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub version: Option<String>,
    pub status: ServerProviderState,
    #[serde(default)]
    pub auth: Option<ServerProviderAuth>,
    #[serde(rename = "checkedAt", default)]
    pub checked_at: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub availability: Option<String>,
    #[serde(rename = "supportedRuntimeModes", default)]
    pub supported_runtime_modes: Option<Vec<RuntimeMode>>,
    #[serde(default)]
    pub models: Vec<ServerProviderModel>,
}

impl ServerProvider {
    pub fn label(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.instance_id)
    }

    pub fn is_available(&self) -> bool {
        self.enabled && self.availability.as_deref() != Some("unavailable")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeybindingShortcut {
    pub key: String,
    #[serde(rename = "metaKey", default)]
    pub meta_key: bool,
    #[serde(rename = "ctrlKey", default)]
    pub ctrl_key: bool,
    #[serde(rename = "shiftKey", default)]
    pub shift_key: bool,
    #[serde(rename = "altKey", default)]
    pub alt_key: bool,
    #[serde(rename = "modKey", default)]
    pub mod_key: bool,
}

impl KeybindingShortcut {
    pub fn to_wire_key(&self) -> String {
        let mut parts: Vec<&str> = Vec::with_capacity(6);
        if self.mod_key {
            parts.push("mod");
        }
        if self.meta_key {
            parts.push("meta");
        }
        if self.ctrl_key {
            parts.push("ctrl");
        }
        if self.alt_key {
            parts.push("alt");
        }
        if self.shift_key {
            parts.push("shift");
        }
        let key = match self.key.as_str() {
            " " => "space",
            "escape" => "esc",
            other => other,
        };
        parts.push(key);
        parts.join("+")
    }

    pub fn display_label(&self) -> String {
        let mut parts: Vec<String> = Vec::with_capacity(6);
        if self.mod_key {
            parts.push(if cfg!(target_os = "macos") {
                "⌘".to_owned()
            } else {
                "Ctrl".to_owned()
            });
        }
        if self.meta_key {
            parts.push(if cfg!(target_os = "macos") {
                "⌘".to_owned()
            } else {
                "Super".to_owned()
            });
        }
        if self.ctrl_key {
            parts.push("Ctrl".to_owned());
        }
        if self.alt_key {
            parts.push(if cfg!(target_os = "macos") {
                "⌥".to_owned()
            } else {
                "Alt".to_owned()
            });
        }
        if self.shift_key {
            parts.push("Shift".to_owned());
        }
        let key_display = match self.key.as_str() {
            " " => "Space".to_owned(),
            "escape" | "esc" => "Esc".to_owned(),
            "enter" => "Enter".to_owned(),
            "arrowup" => "↑".to_owned(),
            "arrowdown" => "↓".to_owned(),
            "arrowleft" => "←".to_owned(),
            "arrowright" => "→".to_owned(),
            other if other.len() == 1 => other.to_ascii_uppercase(),
            other => other.to_owned(),
        };
        parts.push(key_display);
        parts.join("+")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum KeybindingWhenNode {
    #[serde(rename = "identifier")]
    Identifier { name: String },
    #[serde(rename = "not")]
    Not { node: Box<KeybindingWhenNode> },
    #[serde(rename = "and")]
    And {
        left: Box<KeybindingWhenNode>,
        right: Box<KeybindingWhenNode>,
    },
    #[serde(rename = "or")]
    Or {
        left: Box<KeybindingWhenNode>,
        right: Box<KeybindingWhenNode>,
    },
    #[serde(other)]
    Unknown,
}

impl KeybindingWhenNode {
    pub fn to_expression(&self) -> String {
        fn wrap(node: &KeybindingWhenNode) -> String {
            match node {
                KeybindingWhenNode::Identifier { .. }
                | KeybindingWhenNode::Not { .. }
                | KeybindingWhenNode::Unknown => node.to_expression(),
                KeybindingWhenNode::And { .. } | KeybindingWhenNode::Or { .. } => {
                    format!("({})", node.to_expression())
                }
            }
        }
        match self {
            Self::Identifier { name } => name.clone(),
            Self::Not { node } => format!("!{}", wrap(node)),
            Self::And { left, right } => format!("{} && {}", wrap(left), wrap(right)),
            Self::Or { left, right } => format!("{} || {}", wrap(left), wrap(right)),
            Self::Unknown => String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedKeybindingRule {
    pub command: String,
    pub shortcut: KeybindingShortcut,
    #[serde(rename = "whenAst", default, skip_serializing_if = "Option::is_none")]
    pub when_ast: Option<KeybindingWhenNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeybindingReplaceTarget {
    pub key: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerUpsertKeybindingInput {
    pub key: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<KeybindingReplaceTarget>,
}

pub type ServerRemoveKeybindingInput = KeybindingReplaceTarget;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerKeybindingMutationResult {
    #[serde(default)]
    pub keybindings: Vec<ResolvedKeybindingRule>,
    #[serde(default)]
    pub issues: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerDirectEndpoint {
    #[serde(rename = "httpBaseUrl", alias = "url")]
    pub url: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerLinkSummary {
    #[serde(rename = "environmentId")]
    pub environment_id: String,
    pub label: String,
    #[serde(default)]
    pub urls: Vec<String>,
    pub access: String,
    pub status: String,
    #[serde(rename = "linkedAt", default)]
    pub linked_at: Option<String>,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<String>,
    #[serde(rename = "lastReachedAt", default)]
    pub last_reached_at: Option<String>,
    #[serde(rename = "lastError", default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerLinksListResult {
    #[serde(default)]
    pub links: Vec<PeerLinkSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerLinkRemoveResult {
    pub removed: bool,
    #[serde(rename = "endedThere", default)]
    pub ended_there: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    #[serde(default)]
    pub unofficial: bool,
    #[serde(rename = "externalServices", default)]
    pub external_services: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub origin: String,
    pub enabled: bool,
    pub state: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginsSnapshot {
    #[serde(default)]
    pub plugins: Vec<PluginInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DatabaseStorageStatus {
    #[serde(rename = "databaseBytes")]
    pub database_bytes: f64,
    #[serde(rename = "reclaimableBytes")]
    pub reclaimable_bytes: f64,
    #[serde(rename = "incrementalVacuumEnabled")]
    pub incremental_vacuum_enabled: bool,
    #[serde(rename = "compactCommand")]
    pub compact_command: String,
    #[serde(rename = "canReclaim", default)]
    pub can_reclaim: Option<bool>,
    #[serde(rename = "reclaimFailure", default)]
    pub reclaim_failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageCleanupReportCounts {
    pub removed: u64,
    pub kept: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageCleanupReportEntry {
    pub kind: String,
    pub outcome: String,
    pub reason: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(rename = "projectPath", default)]
    pub project_path: Option<String>,
    #[serde(rename = "threadId", default)]
    pub thread_id: Option<String>,
    #[serde(rename = "threadTitle", default)]
    pub thread_title: Option<String>,
    #[serde(default)]
    pub bytes: Option<f64>,
    #[serde(default)]
    pub files: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageCleanupReport {
    pub trigger: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: String,
    #[serde(default)]
    pub entries: Vec<StorageCleanupReportEntry>,
    pub counts: StorageCleanupReportCounts,
    #[serde(rename = "omittedCount", default)]
    pub omitted_count: u64,
    #[serde(rename = "bytesFreed", default)]
    pub bytes_freed: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub enabled: bool,
    #[serde(default)]
    pub schedule: Value,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "threadId", default)]
    pub thread_id: Option<String>,
    #[serde(rename = "nextRunAt", default)]
    pub next_run_at: Option<String>,
    #[serde(rename = "lastRunAt", default)]
    pub last_run_at: Option<String>,
    #[serde(rename = "lastRunStatus", default)]
    pub last_run_status: String,
    #[serde(rename = "lastRunError", default)]
    pub last_run_error: Option<String>,
    #[serde(rename = "runCount", default)]
    pub run_count: u64,
    #[serde(rename = "blockedByPolicy", default)]
    pub blocked_by_policy: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduledTaskListResult {
    #[serde(default)]
    pub tasks: Vec<ScheduledTask>,
    #[serde(rename = "timeZone", default)]
    pub time_zone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostResourcesSnapshot {
    #[serde(rename = "sampledAt")]
    pub sampled_at: u64,
    #[serde(rename = "cpuUtilization", default)]
    pub cpu_utilization: Option<f64>,
    #[serde(rename = "cpuCount")]
    pub cpu_count: u64,
    #[serde(rename = "availableMemoryBytes")]
    pub available_memory_bytes: f64,
    #[serde(rename = "totalMemoryBytes")]
    pub total_memory_bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerProcessDiagnosticsEntry {
    pub pid: u64,
    #[serde(rename = "startTimeMs", default)]
    pub start_time_ms: u64,
    #[serde(default)]
    pub ppid: u64,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "cpuPercent", default)]
    pub cpu_percent: f64,
    #[serde(rename = "rssBytes", default)]
    pub rss_bytes: f64,
    #[serde(default)]
    pub elapsed: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub depth: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerProcessDiagnosticsResult {
    #[serde(rename = "serverPid")]
    pub server_pid: u64,
    #[serde(rename = "readAt")]
    pub read_at: String,
    #[serde(rename = "processCount", default)]
    pub process_count: u64,
    #[serde(rename = "totalRssBytes", default)]
    pub total_rss_bytes: f64,
    #[serde(rename = "totalCpuPercent", default)]
    pub total_cpu_percent: f64,
    #[serde(default)]
    pub processes: Vec<ServerProcessDiagnosticsEntry>,
    #[serde(default)]
    pub error: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerTraceDiagnosticsResult {
    #[serde(rename = "traceFilePath")]
    pub trace_file_path: String,
    #[serde(rename = "readAt")]
    pub read_at: String,
    #[serde(rename = "recordCount", default)]
    pub record_count: u64,
    #[serde(rename = "parseErrorCount", default)]
    pub parse_error_count: u64,
    #[serde(rename = "failureCount", default)]
    pub failure_count: u64,
    #[serde(rename = "interruptionCount", default)]
    pub interruption_count: u64,
    #[serde(rename = "slowSpanThresholdMs", default)]
    pub slow_span_threshold_ms: u64,
    #[serde(rename = "slowSpanCount", default)]
    pub slow_span_count: u64,
    #[serde(default)]
    pub error: Option<Value>,
}

/// Subset of `ServerConfig` returned by `server.getConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerConfig {
    pub environment: ExecutionEnvironmentDescriptor,
    pub auth: ServerAuthDescriptor,
    pub cwd: String,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(rename = "directEndpoints", default)]
    pub direct_endpoints: Vec<ServerDirectEndpoint>,
    #[serde(rename = "keybindingsConfigPath", default)]
    pub keybindings_config_path: Option<String>,
    #[serde(default)]
    pub keybindings: Vec<ResolvedKeybindingRule>,
    #[serde(default)]
    pub issues: Vec<Value>,
    #[serde(default)]
    pub providers: Vec<ServerProvider>,
    #[serde(rename = "serverTime", default)]
    pub server_time: Option<String>,
    #[serde(default)]
    pub settings: Value,
}
