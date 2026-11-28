//! Authentication, OAuth token exchange, and environment discovery wire types.
//!
//! Mirrors `packages/contracts/src/auth.ts` and `packages/contracts/src/environment.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ORCHESTRATION_PROTOCOL_VERSION: u32 = 2;
pub const ORCHESTRATION_PROTOCOL_QUERY_PARAM: &str = "orchestrationProtocol";

pub const GRANT_TYPE_TOKEN_EXCHANGE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
pub const TOKEN_TYPE_ENVIRONMENT_BOOTSTRAP: &str =
    "urn:t3:params:oauth:token-type:environment-bootstrap";
pub const TOKEN_TYPE_ACCESS_TOKEN: &str = "urn:ietf:params:oauth:token-type:access_token";

/// Form-encoded request body for `POST /oauth/token`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenExchangeRequest {
    pub grant_type: String,
    pub subject_token: String,
    pub subject_token_type: String,
    pub requested_token_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_device_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_os: Option<String>,
}

impl TokenExchangeRequest {
    pub fn desktop_bootstrap(
        secret: impl Into<String>,
        client_label: impl Into<String>,
        client_os: impl Into<String>,
    ) -> Self {
        Self {
            grant_type: GRANT_TYPE_TOKEN_EXCHANGE.to_owned(),
            subject_token: secret.into(),
            subject_token_type: TOKEN_TYPE_ENVIRONMENT_BOOTSTRAP.to_owned(),
            requested_token_type: TOKEN_TYPE_ACCESS_TOKEN.to_owned(),
            scope: None,
            client_label: Some(client_label.into()),
            client_device_type: Some("desktop".to_owned()),
            client_os: Some(client_os.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TokenType {
    Bearer,
    DPoP,
    #[serde(other)]
    Unknown,
}

/// JSON response returned by `POST /oauth/token` (`AuthAccessTokenResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccessTokenResponse {
    pub access_token: String,
    pub issued_token_type: String,
    pub token_type: TokenType,
    pub expires_in: f64,
    pub scope: String,
}

/// JSON response returned by `POST /api/auth/websocket-ticket/rpc`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebSocketTicketResponse {
    pub ticket: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServerAuthPolicy {
    DesktopManagedLocal,
    LoopbackBrowser,
    RemoteReachable,
    UnsafeNoAuth,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerAuthDescriptor {
    pub policy: ServerAuthPolicy,
    #[serde(rename = "bootstrapMethods", default)]
    pub bootstrap_methods: Vec<String>,
    #[serde(rename = "sessionMethods", default)]
    pub session_methods: Vec<String>,
    #[serde(rename = "sessionCookieName", default)]
    pub session_cookie_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionEnvironmentPlatform {
    pub os: String,
    pub arch: String,
    #[serde(default)]
    pub machine: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionEnvironmentDescriptor {
    #[serde(rename = "environmentId")]
    pub environment_id: String,
    pub label: String,
    pub platform: ExecutionEnvironmentPlatform,
    #[serde(rename = "serverVersion")]
    pub server_version: String,
    #[serde(rename = "orchestrationProtocolVersion", default)]
    pub orchestration_protocol_version: Option<u32>,
    #[serde(default)]
    pub capabilities: Value,
    #[serde(rename = "publicOrigin", default)]
    pub public_origin: Option<String>,
}

/// Structured HTTP 401/403/500 error body from `EnvironmentHttpApi`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentHttpErrorBody {
    #[serde(rename = "_tag", default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "dpopFailureReason", default)]
    pub dpop_failure_reason: Option<String>,
    #[serde(rename = "traceId", default)]
    pub trace_id: Option<String>,
}
