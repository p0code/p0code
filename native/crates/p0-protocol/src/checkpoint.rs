//! Checkpoints and their diffs. Mirrors `packages/contracts/src/checkpointDiff.ts` and the
//! checkpoint structs of `orchestrationV2.ts`.

use serde::{Deserialize, Serialize};

pub const RPC_ORCHESTRATION_GET_TURN_DIFF: &str = "orchestration.getTurnDiff";
pub const RPC_ORCHESTRATION_GET_FULL_THREAD_DIFF: &str = "orchestration.getFullThreadDiff";

/// Ends a checkpoint diff the server cut off at its output size limit.
pub const CHECKPOINT_DIFF_TRUNCATED_MARKER: &str = "\n\n[truncated]";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointFileSummary {
    pub path: String,
    pub kind: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointFileTotals {
    pub count: u64,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    #[serde(rename = "runId", default)]
    pub run_id: Option<String>,
    /// The thread-wide turn count this checkpoint closes; `None` for scope baselines.
    #[serde(rename = "appRunOrdinal", default)]
    pub app_run_ordinal: Option<u64>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub files: Vec<CheckpointFileSummary>,
    #[serde(rename = "filesTotal", default)]
    pub files_total: Option<CheckpointFileTotals>,
    #[serde(rename = "capturedAt", default)]
    pub captured_at: String,
}

impl Checkpoint {
    /// `(files, additions, deletions)` over the whole turn, not just the files sent.
    pub fn totals(&self) -> (u64, u64, u64) {
        match &self.files_total {
            Some(t) => (t.count, t.additions, t.deletions),
            None => self
                .files
                .iter()
                .fold((self.files.len() as u64, 0, 0), |(n, a, d), f| {
                    (n, a + f.additions, d + f.deletions)
                }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnDiffInput {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "fromTurnCount")]
    pub from_turn_count: u64,
    #[serde(rename = "toTurnCount")]
    pub to_turn_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FullThreadDiffInput {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "toTurnCount")]
    pub to_turn_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepositoryDiff {
    pub name: String,
    #[serde(rename = "relativePath", default)]
    pub relative_path: String,
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadTurnDiff {
    /// The thread folder's own patch; empty when that folder is not a Git repository.
    pub diff: String,
    #[serde(default)]
    pub repositories: Vec<RepositoryDiff>,
}

impl ThreadTurnDiff {
    /// All patches as one unified diff, tracked repositories' paths prefixed by their folder.
    pub fn combined(&self) -> String {
        let mut out = self.diff.clone();
        for repo in &self.repositories {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            let prefix = repo.relative_path.trim_end_matches('/');
            if prefix.is_empty() || prefix == "." {
                out.push_str(&repo.diff);
            } else {
                out.push_str(&prefix_diff_paths(&repo.diff, prefix));
            }
        }
        out
    }
}

fn prefix_diff_paths(diff: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(diff.len());
    for line in diff.split_inclusive('\n') {
        let rewritten = if let Some(rest) = line.strip_prefix("diff --git a/") {
            Some(format!(
                "diff --git a/{prefix}/{}",
                rest.replacen(" b/", &format!(" b/{prefix}/"), 1)
            ))
        } else if let Some(rest) = line.strip_prefix("--- a/") {
            Some(format!("--- a/{prefix}/{rest}"))
        } else {
            line.strip_prefix("+++ b/")
                .map(|rest| format!("+++ b/{prefix}/{rest}"))
        };
        out.push_str(rewritten.as_deref().unwrap_or(line));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_parses_wire_shape() {
        let cp: Checkpoint = serde_json::from_value(serde_json::json!({
            "id": "cp1", "threadId": "t", "scopeId": "s", "runId": "r1", "nodeId": "n",
            "parentCheckpointId": null, "ordinalWithinScope": 1, "appRunOrdinal": 2,
            "ref": "refs/x", "status": "ready",
            "files": [{"path": "a.rs", "kind": "modified", "additions": 3, "deletions": 1}],
            "capturedAt": "2026-01-01T00:00:00.000Z"
        }))
        .unwrap();
        assert_eq!(cp.app_run_ordinal, Some(2));
        assert_eq!(cp.totals(), (1, 3, 1));
    }

    #[test]
    fn combined_prefixes_repository_paths() {
        let diff = ThreadTurnDiff {
            diff: String::new(),
            repositories: vec![RepositoryDiff {
                name: "lib".into(),
                relative_path: "libs/lib".into(),
                diff: "diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-a\n+b\n"
                    .into(),
            }],
        };
        let out = diff.combined();
        assert!(out.starts_with("diff --git a/libs/lib/x.rs b/libs/lib/x.rs\n"));
        assert!(out.contains("+++ b/libs/lib/x.rs\n"));
        assert!(out.ends_with("+b\n"));
    }
}
