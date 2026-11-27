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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderInteractionMode {
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
        self.display_name
            .as_deref()
            .unwrap_or(&self.instance_id)
    }

    pub fn is_available(&self) -> bool {
        self.enabled && self.availability.as_deref() != Some("unavailable")
    }
}

/// Subset of `ServerConfig` returned by `server.getConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerConfig {
    pub environment: ExecutionEnvironmentDescriptor,
    pub auth: ServerAuthDescriptor,
    pub cwd: String,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub providers: Vec<ServerProvider>,
    #[serde(rename = "serverTime", default)]
    pub server_time: Option<String>,
    #[serde(default)]
    pub settings: Value,
}
