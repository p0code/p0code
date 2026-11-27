use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("transport error: {0}")]
    Transport(String),

    #[error("authentication error: {0}")]
    Auth(String),

    #[error("rpc failure: {0}")]
    RpcFailure(String),

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("p0d process error: {0}")]
    Process(String),

    #[error("request timed out")]
    Timeout,

    #[error("connection closed")]
    Closed,

    #[error("not implemented: {0}")]
    Unimplemented(&'static str),

    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
