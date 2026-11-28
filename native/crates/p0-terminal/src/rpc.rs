//! Wire shapes of the server's `terminal.*` RPCs (`packages/contracts/src/terminal.ts`).
//! PTY output and history are UTF-8 text, so feed `data.as_bytes()` to an engine.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const TERMINAL_OPEN: &str = "terminal.open";
pub const TERMINAL_ATTACH: &str = "terminal.attach";
pub const TERMINAL_WRITE: &str = "terminal.write";
pub const TERMINAL_RESIZE: &str = "terminal.resize";
pub const TERMINAL_CLOSE: &str = "terminal.close";

/// Longest `data` one `terminal.write` carries, in UTF-16 code units.
pub const TERMINAL_WRITE_MAX_LENGTH: usize = 65_536;

/// Payload of `terminal.open`; succeeds with a [`TerminalSessionSnapshot`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenInput {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_on_settle: Option<bool>,
}

/// Payload of the `terminal.attach` stream, which yields [`TerminalAttachStreamEvent`]s.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachInput {
    pub thread_id: String,
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_snapshot_sequence_state: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_on_settle: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_if_not_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_history_bytes: Option<u64>,
}

/// Payload of `terminal.write`; succeeds with no value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteInput {
    pub thread_id: String,
    pub terminal_id: String,
    pub data: String,
    /// `data` holds one byte per code unit (latin1) instead of UTF-8 text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    /// Marks an answer to a terminal query (DA, DSR) so only one viewer's reply reaches the PTY.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<bool>,
}

/// Payload of `terminal.resize`; succeeds with no value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeInput {
    pub thread_id: String,
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Payload of `terminal.close`; succeeds with no value. No `terminal_id` closes every terminal of the thread.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseInput {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_history: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Exited,
    Error,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub status: TerminalSessionStatus,
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_conditional_writes: Option<bool>,
    /// Replayable output so far, as UTF-8 text.
    pub history: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_sequence_state: Option<u32>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    pub label: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventTarget {
    pub thread_id: String,
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalAttachStreamEvent {
    Snapshot {
        snapshot: TerminalSessionSnapshot,
    },
    Output {
        #[serde(flatten)]
        target: TerminalEventTarget,
        data: String,
    },
    Exited {
        #[serde(flatten)]
        target: TerminalEventTarget,
        exit_code: Option<i32>,
        exit_signal: Option<i32>,
    },
    Closed {
        #[serde(flatten)]
        target: TerminalEventTarget,
    },
    Error {
        #[serde(flatten)]
        target: TerminalEventTarget,
        message: String,
    },
    Cleared {
        #[serde(flatten)]
        target: TerminalEventTarget,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pending_control_sequence: Option<String>,
    },
    Restarted {
        #[serde(flatten)]
        target: TerminalEventTarget,
        snapshot: TerminalSessionSnapshot,
    },
    Activity {
        #[serde(flatten)]
        target: TerminalEventTarget,
        has_running_subprocess: bool,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cols: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rows: Option<u16>,
    },
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    use super::*;

    fn round_trip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(wire: Value) -> T {
        let parsed: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), wire);
        parsed
    }

    fn snapshot_json() -> Value {
        json!({
            "threadId": "thread-1",
            "terminalId": "term-1",
            "cwd": "/repo",
            "worktreePath": null,
            "status": "running",
            "pid": 4242,
            "history": "$ ls\r\n",
            "exitCode": null,
            "exitSignal": null,
            "label": "zsh",
            "updatedAt": "2026-11-27T00:00:00.000Z",
            "sequence": 7,
            "cols": 80,
            "rows": 24
        })
    }

    #[test]
    fn inputs_round_trip() {
        let open: TerminalOpenInput = round_trip(json!({
            "threadId": "thread-1",
            "terminalId": "term-1",
            "cwd": "/repo",
            "cols": 80,
            "rows": 24,
            "env": { "FOO": "bar" }
        }));
        assert_eq!(open.env.unwrap()["FOO"], "bar");

        let attach: TerminalAttachInput = round_trip(json!({
            "threadId": "thread-1",
            "terminalId": "term-1",
            "supportsSnapshotSequenceState": true,
            "cols": 120,
            "rows": 40,
            "resume": true,
            "maxHistoryBytes": 524288
        }));
        assert_eq!(attach.max_history_bytes, Some(524_288));

        let write: TerminalWriteInput = round_trip(json!({
            "threadId": "thread-1",
            "terminalId": "term-1",
            "data": "\u{1b}[2;3R",
            "reply": true
        }));
        assert_eq!(write.reply, Some(true));

        round_trip::<TerminalResizeInput>(json!({
            "threadId": "thread-1",
            "terminalId": "term-1",
            "cols": 100,
            "rows": 30
        }));
        let close: TerminalCloseInput = round_trip(json!({ "threadId": "thread-1" }));
        assert_eq!(close.terminal_id, None);
    }

    #[test]
    fn snapshot_round_trips() {
        let snapshot: TerminalSessionSnapshot = round_trip(snapshot_json());
        assert_eq!(snapshot.status, TerminalSessionStatus::Running);
        assert_eq!(snapshot.pid, Some(4242));
    }

    #[test]
    fn stream_events_round_trip() {
        let target = json!({ "threadId": "thread-1", "terminalId": "term-1", "sequence": 8 });
        let with = |extra: Value| {
            let mut event = target.clone();
            event
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            event
        };

        let event: TerminalAttachStreamEvent =
            round_trip(json!({ "type": "snapshot", "snapshot": snapshot_json() }));
        assert!(matches!(event, TerminalAttachStreamEvent::Snapshot { .. }));

        let event = round_trip(with(json!({ "type": "output", "data": "hi\r\n" })));
        let TerminalAttachStreamEvent::Output { target, data } = event else {
            panic!("expected output, got {event:?}");
        };
        assert_eq!((target.sequence, data.as_str()), (Some(8), "hi\r\n"));

        for extra in [
            json!({ "type": "exited", "exitCode": 0, "exitSignal": null }),
            json!({ "type": "closed" }),
            json!({ "type": "error", "message": "boom" }),
            json!({ "type": "cleared", "pendingControlSequence": "\u{1b}[" }),
            json!({ "type": "restarted", "snapshot": snapshot_json() }),
            json!({ "type": "activity", "hasRunningSubprocess": true, "label": "vim", "cols": 90 }),
        ] {
            let event: TerminalAttachStreamEvent = round_trip(with(extra));
            assert_ne!(event, TerminalAttachStreamEvent::Unknown);
        }
    }

    #[test]
    fn unknown_values_fall_back() {
        let event: TerminalAttachStreamEvent =
            serde_json::from_value(json!({ "type": "teleported", "threadId": "t" })).unwrap();
        assert_eq!(event, TerminalAttachStreamEvent::Unknown);

        let mut wire = snapshot_json();
        wire["status"] = json!("hibernating");
        let snapshot: TerminalSessionSnapshot = serde_json::from_value(wire).unwrap();
        assert_eq!(snapshot.status, TerminalSessionStatus::Unknown);
    }
}
