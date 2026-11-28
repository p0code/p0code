//! Reactive `ShellStore` and `ThreadStore` applying snapshots and incremental deltas.

use p0_protocol::{
    DomainEvent, ProjectShell, ProjectedTurnItem, RuntimeRequest, RuntimeRequestStatus,
    ShellSnapshot, ShellStreamItem, ShellThreadLocation, ThreadProjection, ThreadShell,
    ThreadStreamItem, TurnItem,
};
use tokio::sync::watch;

/// Snapshot of the shell sidebar state.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShellState {
    pub projects: Vec<ProjectShell>,
    pub threads: Vec<ThreadShell>,
    pub archived_threads: Vec<ThreadShell>,
    pub last_sequence: u64,
    pub synchronized: bool,
    pub snapshot_required: bool,
}

impl ShellState {
    /// Returns active (non-deleted, non-archived) threads for `project_id`, sorted with
    /// pinned threads first and newest `updated_at` first.
    pub fn threads_for_project(&self, project_id: &str) -> Vec<&ThreadShell> {
        let mut out: Vec<&ThreadShell> = self
            .threads
            .iter()
            .filter(|t| {
                t.project_id == project_id && t.deleted_at.is_none() && t.archived_at.is_none()
            })
            .collect();
        out.sort_by(|a, b| {
            let a_pin = a.pinned_at.is_some();
            let b_pin = b.pinned_at.is_some();
            b_pin
                .cmp(&a_pin)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    pub fn thread_by_id(&self, thread_id: &str) -> Option<&ThreadShell> {
        self.threads
            .iter()
            .chain(self.archived_threads.iter())
            .find(|t| t.id == thread_id)
    }
}

/// Applies `orchestration.subscribeShell` items and broadcasts updates to UI listeners.
#[derive(Debug)]
pub struct ShellStore {
    tx: watch::Sender<ShellState>,
}

impl Default for ShellStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellStore {
    pub fn new() -> Self {
        let (tx, _) = watch::channel(ShellState::default());
        Self { tx }
    }

    pub fn subscribe(&self) -> watch::Receiver<ShellState> {
        self.tx.subscribe()
    }

    pub fn snapshot(&self) -> ShellState {
        self.tx.borrow().clone()
    }

    /// Applies one stream item. Deltas at or below the current cursor are replays after a resume
    /// and are skipped.
    pub fn apply(&self, item: ShellStreamItem) {
        if let Some(sequence) = item.sequence()
            && self.tx.borrow().synchronized
            && sequence <= self.tx.borrow().last_sequence
        {
            return;
        }
        self.tx.send_modify(|state| match item {
            ShellStreamItem::Synchronized => {
                state.synchronized = true;
            }
            ShellStreamItem::SnapshotRequired => {
                state.snapshot_required = true;
            }
            ShellStreamItem::Snapshot {
                snapshot,
                resolved_repository_identity_roots: None,
            } => {
                apply_shell_snapshot(state, snapshot);
            }
            // A project identity refresh: replaces those projects, keeps everything else.
            ShellStreamItem::Snapshot {
                snapshot,
                resolved_repository_identity_roots: Some(_),
            } => {
                for project in snapshot.projects {
                    upsert_by_id(&mut state.projects, project, |p| p.id.as_str());
                }
            }
            ShellStreamItem::ProjectUpdated { sequence, project } => {
                state.last_sequence = state.last_sequence.max(sequence);
                upsert_by_id(&mut state.projects, *project, |p| p.id.as_str());
            }
            ShellStreamItem::ProjectRemoved {
                sequence,
                project_id,
            } => {
                state.last_sequence = state.last_sequence.max(sequence);
                state.projects.retain(|p| p.id != project_id);
            }
            ShellStreamItem::ThreadUpdated {
                sequence,
                location,
                thread,
            } => {
                let thread = *thread;
                state.last_sequence = state.last_sequence.max(sequence);
                match location {
                    ShellThreadLocation::Active => {
                        state.archived_threads.retain(|t| t.id != thread.id);
                        upsert_by_id(&mut state.threads, thread, |t| t.id.as_str());
                    }
                    ShellThreadLocation::Archive => {
                        state.threads.retain(|t| t.id != thread.id);
                        upsert_by_id(&mut state.archived_threads, thread, |t| t.id.as_str());
                    }
                    ShellThreadLocation::Unknown => {}
                }
            }
            ShellStreamItem::ThreadRemoved {
                sequence,
                location,
                thread_id,
            } => {
                state.last_sequence = state.last_sequence.max(sequence);
                match location {
                    ShellThreadLocation::Active => {
                        state.threads.retain(|t| t.id != thread_id);
                    }
                    ShellThreadLocation::Archive => {
                        state.archived_threads.retain(|t| t.id != thread_id);
                    }
                    ShellThreadLocation::Unknown => {
                        state.threads.retain(|t| t.id != thread_id);
                        state.archived_threads.retain(|t| t.id != thread_id);
                    }
                }
            }
            ShellStreamItem::Unknown => {}
        });
    }
}

fn apply_shell_snapshot(state: &mut ShellState, snapshot: ShellSnapshot) {
    state.projects = snapshot.projects;
    state.threads = snapshot.threads;
    state.archived_threads = snapshot.archived_threads;
    state.last_sequence = snapshot.snapshot_sequence;
    state.snapshot_required = false;
    state.synchronized = true;
}

/// Snapshot of a single open thread's projection and revision.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThreadState {
    pub thread_id: Option<String>,
    pub projection: Option<ThreadProjection>,
    pub last_sequence: u64,
    pub synchronized: bool,
    pub revision: u64,
}

impl ThreadState {
    pub fn pending_approvals(&self) -> Vec<&RuntimeRequest> {
        let Some(proj) = &self.projection else {
            return Vec::new();
        };
        proj.runtime_requests
            .iter()
            .filter(|req| req.status == RuntimeRequestStatus::Pending)
            .collect()
    }

    /// The cursor to resume this thread's stream from, once a snapshot has been applied.
    pub fn resume_cursor(&self) -> Option<u64> {
        self.projection.as_ref().map(|_| self.last_sequence)
    }

    pub fn active_run_id(&self) -> Option<&str> {
        let proj = self.projection.as_ref()?;
        proj.runs
            .iter()
            .rev()
            .find(|r| r.status.is_active())
            .map(|r| r.id.as_str())
    }
}

/// Applies `orchestration.subscribeThread` snapshots and domain events, broadcasting changes.
#[derive(Debug)]
pub struct ThreadStore {
    tx: watch::Sender<ThreadState>,
}

impl Default for ThreadStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ThreadStore {
    pub fn new() -> Self {
        let (tx, _) = watch::channel(ThreadState::default());
        Self { tx }
    }

    pub fn subscribe(&self) -> watch::Receiver<ThreadState> {
        self.tx.subscribe()
    }

    pub fn snapshot(&self) -> ThreadState {
        self.tx.borrow().clone()
    }

    pub fn reset(&self, thread_id: Option<String>) {
        self.tx.send_modify(|state| {
            state.thread_id = thread_id;
            state.projection = None;
            state.last_sequence = 0;
            state.synchronized = false;
            state.revision = state.revision.wrapping_add(1);
        });
    }

    /// Applies one item of `thread_id`'s stream. Items of any other thread (a stream that was
    /// still delivering when the user switched threads) and replayed events are ignored.
    /// Returns whether the state changed.
    pub fn apply_for(&self, thread_id: &str, item: ThreadStreamItem) -> bool {
        self.tx.send_if_modified(|state| {
            if state.thread_id.as_deref() != Some(thread_id) {
                return false;
            }
            match item {
                ThreadStreamItem::Synchronized => {
                    let changed = !state.synchronized;
                    state.synchronized = true;
                    changed
                }
                ThreadStreamItem::Snapshot {
                    snapshot_sequence,
                    projection,
                    ..
                } => {
                    if projection.thread.id != thread_id {
                        return false;
                    }
                    state.projection = Some(projection);
                    state.last_sequence = snapshot_sequence;
                    state.synchronized = true;
                    state.revision = state.revision.wrapping_add(1);
                    true
                }
                ThreadStreamItem::Event { sequence, event } => {
                    let Some(proj) = state.projection.as_mut() else {
                        return false;
                    };
                    if sequence <= state.last_sequence {
                        return false;
                    }
                    apply_domain_event(proj, event);
                    state.last_sequence = sequence;
                    state.revision = state.revision.wrapping_add(1);
                    true
                }
                ThreadStreamItem::UnknownEvent { sequence, .. } => {
                    if state.projection.is_some() {
                        state.last_sequence = state.last_sequence.max(sequence);
                    }
                    false
                }
                ThreadStreamItem::Unknown => false,
            }
        })
    }
}

fn apply_domain_event(proj: &mut ThreadProjection, event: DomainEvent) {
    match event {
        DomainEvent::ThreadUpdated {
            occurred_at,
            payload,
        } => {
            proj.thread = payload;
            proj.updated_at = occurred_at;
        }
        DomainEvent::RunUpdated {
            occurred_at,
            payload,
        } => {
            upsert_by_id(&mut proj.runs, payload, |r| r.id.as_str());
            proj.updated_at = occurred_at;
        }
        DomainEvent::RuntimeRequestUpdated {
            occurred_at,
            payload,
        } => {
            upsert_by_id(&mut proj.runtime_requests, payload, |r| r.id.as_str());
            proj.updated_at = occurred_at;
        }
        DomainEvent::MessageUpdated {
            occurred_at,
            payload,
        } => {
            upsert_by_id(&mut proj.messages, payload, |m| m.id.as_str());
            proj.updated_at = occurred_at;
        }
        DomainEvent::TurnItemUpdated {
            occurred_at,
            payload,
        } => {
            if let Some(item_id) = payload.id().map(ToOwned::to_owned) {
                let thread_id = payload
                    .thread_id()
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| proj.thread.id.clone());
                upsert_turn_item(&mut proj.turn_items, payload.clone(), &item_id);
                upsert_visible_turn_item(
                    &mut proj.visible_turn_items,
                    payload,
                    &thread_id,
                    &item_id,
                );
            }
            proj.updated_at = occurred_at;
        }
        DomainEvent::CheckpointCaptured {
            occurred_at,
            payload,
        } => {
            upsert_by_id(&mut proj.checkpoints, payload, |c| c.id.as_str());
            proj.updated_at = occurred_at;
        }
        DomainEvent::PlanUpdated {
            occurred_at,
            payload,
        } => {
            let plan_id = match &payload {
                p0_protocol::PlanArtifact::ProposedPlan { id, .. }
                | p0_protocol::PlanArtifact::TodoList { id, .. } => Some(id.clone()),
                p0_protocol::PlanArtifact::Unknown => None,
            };
            if let Some(id) = plan_id {
                if let Some(existing) = proj.plans.iter_mut().find(|p| match p {
                    p0_protocol::PlanArtifact::ProposedPlan { id: pid, .. }
                    | p0_protocol::PlanArtifact::TodoList { id: pid, .. } => pid == &id,
                    p0_protocol::PlanArtifact::Unknown => false,
                }) {
                    *existing = payload;
                } else {
                    proj.plans.push(payload);
                }
            }
            proj.updated_at = occurred_at;
        }
        DomainEvent::Unknown => {}
    }
}

fn upsert_by_id<T>(items: &mut Vec<T>, item: T, id_fn: impl Fn(&T) -> &str) {
    let target = id_fn(&item).to_owned();
    if let Some(existing) = items.iter_mut().find(|cand| id_fn(cand) == target) {
        *existing = item;
    } else {
        items.push(item);
    }
}

fn upsert_turn_item(items: &mut Vec<TurnItem>, item: TurnItem, id: &str) {
    if let Some(existing) = items.iter_mut().find(|cand| cand.id() == Some(id)) {
        *existing = item;
    } else {
        items.push(item);
    }
}

fn upsert_visible_turn_item(
    rows: &mut Vec<ProjectedTurnItem>,
    item: TurnItem,
    thread_id: &str,
    item_id: &str,
) {
    // Fast path: streaming updates usually touch the newest rows at the tail.
    if let Some(existing) = rows.iter_mut().rev().find(|r| r.source_item_id == item_id)
        && existing.item.ordinal() == item.ordinal()
    {
        existing.item = item;
        return;
    }

    rows.retain(|r| r.source_item_id != item_id);
    let ordinal = item.ordinal();
    let insert_idx = rows
        .iter()
        .position(|r| {
            r.visibility == "local"
                && (r.item.ordinal() > ordinal
                    || (r.item.ordinal() == ordinal && r.source_item_id.as_str() > item_id))
        })
        .unwrap_or(rows.len());

    rows.insert(
        insert_idx,
        ProjectedTurnItem {
            position: insert_idx as u64,
            visibility: "local".to_owned(),
            source_thread_id: thread_id.to_owned(),
            source_item_id: item_id.to_owned(),
            item,
        },
    );
    for (idx, row) in rows.iter_mut().enumerate() {
        row.position = idx as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread_json(id: &str) -> serde_json::Value {
        json!({
            "id": id, "projectId": "p", "title": id, "providerInstanceId": "replay",
            "modelSelection": {"instanceId": "replay", "model": "m"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
        })
    }

    fn snapshot(id: &str, seq: u64) -> ThreadStreamItem {
        serde_json::from_value(json!({
            "kind": "snapshot", "snapshotSequence": seq,
            "projection": {"thread": thread_json(id), "updatedAt": "2026-01-01T00:00:00.000Z"}
        }))
        .unwrap()
    }

    fn message_event(thread: &str, seq: u64, text: &str) -> ThreadStreamItem {
        serde_json::from_value(json!({
            "kind": "event", "sequence": seq,
            "event": {"type": "turn-item.updated", "occurredAt": "2026-01-01T00:00:01.000Z",
                "payload": {"type": "assistant_message", "id": "i1", "threadId": thread, "ordinal": 0,
                    "status": "running", "updatedAt": "2026-01-01T00:00:01.000Z",
                    "messageId": "m1", "text": text, "streaming": true}}
        }))
        .unwrap()
    }

    fn assistant_text(state: &ThreadState) -> Option<String> {
        state
            .projection
            .as_ref()?
            .visible_turn_items
            .iter()
            .find_map(|row| match &row.item {
                TurnItem::AssistantMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
    }

    #[test]
    fn late_items_from_previous_thread_are_ignored() {
        let store = ThreadStore::new();
        store.reset(Some("a".to_owned()));
        assert!(store.apply_for("a", snapshot("a", 10)));
        store.reset(Some("b".to_owned()));
        // The old stream was still delivering when the user switched.
        assert!(!store.apply_for("a", message_event("a", 11, "stale")));
        assert!(!store.apply_for("a", snapshot("a", 12)));
        assert!(store.snapshot().projection.is_none());
        assert!(store.apply_for("b", snapshot("b", 5)));
        assert_eq!(store.snapshot().projection.unwrap().thread.id, "b");
    }

    #[test]
    fn replayed_thread_events_apply_once() {
        let store = ThreadStore::new();
        store.reset(Some("a".to_owned()));
        assert!(!store.apply_for("a", message_event("a", 9, "before snapshot")));
        store.apply_for("a", snapshot("a", 10));
        assert!(store.apply_for("a", message_event("a", 11, "one")));
        assert!(store.apply_for("a", message_event("a", 12, "one two")));
        let rev = store.snapshot().revision;
        // A resume from an older cursor replays 11 and 12.
        assert!(!store.apply_for("a", message_event("a", 11, "one")));
        assert!(!store.apply_for("a", message_event("a", 12, "one two")));
        assert_eq!(store.snapshot().revision, rev);
        assert_eq!(
            assistant_text(&store.snapshot()).as_deref(),
            Some("one two")
        );
        assert_eq!(store.snapshot().resume_cursor(), Some(12));
    }

    fn shell_thread_json(id: &str) -> serde_json::Value {
        let mut thread = thread_json(id);
        thread["status"] = json!("idle");
        thread["itemCount"] = json!(0);
        thread["visibleItemCount"] = json!(0);
        thread
    }

    #[test]
    fn replayed_shell_deltas_are_skipped() {
        let store = ShellStore::new();
        store.apply(
            serde_json::from_value(json!({"kind": "snapshot", "snapshot": {
                "schemaVersion": 2, "snapshotSequence": 20, "projects": [],
                "threads": [shell_thread_json("t")], "archivedThreads": []}}))
            .unwrap(),
        );
        let update = |seq: u64, title: &str| -> ShellStreamItem {
            let mut thread = shell_thread_json("t");
            thread["title"] = json!(title);
            serde_json::from_value(
                json!({"kind": "thread.updated", "sequence": seq, "location": "active", "thread": thread}),
            )
            .unwrap()
        };
        // The identity refresh that follows a snapshot carries no threads and must keep them.
        store.apply(
            serde_json::from_value(json!({"kind": "snapshot", "snapshot": {
                "schemaVersion": 2, "snapshotSequence": 20, "projects": [], "threads": [],
                "archivedThreads": []}, "resolvedRepositoryIdentityRoots": ["/w"]}))
            .unwrap(),
        );
        assert_eq!(store.snapshot().threads.len(), 1);
        store.apply(update(19, "older than snapshot"));
        assert_eq!(store.snapshot().threads[0].title, "t");
        store.apply(update(21, "new"));
        store.apply(update(21, "replayed"));
        assert_eq!(store.snapshot().threads[0].title, "new");
        assert_eq!(store.snapshot().last_sequence, 21);
    }
}
