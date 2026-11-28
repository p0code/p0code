//! Project files, working-tree diffs and chat attachments. Mirrors `packages/contracts/src/`
//! `project.ts`, `review.ts`, `assets.ts` and `chatAttachment.ts`.

use serde::{Deserialize, Serialize};

pub const RPC_PROJECTS_LIST_ENTRIES: &str = "projects.listEntries";
pub const RPC_PROJECTS_SEARCH_ENTRIES: &str = "projects.searchEntries";
pub const RPC_PROJECTS_READ_FILE: &str = "projects.readFile";
pub const RPC_REVIEW_GET_DIFF_PREVIEW: &str = "review.getDiffPreview";
pub const RPC_ATTACHMENTS_CREATE_UPLOAD_URL: &str = "attachments.createUploadUrl";
pub const RPC_ASSETS_CREATE_URL: &str = "assets.createUrl";

/// `PROJECT_SEARCH_ENTRIES_MAX_LIMIT`.
pub const SEARCH_ENTRIES_MAX_LIMIT: u32 = 200;
pub const IMAGE_ATTACHMENT_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const FILE_ATTACHMENT_MAX_BYTES: u64 = 50 * 1024 * 1024;
pub const IMAGE_ATTACHMENT_MIME_TYPES: [&str; 4] =
    ["image/gif", "image/jpeg", "image/png", "image/webp"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// Relative to the `cwd` it was listed under, `/`-separated.
    pub path: String,
    pub kind: ProjectEntryKind,
    #[serde(default)]
    pub ignored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListEntriesInput {
    pub cwd: String,
    #[serde(rename = "directoryPath", skip_serializing_if = "Option::is_none")]
    pub directory_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchEntriesInput {
    pub cwd: String,
    pub query: String,
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ProjectEntryKind>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntriesResult {
    pub entries: Vec<ProjectEntry>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadFileInput {
    pub cwd: String,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadFileResult {
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    pub contents: String,
    #[serde(rename = "byteLength", default)]
    pub byte_length: u64,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiffSourceKind {
    #[serde(rename = "working-tree")]
    WorkingTree,
    #[serde(rename = "branch-range")]
    BranchRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffPreviewInput {
    pub cwd: String,
    #[serde(rename = "sourceKind")]
    pub source_kind: DiffSourceKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffPreviewSource {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub diff: String,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffPreviewResult {
    #[serde(default)]
    pub sources: Vec<DiffPreviewSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentType {
    Image,
    File,
    #[serde(other)]
    Unknown,
}

impl AttachmentType {
    pub fn for_mime(mime_type: &str) -> Self {
        if IMAGE_ATTACHMENT_MIME_TYPES.contains(&mime_type) {
            Self::Image
        } else {
            Self::File
        }
    }

    pub fn max_bytes(self) -> u64 {
        match self {
            Self::Image => IMAGE_ATTACHMENT_MAX_BYTES,
            Self::File | Self::Unknown => FILE_ATTACHMENT_MAX_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum AssetResource {
    #[serde(rename = "attachment")]
    Attachment {
        #[serde(rename = "attachmentId")]
        attachment_id: String,
        #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
        file_name: Option<String>,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        disposition: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateAssetUrlInput {
    pub resource: AssetResource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateAssetUrlResult {
    #[serde(rename = "relativeUrl")]
    pub relative_url: String,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateUploadUrlInput {
    #[serde(rename = "type")]
    pub kind: AttachmentType,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateUploadUrlResult {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    /// `/api/attachments/upload/<token>`: POST the raw bytes there; the token is the credential.
    #[serde(rename = "relativeUrl")]
    pub relative_url: String,
}

/// One element of `message.dispatch`'s `attachments`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatAttachment {
    #[serde(rename = "type")]
    pub kind: AttachmentType,
    pub id: String,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_wire_shape() {
        let a = ChatAttachment {
            kind: AttachmentType::for_mime("image/png"),
            id: "pending-1.png".into(),
            name: "a.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 3,
        };
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::json!({"type":"image","id":"pending-1.png","name":"a.png","mimeType":"image/png","sizeBytes":3})
        );
        assert_eq!(AttachmentType::for_mime("text/plain"), AttachmentType::File);
        let unknown: ChatAttachment = serde_json::from_str(
            r#"{"type":"audio","id":"a1","name":"clip.wav","mimeType":"audio/wav","sizeBytes":9}"#,
        )
        .unwrap();
        assert_eq!(unknown.kind, AttachmentType::Unknown);

        let asset_req = CreateAssetUrlInput {
            resource: AssetResource::Attachment {
                attachment_id: "att-1".into(),
                file_name: Some("shot.png".into()),
                mime_type: Some("image/png".into()),
                disposition: Some("inline".into()),
            },
        };
        assert_eq!(
            serde_json::to_value(&asset_req).unwrap(),
            serde_json::json!({
                "resource": {
                    "_tag": "attachment",
                    "attachmentId": "att-1",
                    "fileName": "shot.png",
                    "mimeType": "image/png",
                    "disposition": "inline"
                }
            })
        );
    }

    #[test]
    fn entries_parse() {
        let r: EntriesResult = serde_json::from_str(
            r#"{"entries":[{"path":"src","kind":"directory"},{"path":"a.rs","kind":"file","ignored":true}],"truncated":false}"#,
        )
        .unwrap();
        assert_eq!(r.entries[0].kind, ProjectEntryKind::Directory);
        assert!(r.entries[1].ignored);
    }
}
