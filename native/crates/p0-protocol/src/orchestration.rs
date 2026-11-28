//! Orchestration V2 shell, thread projection, turn item, domain event, and command types.
//!
//! Mirrors `packages/contracts/src/orchestrationV2.ts` and `orchestrationProject.ts`.
//! Every tagged enum includes an `#[serde(other)] Unknown` arm so newly added server
//! variants never crash older native clients.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::server::{ModelSelection, ProviderInteractionMode, RuntimeMode};
use crate::workspace::ChatAttachment;

pub const RPC_ORCHESTRATION_DISPATCH_COMMAND: &str = "orchestration.dispatchCommand";
pub const RPC_ORCHESTRATION_LAUNCH_THREAD: &str = "orchestration.launchThread";
pub const RPC_ORCHESTRATION_FORCE_STOP_THREAD: &str = "orchestration.forceStopThread";
pub const RPC_ORCHESTRATION_GET_TURN_ITEM: &str = "orchestration.getTurnItem";
pub const RPC_ORCHESTRATION_GET_ARCHIVED_SHELL_SNAPSHOT: &str =
    "orchestration.getArchivedShellSnapshot";
pub const RPC_ORCHESTRATION_SUBSCRIBE_SHELL: &str = "orchestration.subscribeShell";
pub const RPC_ORCHESTRATION_SUBSCRIBE_THREAD: &str = "orchestration.subscribeThread";
pub const RPC_SECRETS_ANSWER_REQUEST: &str = "secrets.answerRequest";

// ---------------------------------------------------------------------------
// Shell snapshot & stream
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscribeShellInput {
    #[serde(rename = "afterSequence", skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    #[serde(
        rename = "httpSnapshotFallback",
        skip_serializing_if = "Option::is_none"
    )]
    pub http_snapshot_fallback: Option<bool>,
    #[serde(
        rename = "requestCompletionMarker",
        skip_serializing_if = "Option::is_none"
    )]
    pub request_completion_marker: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectShell {
    pub id: String,
    pub title: String,
    #[serde(rename = "workspaceRoot")]
    pub workspace_root: String,
    #[serde(rename = "defaultModelSelection", default)]
    pub default_model_selection: Option<ModelSelection>,
    #[serde(rename = "defaultThreadEnvMode", default)]
    pub default_thread_env_mode: Option<String>,
    #[serde(rename = "pinnedAt", default)]
    pub pinned_at: Option<String>,
    #[serde(rename = "archivedAt", default)]
    pub archived_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Idle,
    Preparing,
    Queued,
    Starting,
    Running,
    Waiting,
    Completed,
    Interrupted,
    Failed,
    Cancelled,
    RolledBack,
    #[serde(other)]
    Unknown,
}

impl ThreadStatus {
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Queued | Self::Starting | Self::Running | Self::Waiting
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRuntimeRequestSummary {
    pub id: String,
    pub kind: RuntimeRequestKind,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(default)]
    pub blocking: Option<bool>,
    #[serde(rename = "userOnly", default)]
    pub user_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatestVisibleMessageSummary {
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadShell {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub title: String,
    #[serde(rename = "providerInstanceId")]
    pub provider_instance_id: String,
    #[serde(rename = "modelSelection")]
    pub model_selection: ModelSelection,
    #[serde(rename = "runtimeMode")]
    pub runtime_mode: RuntimeMode,
    #[serde(rename = "interactionMode")]
    pub interaction_mode: ProviderInteractionMode,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(rename = "worktreePath", default)]
    pub worktree_path: Option<String>,
    #[serde(rename = "latestRunId", default)]
    pub latest_run_id: Option<String>,
    #[serde(rename = "activeRunId", default)]
    pub active_run_id: Option<String>,
    pub status: ThreadStatus,
    #[serde(rename = "lastError", default)]
    pub last_error: Option<String>,
    #[serde(rename = "pendingRuntimeRequest", default)]
    pub pending_runtime_request: Option<PendingRuntimeRequestSummary>,
    #[serde(rename = "latestVisibleMessage", default)]
    pub latest_visible_message: Option<LatestVisibleMessageSummary>,
    #[serde(rename = "hasActionableProposedPlan", default)]
    pub has_actionable_proposed_plan: bool,
    #[serde(rename = "itemCount", default)]
    pub item_count: u64,
    #[serde(rename = "visibleItemCount", default)]
    pub visible_item_count: u64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "archivedAt", default)]
    pub archived_at: Option<String>,
    #[serde(rename = "settledOverride", default)]
    pub settled_override: Option<String>,
    #[serde(rename = "settledAt", default)]
    pub settled_at: Option<String>,
    #[serde(rename = "snoozedUntil", default)]
    pub snoozed_until: Option<String>,
    #[serde(rename = "pinnedAt", default)]
    pub pinned_at: Option<String>,
    #[serde(rename = "lastVisitedAt", default)]
    pub last_visited_at: Option<String>,
    #[serde(rename = "deletedAt", default)]
    pub deleted_at: Option<String>,
    #[serde(rename = "latestUserMessageAt", default)]
    pub latest_user_message_at: Option<String>,
    #[serde(rename = "latestRunRequestedAt", default)]
    pub latest_run_requested_at: Option<String>,
    #[serde(rename = "latestRunStartedAt", default)]
    pub latest_run_started_at: Option<String>,
    #[serde(rename = "latestRunCompletedAt", default)]
    pub latest_run_completed_at: Option<String>,
}

