//! Wire envelopes for the `effect/rpc` JSON-over-WebSocket protocol (`RpcSerialization.layerJson`).
//!
//! See `docs/internals/backend-split/PROTOCOL.md` §4–§5.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Client-chosen request identifier. Servers echo the exact JSON type (`7 != "7"`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

impl From<u64> for RequestId {
    fn from(value: u64) -> Self {
        Self::Number(value)
    }
}

impl From<String> for RequestId {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

/// Frames sent from the client to `p0d` / `apps/server`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum RpcClientFrame {
    Request {
        id: RequestId,
        tag: String,
        payload: Value,
        #[serde(default)]
        headers: Vec<(String, String)>,
        #[serde(skip_serializing_if = "Option::is_none")]
        discard: Option<bool>,
    },
    Ack {
        #[serde(rename = "requestId")]
        request_id: RequestId,
    },
    Interrupt {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        #[serde(default)]
        interruptors: Vec<Value>,
    },
    Ping,
    Eof,
}

/// Frames sent from `p0d` / `apps/server` to the client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum RpcServerFrame {
    Chunk {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        values: Vec<Value>,
    },
    Exit {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        exit: RpcExit,
    },
    Defect {
        defect: Value,
    },
    ClientProtocolError {
        #[serde(default)]
        defect: Value,
    },
    Pong,
    #[serde(other)]
    Unknown,
}

/// Terminal outcome of an RPC request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum RpcExit {
    Success {
        value: Value,
    },
    Failure {
        #[serde(default)]
        cause: Vec<RpcCauseEntry>,
    },
    #[serde(other)]
    Unknown,
}

/// One entry in an `effect` `Exit::Failure` cause array.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum RpcCauseEntry {
    Fail {
        error: Value,
    },
    Die {
        defect: Value,
    },
    Interrupt {
        #[serde(rename = "fiberId", default)]
        fiber_id: Option<i64>,
    },
    #[serde(other)]
    Unknown,
}

impl RpcExit {
    /// Returns a human-readable summary if this exit is a failure.
    pub fn failure_message(&self) -> Option<String> {
        match self {
            RpcExit::Success { .. } => None,
            RpcExit::Failure { cause } => {
                let parts: Vec<String> = cause
                    .iter()
                    .map(|entry| match entry {
                        RpcCauseEntry::Fail { error } => error
                            .get("message")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                            .unwrap_or_else(|| error.to_string()),
                        RpcCauseEntry::Die { defect } => defect
                            .as_str()
                            .map(ToOwned::to_owned)
                            .or_else(|| {
                                defect
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .map(ToOwned::to_owned)
                            })
                            .unwrap_or_else(|| defect.to_string()),
                        RpcCauseEntry::Interrupt { .. } => "Request interrupted".to_owned(),
                        RpcCauseEntry::Unknown => "Unknown RPC failure cause".to_owned(),
                    })
                    .collect();
                if parts.is_empty() {
                    Some("RPC failed".to_owned())
                } else {
                    Some(parts.join("; "))
                }
            }
            RpcExit::Unknown => Some("Unknown RPC exit".to_owned()),
        }
    }
}

#[derive(Debug, Error)]
pub enum WireCodecError {
    #[error("json codec error: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn encode_client_frame(frame: &RpcClientFrame) -> Result<String, WireCodecError> {
    Ok(serde_json::to_string(frame)?)
}

pub fn decode_server_frame(text: &str) -> Result<RpcServerFrame, WireCodecError> {
    Ok(serde_json::from_str(text)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_all_client_frames_matching_protocol() {
        let req = RpcClientFrame::Request {
            id: RequestId::Number(7),
            tag: "server.probe".to_owned(),
            payload: json!({}),
            headers: vec![("x-test".to_owned(), "1".to_owned())],
            discard: None,
        };
        let encoded = encode_client_frame(&req).unwrap();
        let parsed: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(
            parsed,
            json!({
                "_tag": "Request",
                "id": 7,
                "tag": "server.probe",
                "payload": {},
                "headers": [["x-test", "1"]]
            })
        );

        let ack = encode_client_frame(&RpcClientFrame::Ack {
            request_id: RequestId::Number(7),
        })
        .unwrap();
        assert_eq!(ack, r#"{"_tag":"Ack","requestId":7}"#);

        let ping = encode_client_frame(&RpcClientFrame::Ping).unwrap();
        assert_eq!(ping, r#"{"_tag":"Ping"}"#);

        let intr = encode_client_frame(&RpcClientFrame::Interrupt {
            request_id: RequestId::String("req-1".to_owned()),
            interruptors: vec![],
        })
        .unwrap();
        let parsed_intr: Value = serde_json::from_str(&intr).unwrap();
        assert_eq!(
            parsed_intr,
            json!({"_tag": "Interrupt", "requestId": "req-1", "interruptors": []})
        );
    }

    #[test]
    fn decodes_server_frames_and_unknown_variants() {
        assert_eq!(
            decode_server_frame(r#"{"_tag":"Pong"}"#).unwrap(),
            RpcServerFrame::Pong
        );

        let chunk = decode_server_frame(r#"{"_tag":"Chunk","requestId":7,"values":[1,2]}"#).unwrap();
        assert_eq!(
            chunk,
            RpcServerFrame::Chunk {
                request_id: RequestId::Number(7),
                values: vec![json!(1), json!(2)],
            }
        );

        let exit_ok = decode_server_frame(
            r#"{"_tag":"Exit","requestId":7,"exit":{"_tag":"Success","value":null}}"#,
        )
        .unwrap();
        assert_eq!(
            exit_ok,
            RpcServerFrame::Exit {
                request_id: RequestId::Number(7),
                exit: RpcExit::Success { value: Value::Null },
            }
        );

        let exit_fail = decode_server_frame(
            r#"{"_tag":"Exit","requestId":7,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"Missing scope"}},{"_tag":"Die","defect":"boom"},{"_tag":"Interrupt","fiberId":null},{"_tag":"FutureCause","x":1}]}}"#,
        )
        .unwrap();
        match exit_fail {
            RpcServerFrame::Exit { exit, .. } => {
                assert_eq!(
                    exit.failure_message().as_deref(),
                    Some("Missing scope; boom; Request interrupted; Unknown RPC failure cause")
                );
            }
            other => panic!("unexpected frame: {other:?}"),
        }

        let defect = decode_server_frame(r#"{"_tag":"Defect","defect":"bad json"}"#).unwrap();
        assert_eq!(
            defect,
            RpcServerFrame::Defect {
                defect: json!("bad json"),
            }
        );

        let proto_err =
            decode_server_frame(r#"{"_tag":"ClientProtocolError","defect":"unsupported"}"#).unwrap();
        assert_eq!(
            proto_err,
            RpcServerFrame::ClientProtocolError {
                defect: json!("unsupported"),
            }
        );

        let future = decode_server_frame(r#"{"_tag":"FutureServerTag","foo":"bar"}"#).unwrap();
        assert_eq!(future, RpcServerFrame::Unknown);
    }
}
