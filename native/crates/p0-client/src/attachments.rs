//! Chat attachment upload, as `apps/web/src/lib/attachmentUploadQueue.ts` does it: ask for a
//! signed upload URL over the socket, then POST the raw bytes there. The signed path is the
//! only credential the upload route takes.

use std::path::Path;

use p0_protocol::{
    AttachmentType, ChatAttachment, CreateUploadUrlInput, CreateUploadUrlResult,
    RPC_ATTACHMENTS_CREATE_UPLOAD_URL,
};

use crate::{ClientError, RpcClient};

/// The MIME type the web app would send for `name`, by extension.
pub fn mime_for_name(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "txt" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "toml" | "yaml"
        | "yml" | "sh" | "css" | "sql" | "c" | "h" | "cpp" | "java" | "kt" | "swift" | "rb" => {
            "text/plain"
        }
        _ => "application/octet-stream",
    }
}

/// Uploads `bytes` as `name` and returns the element `message.dispatch` takes.
pub async fn upload_attachment(
    client: &RpcClient,
    http_base_url: &str,
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<ChatAttachment, ClientError> {
    let kind = AttachmentType::for_mime(&mime_type);
    let size_bytes = bytes.len() as u64;
    if size_bytes == 0 || size_bytes > kind.max_bytes() {
        return Err(ClientError::Protocol(format!(
            "{name} is {size_bytes} bytes; attachments must be 1 to {} bytes",
            kind.max_bytes()
        )));
    }
    let input = CreateUploadUrlInput {
        kind,
        name: name.clone(),
        mime_type: mime_type.clone(),
        size_bytes,
    };
    let target: CreateUploadUrlResult = client
        .request(RPC_ATTACHMENTS_CREATE_UPLOAD_URL, &input)
        .await?;
    let url = format!(
        "{}{}",
        http_base_url.trim_end_matches('/'),
        target.relative_url
    );
    let response = reqwest::Client::new()
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, &mime_type)
        .body(bytes)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ClientError::RpcFailure(format!(
            "attachment upload failed ({status}): {text}"
        )));
    }
    Ok(ChatAttachment {
        kind,
        id: target.attachment_id,
        name,
        mime_type,
        size_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_by_extension() {
        assert_eq!(mime_for_name("Shot.PNG"), "image/png");
        assert_eq!(mime_for_name("notes.rs"), "text/plain");
        assert_eq!(mime_for_name("blob"), "application/octet-stream");
    }
}