impl ThreadShell {
    /// When the thread last saw activity, as the web sidebar shows and sorts it
    /// (`resolveThreadActivityTimestamp`): the latest user message or run event, else `updatedAt`.
    /// Timestamps are the server's UTC ISO strings, so they compare as text.
    pub fn activity_timestamp(&self) -> &str {
        [
            &self.latest_user_message_at,
            &self.latest_run_requested_at,
            &self.latest_run_started_at,
            &self.latest_run_completed_at,
        ]
        .into_iter()
        .flatten()
        .map(String::as_str)
        .max()
        .unwrap_or(&self.updated_at)
    }

    /// Heuristic unread check: thread updated after last visit (or never visited with activity).
    pub fn is_unread(&self) -> bool {
        if self.pending_runtime_request.is_some() {
            return true;
        }
        let Some(latest_msg) = &self.latest_visible_message else {
            return false;
        };
        if latest_msg.role != MessageRole::Assistant {
            return false;
        }
        match &self.last_visited_at {
            Some(visited) => latest_msg.updated_at > *visited,
            None => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShellSnapshot {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "snapshotSequence")]
    pub snapshot_sequence: u64,
    #[serde(default)]
    pub projects: Vec<ProjectShell>,
    #[serde(default)]
    pub threads: Vec<ThreadShell>,
    #[serde(rename = "archivedThreads", default)]
    pub archived_threads: Vec<ThreadShell>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchivedShellSnapshot {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "snapshotSequence")]
    pub snapshot_sequence: u64,
    #[serde(default)]
    pub projects: Vec<ProjectShell>,
    #[serde(default)]
    pub threads: Vec<ThreadShell>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellThreadLocation {
    Active,
    Archive,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ShellStreamItem {
    #[serde(rename = "synchronized")]
    Synchronized,
    #[serde(rename = "snapshot-required")]
    SnapshotRequired,
    /// Authoritative unless `resolved_repository_identity_roots` is set: then it only refreshes
    /// the projects at those roots and carries no threads (`ShellStream.ts`).
    #[serde(rename = "snapshot")]
    Snapshot {
        snapshot: ShellSnapshot,
        #[serde(
            rename = "resolvedRepositoryIdentityRoots",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        resolved_repository_identity_roots: Option<Vec<String>>,
    },
    #[serde(rename = "project.updated")]
    ProjectUpdated {
        sequence: u64,
        project: Box<ProjectShell>,
    },
    #[serde(rename = "project.removed")]
    ProjectRemoved {
        sequence: u64,
        #[serde(rename = "projectId")]
        project_id: String,
    },
    #[serde(rename = "thread.updated")]
    ThreadUpdated {
        sequence: u64,
        location: ShellThreadLocation,
        thread: Box<ThreadShell>,
    },
    #[serde(rename = "thread.removed")]
    ThreadRemoved {
        sequence: u64,
        location: ShellThreadLocation,
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(other)]
    Unknown,
}

impl ShellStreamItem {
    /// The event sequence of a delta; `None` for snapshots and markers.
    pub fn sequence(&self) -> Option<u64> {
        match self {
            Self::ProjectUpdated { sequence, .. }
            | Self::ProjectRemoved { sequence, .. }
            | Self::ThreadUpdated { sequence, .. }
            | Self::ThreadRemoved { sequence, .. } => Some(*sequence),
            Self::Synchronized | Self::SnapshotRequired | Self::Snapshot { .. } | Self::Unknown => {
                None
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Thread projection, turn items, approvals, and stream
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscribeThreadInput {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "afterSequence", skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    #[serde(
        rename = "requestCompletionMarker",
        skip_serializing_if = "Option::is_none"
    )]
    pub request_completion_marker: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderRequestKind {
    Command,
    FileRead,
    FileChange,
    McpElicitation,
    Permission,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeRequestKind {
    #[serde(rename = "command")]
    Command,
    #[serde(rename = "file-read")]
    FileRead,
    #[serde(rename = "file-change")]
    FileChange,
    #[serde(rename = "mcp-elicitation")]
    McpElicitation,
    #[serde(rename = "permission")]
    Permission,
    #[serde(rename = "dynamic_tool_call")]
    DynamicToolCall,
    #[serde(rename = "user_input")]
    UserInput,
    #[serde(rename = "auth_refresh")]
    AuthRefresh,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeRequestStatus {
    Pending,
    Resolved,
    Expired,
    Cancelled,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalDecision {
    #[serde(rename = "accept")]
    Accept,
    #[serde(rename = "acceptForSession")]
    AcceptForSession,
    #[serde(rename = "acceptAlways")]
    AcceptAlways,
    #[serde(rename = "decline")]
    Decline,
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalOption {
    pub decision: ApprovalDecision,
    pub label: String,
    #[serde(default)]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInputOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<UserInputOption>,
    #[serde(rename = "multiSelect", default)]
    pub multi_select: Option<bool>,
    #[serde(rename = "allowCustomAnswer", default)]
    pub allow_custom_answer: Option<bool>,
    #[serde(rename = "initialAnswer", default)]
    pub initial_answer: Option<String>,
    #[serde(default)]
    pub required: Option<bool>,
}

/// One input of a multi-value secret card; `secret: false` shows what the user types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretRequestField {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub secret: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretRequestStatus {
    Pending,
    Saved,
    Declined,
    Cancelled,
    #[serde(other)]
    Unknown,
}

/// An answer to a `secret_request` card (`packages/contracts/src/secretRequest.ts`). `Debug`
/// never prints a value; callers keep the plaintext in `zeroize::Zeroizing` until it is sent.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum SecretRequestAnswer {
    #[serde(rename = "save")]
    Save { secret: String },
    /// A card with `fields`: one value per field name.
    #[serde(rename = "save")]
    SaveValues {
        values: std::collections::BTreeMap<String, String>,
    },
    #[serde(rename = "decline")]
    Decline,
}

impl std::fmt::Debug for SecretRequestAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Save { .. } => f.write_str("Save(<redacted>)"),
            Self::SaveValues { values } => {
                write!(
                    f,
                    "SaveValues({:?}: <redacted>)",
                    values.keys().collect::<Vec<_>>()
                )
            }
            Self::Decline => f.write_str("Decline"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecretRequestAnswerInput {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "turnItemId")]
    pub turn_item_id: String,
    pub answer: SecretRequestAnswer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeRequest {
    pub id: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "providerTurnId", default)]
    pub provider_turn_id: Option<String>,
    pub kind: RuntimeRequestKind,
    pub status: RuntimeRequestStatus,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "resolvedAt", default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub decision: Option<ApprovalDecision>,
    #[serde(default)]
    pub feedback: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppThread {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub title: String,
    #[serde(rename = "providerInstanceId")]
    pub provider_instance_id: String,
    #[serde(rename = "modelSelection")]
    pub model_selection: ModelSelection,
    #[serde(rename = "runtimeMode")]
    pub runtime_mode: RuntimeMode,
    #[serde(rename = "interactionMode")]
    pub interaction_mode: ProviderInteractionMode,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(rename = "worktreePath", default)]
    pub worktree_path: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "archivedAt", default)]
    pub archived_at: Option<String>,
    #[serde(rename = "settledAt", default)]
    pub settled_at: Option<String>,
    #[serde(rename = "lastVisitedAt", default)]
    pub last_visited_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestrationRun {
    pub id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub ordinal: u64,
    #[serde(rename = "providerInstanceId")]
    pub provider_instance_id: String,
    #[serde(rename = "modelSelection")]
    pub model_selection: ModelSelection,
    pub status: ThreadStatus,
    #[serde(rename = "requestedAt")]
    pub requested_at: String,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<String>,
    #[serde(rename = "completedAt", default)]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "runId", default)]
    pub run_id: Option<String>,
    pub role: MessageRole,
    pub text: String,
    #[serde(default)]
    pub streaming: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanStep {
    pub id: String,
    pub text: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum PlanArtifact {
    #[serde(rename = "proposed_plan")]
    ProposedPlan {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        status: String,
        markdown: String,
    },
    #[serde(rename = "todo_list")]
    TodoList {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        status: String,
        #[serde(default)]
        steps: Vec<PlanStep>,
        #[serde(default)]
        explanation: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnItemStatus {
    Idle,
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderFailure {
    pub class: String,
    pub message: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub retryable: Option<bool>,
}

/// Forward-compatible tagged union of `OrchestrationV2TurnItem`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TurnItem {
    #[serde(rename = "user_message")]
    UserMessage {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "messageId")]
        message_id: String,
        text: String,
        #[serde(default)]
        attachments: Vec<ChatAttachment>,
    },
    #[serde(rename = "assistant_message")]
    AssistantMessage {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "messageId")]
        message_id: String,
        text: String,
        #[serde(default)]
        streaming: bool,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        text: String,
        #[serde(default)]
        streaming: bool,
    },
    #[serde(rename = "proposed_plan")]
    ProposedPlan {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "planId")]
        plan_id: String,
        markdown: String,
        #[serde(default)]
        streaming: bool,
    },
    #[serde(rename = "todo_list")]
    TodoList {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "planId")]
        plan_id: String,
        #[serde(default)]
        steps: Vec<PlanStep>,
        #[serde(default)]
        explanation: Option<String>,
    },
    #[serde(rename = "command_execution")]
    CommandExecution {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        input: String,
        #[serde(default)]
        output: Option<String>,
        #[serde(rename = "exitCode", default)]
        exit_code: Option<i64>,
    },
    #[serde(rename = "file_change")]
    FileChange {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "fileName")]
        file_name: String,
        #[serde(default)]
        additions: Option<u64>,
        #[serde(default)]
        deletions: Option<u64>,
        #[serde(rename = "diffStr", default)]
        diff_str: Option<String>,
    },
    #[serde(rename = "file_search")]
    FileSearch {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(default)]
        pattern: Option<String>,
    },
    #[serde(rename = "web_search")]
    WebSearch {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(default)]
        patterns: Option<Vec<String>>,
    },
    #[serde(rename = "dynamic_tool")]
    DynamicTool {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "toolName", default)]
        tool_name: Option<String>,
        #[serde(default)]
        input: Value,
        #[serde(default)]
        output: Option<Value>,
    },
    #[serde(rename = "approval_request")]
    ApprovalRequest {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "requestKind")]
        request_kind: ProviderRequestKind,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        options: Option<Vec<ApprovalOption>>,
    },
    #[serde(rename = "user_input_request")]
    UserInputRequest {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(default)]
        questions: Vec<UserInputQuestion>,
    },
    #[serde(rename = "secret_request")]
    SecretRequest {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        label: String,
        reason: String,
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        placeholder: Option<String>,
        #[serde(default)]
        fields: Option<Vec<SecretRequestField>>,
        #[serde(rename = "secretStatus")]
        secret_status: SecretRequestStatus,
    },
    #[serde(rename = "system_notice")]
    SystemNotice {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        message: String,
        #[serde(default)]
        level: Option<String>,
    },
    #[serde(rename = "error")]
    Error {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        failure: ProviderFailure,
    },
    #[serde(rename = "notification")]
    Notification {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        summary: String,
        #[serde(default)]
        detail: Option<String>,
    },
    #[serde(rename = "subagent")]
    Subagent {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId", default)]
        run_id: Option<String>,
        ordinal: u64,
        status: TurnItemStatus,
        #[serde(default)]
        title: Option<String>,
        #[serde(rename = "updatedAt")]
        updated_at: String,
        #[serde(rename = "subagentId")]
        subagent_id: String,
        #[serde(default)]
        prompt: String,
        #[serde(default)]
        result: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

impl TurnItem {
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::UserMessage { id, .. }
            | Self::AssistantMessage { id, .. }
            | Self::Reasoning { id, .. }
            | Self::ProposedPlan { id, .. }
            | Self::TodoList { id, .. }
            | Self::CommandExecution { id, .. }
            | Self::FileChange { id, .. }
            | Self::FileSearch { id, .. }
            | Self::WebSearch { id, .. }
            | Self::DynamicTool { id, .. }
            | Self::ApprovalRequest { id, .. }
            | Self::UserInputRequest { id, .. }
            | Self::SecretRequest { id, .. }
            | Self::SystemNotice { id, .. }
            | Self::Error { id, .. }
            | Self::Notification { id, .. }
            | Self::Subagent { id, .. } => Some(id.as_str()),
            Self::Unknown => None,
        }
    }

    pub fn thread_id(&self) -> Option<&str> {
        match self {
            Self::UserMessage { thread_id, .. }
            | Self::AssistantMessage { thread_id, .. }
            | Self::Reasoning { thread_id, .. }
            | Self::ProposedPlan { thread_id, .. }
            | Self::TodoList { thread_id, .. }
            | Self::CommandExecution { thread_id, .. }
            | Self::FileChange { thread_id, .. }
            | Self::FileSearch { thread_id, .. }
            | Self::WebSearch { thread_id, .. }
            | Self::DynamicTool { thread_id, .. }
            | Self::ApprovalRequest { thread_id, .. }
            | Self::UserInputRequest { thread_id, .. }
            | Self::SecretRequest { thread_id, .. }
            | Self::SystemNotice { thread_id, .. }
            | Self::Error { thread_id, .. }
            | Self::Notification { thread_id, .. }
            | Self::Subagent { thread_id, .. } => Some(thread_id.as_str()),
            Self::Unknown => None,
        }
    }

    pub fn ordinal(&self) -> u64 {
        match self {
            Self::UserMessage { ordinal, .. }
            | Self::AssistantMessage { ordinal, .. }
            | Self::Reasoning { ordinal, .. }
            | Self::ProposedPlan { ordinal, .. }
            | Self::TodoList { ordinal, .. }
            | Self::CommandExecution { ordinal, .. }
            | Self::FileChange { ordinal, .. }
            | Self::FileSearch { ordinal, .. }
            | Self::WebSearch { ordinal, .. }
            | Self::DynamicTool { ordinal, .. }
            | Self::ApprovalRequest { ordinal, .. }
            | Self::UserInputRequest { ordinal, .. }
            | Self::SecretRequest { ordinal, .. }
            | Self::SystemNotice { ordinal, .. }
            | Self::Error { ordinal, .. }
            | Self::Notification { ordinal, .. }
            | Self::Subagent { ordinal, .. } => *ordinal,
            Self::Unknown => u64::MAX,
        }
    }

    pub fn updated_at(&self) -> &str {
        match self {
            Self::UserMessage { updated_at, .. }
            | Self::AssistantMessage { updated_at, .. }
            | Self::Reasoning { updated_at, .. }
            | Self::ProposedPlan { updated_at, .. }
            | Self::TodoList { updated_at, .. }
            | Self::CommandExecution { updated_at, .. }
            | Self::FileChange { updated_at, .. }
            | Self::FileSearch { updated_at, .. }
            | Self::WebSearch { updated_at, .. }
            | Self::DynamicTool { updated_at, .. }
            | Self::ApprovalRequest { updated_at, .. }
            | Self::UserInputRequest { updated_at, .. }
            | Self::SecretRequest { updated_at, .. }
            | Self::SystemNotice { updated_at, .. }
            | Self::Error { updated_at, .. }
            | Self::Notification { updated_at, .. }
            | Self::Subagent { updated_at, .. } => updated_at.as_str(),
            Self::Unknown => "",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectedTurnItem {
    pub position: u64,
    pub visibility: String,
    #[serde(rename = "sourceThreadId")]
    pub source_thread_id: String,
    #[serde(rename = "sourceItemId")]
    pub source_item_id: String,
    pub item: TurnItem,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadProjection {
    pub thread: AppThread,
    #[serde(default)]
    pub runs: Vec<OrchestrationRun>,
    #[serde(rename = "runtimeRequests", default)]
    pub runtime_requests: Vec<RuntimeRequest>,
    #[serde(default)]
    pub messages: Vec<ConversationMessage>,
    #[serde(default)]
    pub plans: Vec<PlanArtifact>,
    #[serde(rename = "turnItems", default)]
    pub turn_items: Vec<TurnItem>,
    #[serde(rename = "visibleTurnItems", default)]
    pub visible_turn_items: Vec<ProjectedTurnItem>,
    #[serde(default)]
    pub checkpoints: Vec<crate::checkpoint::Checkpoint>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DomainEvent {
    #[serde(
        rename = "thread.created",
        alias = "thread.archived",
        alias = "thread.unarchived",
        alias = "thread.deleted",
        alias = "thread.settled",
        alias = "thread.unsettled",
        alias = "thread.snoozed",
        alias = "thread.unsnoozed",
        alias = "thread.pinned",
        alias = "thread.unpinned",
        alias = "thread.visited",
        alias = "thread.marked-unread",
        alias = "thread.metadata-updated",
        alias = "thread.runtime-mode-updated",
        alias = "thread.interaction-mode-updated",
        alias = "thread.model-selection-updated",
        alias = "thread.provider-switched"
    )]
    ThreadUpdated {
        #[serde(rename = "occurredAt")]
        occurred_at: String,
        payload: AppThread,
    },
    #[serde(rename = "run.created", alias = "run.updated")]
    RunUpdated {
        #[serde(rename = "occurredAt")]
        occurred_at: String,
        payload: OrchestrationRun,
    },
    #[serde(rename = "runtime-request.updated")]
    RuntimeRequestUpdated {
        #[serde(rename = "occurredAt")]
        occurred_at: String,
        payload: RuntimeRequest,
    },
    #[serde(rename = "message.updated")]
    MessageUpdated {
        #[serde(rename = "occurredAt")]
        occurred_at: String,
        payload: ConversationMessage,
    },
    #[serde(rename = "turn-item.updated")]
    TurnItemUpdated {
        #[serde(rename = "occurredAt")]
        occurred_at: String,
        payload: TurnItem,
    },
    #[serde(rename = "plan.updated")]
    PlanUpdated {
        #[serde(rename = "occurredAt")]
        occurred_at: String,
        payload: PlanArtifact,
    },
    #[serde(rename = "checkpoint.captured")]
    CheckpointCaptured {
        #[serde(rename = "occurredAt")]
        occurred_at: String,
        payload: crate::checkpoint::Checkpoint,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ThreadStreamItem {
    #[serde(rename = "synchronized")]
    Synchronized,
    #[serde(rename = "snapshot")]
    Snapshot {
        #[serde(rename = "snapshotSequence")]
        snapshot_sequence: u64,
        projection: ThreadProjection,
        #[serde(rename = "historyCursor", default)]
        history_cursor: Option<String>,
        #[serde(rename = "hasMoreHistory", default)]
        has_more_history: Option<bool>,
    },
    #[serde(rename = "event")]
    Event { sequence: u64, event: DomainEvent },
    #[serde(rename = "unknown-event")]
    UnknownEvent {
        sequence: u64,
        #[serde(rename = "eventType", default)]
        event_type: String,
    },
    #[serde(other)]
    Unknown,
}

// ---------------------------------------------------------------------------
// Commands (dispatchCommand / launchThread)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DispatchMode {
    #[serde(rename = "start_immediately")]
    StartImmediately,
    #[serde(rename = "queue_after_active")]
    QueueAfterActive,
    #[serde(rename = "steer_active")]
    SteerActive {
        #[serde(rename = "targetRunId")]
        target_run_id: String,
    },
    #[serde(rename = "restart_active")]
    RestartActive {
        #[serde(rename = "targetRunId")]
        target_run_id: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OrchestrationCommand {
    #[serde(rename = "message.dispatch")]
    MessageDispatch {
        /// `user` for anything the person typed (`OrchestrationV2Actor`).
        #[serde(rename = "createdBy")]
        created_by: String,
        /// The native client reports `web`, as the desktop app does.
        #[serde(rename = "creationSource")]
        creation_source: String,
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        text: String,
        attachments: Vec<Value>,
        #[serde(rename = "modelSelection", skip_serializing_if = "Option::is_none")]
        model_selection: Option<ModelSelection>,
        #[serde(rename = "dispatchMode")]
        dispatch_mode: DispatchMode,
    },
    #[serde(rename = "run.interrupt")]
    RunInterrupt {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "thread.stop")]
    ThreadStop {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "runtime-request.respond")]
    RuntimeRequestRespond {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        decision: Option<ApprovalDecision>,
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        answers: Option<Value>,
    },
    #[serde(rename = "thread.runtime-mode.set")]
    ThreadRuntimeModeSet {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runtimeMode")]
        runtime_mode: RuntimeMode,
    },
    #[serde(rename = "thread.model-selection.set")]
    ThreadModelSelectionSet {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "modelSelection")]
        model_selection: ModelSelection,
    },
    #[serde(rename = "thread.visit")]
    ThreadVisit {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "visitedAt")]
        visited_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        opened: Option<bool>,
    },
    #[serde(rename = "thread.archive")]
    ThreadArchive {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(rename = "thread.unarchive")]
    ThreadUnarchive {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(rename = "thread.delete")]
    ThreadDelete {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "onlyIfUnused", skip_serializing_if = "Option::is_none")]
        only_if_unused: Option<bool>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchCommandResult {
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WorkspaceStrategy {
    #[serde(rename = "root")]
    Root {
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    #[serde(rename = "existing_worktree")]
    ExistingWorktree {
        #[serde(rename = "worktreePath")]
        worktree_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    #[serde(rename = "worktree")]
    Worktree {
        #[serde(rename = "baseRef")]
        base_ref: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(rename = "startFromOrigin", skip_serializing_if = "Option::is_none")]
        start_from_origin: Option<bool>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaunchInitialMessage {
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub text: String,
    pub attachments: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaunchThreadInput {
    #[serde(rename = "commandId")]
    pub command_id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub title: String,
    #[serde(rename = "generateTitle", skip_serializing_if = "Option::is_none")]
    pub generate_title: Option<bool>,
    #[serde(rename = "modelSelection")]
    pub model_selection: ModelSelection,
    #[serde(rename = "runtimeMode")]
    pub runtime_mode: RuntimeMode,
    #[serde(rename = "interactionMode")]
    pub interaction_mode: ProviderInteractionMode,
    #[serde(rename = "workspaceStrategy")]
    pub workspace_strategy: WorkspaceStrategy,
    #[serde(rename = "initialMessage", skip_serializing_if = "Option::is_none")]
    pub initial_message: Option<LaunchInitialMessage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaunchThreadResult {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub projection: ThreadProjection,
    pub resumed: bool,
    #[serde(default)]
    pub sequence: Option<u64>,
}

#[cfg(test)]
mod activity_tests {
    use super::ThreadShell;

    fn thread(extra: serde_json::Value) -> ThreadShell {
        let mut v = serde_json::json!({
            "id": "t", "projectId": "p", "title": "t", "providerInstanceId": "replay",
            "modelSelection": {"instanceId": "replay", "model": "m"},
            "runtimeMode": "full-access", "interactionMode": "default", "status": "idle",
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-05T00:00:00.000Z"
        });
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn activity_prefers_messages_and_runs_over_updated_at() {
        let t = thread(serde_json::json!({
            "latestUserMessageAt": "2026-01-02T00:00:00.000Z",
            "latestRunCompletedAt": "2026-01-03T00:00:00.000Z"
        }));
        assert_eq!(t.activity_timestamp(), "2026-01-03T00:00:00.000Z");
        assert_eq!(
            thread(serde_json::json!({})).activity_timestamp(),
            "2026-01-05T00:00:00.000Z"
        );
    }
}
