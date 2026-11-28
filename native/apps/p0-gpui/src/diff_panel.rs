//! Changes of the open thread: one turn's checkpoint diff, all turns, or the uncommitted
//! working tree, as `apps/web/src/components/DiffPanel.tsx` reads them. Rendering, syntax
//! colors and virtualization come from gpui-component's `Diff`.

use gpui_kit::component::diff::{Diff, DiffFile, DiffParseOptions, DiffState};
use gpui_kit::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};
use p0_protocol::{
    CHECKPOINT_DIFF_TRUNCATED_MARKER, Checkpoint, DiffPreviewInput, DiffPreviewResult,
    DiffSourceKind, FullThreadDiffInput, RPC_ORCHESTRATION_GET_FULL_THREAD_DIFF,
    RPC_ORCHESTRATION_GET_TURN_DIFF, RPC_REVIEW_GET_DIFF_PREVIEW, ThreadTurnDiff, TurnDiffInput,
};

use crate::app::P0App;
use crate::theme::AppPalette;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DiffSource {
    /// The checkpoint diff of one turn, by its thread-wide turn count.
    Turn(u64),
    /// Every turn up to the latest checkpoint.
    AllTurns(u64),
    /// Uncommitted changes in the thread's folder.
    WorkingTree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnSummary {
    pub turn: u64,
    pub files: u64,
    pub additions: u64,
    pub deletions: u64,
}

/// Turns with a checkpoint, newest first.
pub fn turn_summaries(checkpoints: &[Checkpoint]) -> Vec<TurnSummary> {
    let mut out: Vec<TurnSummary> = checkpoints
        .iter()
        .filter(|c| c.run_id.is_some())
        .filter_map(|c| {
            let (files, additions, deletions) = c.totals();
            Some(TurnSummary {
                turn: c.app_run_ordinal?,
                files,
                additions,
                deletions,
            })
        })
        .collect();
    out.sort_by_key(|t| std::cmp::Reverse(t.turn));
    out.dedup_by_key(|t| t.turn);
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Status {
    Idle,
    Loading,
    Ready,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Key {
    thread_id: String,
    cwd: Option<String>,
    source: DiffSource,
}

pub struct DiffPanel {
    state: Entity<DiffState>,
    thread_id: Option<String>,
    cwd: Option<String>,
    turns: Vec<TurnSummary>,
    /// `None` follows the latest turn (or the working tree when there is none).
    picked: Option<DiffSource>,
    shown: Option<Key>,
    status: Status,
    truncated: bool,
    files: Vec<(SharedString, usize, usize)>,
}

impl DiffPanel {
    pub fn new(cx: &mut Context<P0App>) -> Self {
        Self {
            state: cx.new(|cx| DiffState::new(Vec::new(), cx)),
            thread_id: None,
            cwd: None,
            turns: Vec::new(),
            picked: None,
            shown: None,
            status: Status::Idle,
            truncated: false,
            files: Vec::new(),
        }
    }

    /// Follows the open thread. A new checkpoint moves "latest turn" along with it.
    pub fn sync(&mut self, thread_id: Option<&str>, cwd: Option<&str>, checkpoints: &[Checkpoint]) {
        if self.thread_id.as_deref() != thread_id {
            self.picked = None;
            self.thread_id = thread_id.map(ToOwned::to_owned);
        }
        self.cwd = cwd.map(ToOwned::to_owned);
        self.turns = turn_summaries(checkpoints);
    }

    pub fn source(&self) -> DiffSource {
        self.picked.unwrap_or_else(|| match self.turns.first() {
            Some(t) => DiffSource::Turn(t.turn),
            None => DiffSource::WorkingTree,
        })
    }

    fn wanted(&self) -> Option<Key> {
        let source = self.source();
        let cwd = match source {
            DiffSource::WorkingTree => Some(self.cwd.clone()?),
            _ => None,
        };
        Some(Key {
            thread_id: self.thread_id.clone()?,
            cwd,
            source,
        })
    }
}

impl P0App {
    /// Starts a fetch when what the panel should show differs from what it shows.
    pub(crate) fn load_diff(&mut self, refresh: bool, cx: &mut Context<Self>) {
        let panel = &mut self.right_panel.diff;
        let Some(key) = panel.wanted() else {
            return;
        };
        if !refresh && panel.shown.as_ref() == Some(&key) {
            return;
        }
        panel.shown = Some(key.clone());
        panel.status = Status::Loading;
        let bridge = self.bridge.clone();
        let fetch_key = key.clone();
        cx.spawn(async move |this, cx| {
            let patch = match fetch_key.source {
                DiffSource::Turn(turn) => bridge
                    .query::<_, ThreadTurnDiff>(
                        RPC_ORCHESTRATION_GET_TURN_DIFF,
                        TurnDiffInput {
                            thread_id: fetch_key.thread_id.clone(),
                            from_turn_count: turn.saturating_sub(1),
                            to_turn_count: turn,
                        },
                    )
                    .await
                    .map(|d| d.combined()),
                DiffSource::AllTurns(turn) => bridge
                    .query::<_, ThreadTurnDiff>(
                        RPC_ORCHESTRATION_GET_FULL_THREAD_DIFF,
                        FullThreadDiffInput {
                            thread_id: fetch_key.thread_id.clone(),
                            to_turn_count: turn,
                        },
                    )
                    .await
                    .map(|d| d.combined()),
                DiffSource::WorkingTree => bridge
                    .query::<_, DiffPreviewResult>(
                        RPC_REVIEW_GET_DIFF_PREVIEW,
                        DiffPreviewInput {
                            cwd: fetch_key.cwd.clone().unwrap_or_default(),
                            source_kind: DiffSourceKind::WorkingTree,
                        },
                    )
                    .await
                    .map(|r| {
                        let truncated = r.sources.iter().any(|s| s.truncated);
                        let mut text: String = r.sources.into_iter().map(|s| s.diff).collect();
                        if truncated {
                            text.push_str(CHECKPOINT_DIFF_TRUNCATED_MARKER);
                        }
                        text
                    }),
            };
            let parsed = cx
                .background_spawn(async move { patch.and_then(|p| parse_patch(&p)) })
                .await;
            this.update(cx, |app, cx| {
                let panel = &mut app.right_panel.diff;
                if panel.shown.as_ref() != Some(&fetch_key) {
                    return;
                }
                match parsed {
                    Ok((files, truncated)) => {
                        panel.files = files
                            .iter()
                            .map(|f| (f.path().clone(), f.additions(), f.deletions()))
                            .collect();
                        panel.truncated = truncated;
                        panel.status = Status::Ready;
                        panel.state.update(cx, |s, cx| s.set_files(files, cx));
                    }
                    Err(err) => {
                        panel.files.clear();
                        panel.status = Status::Failed(err);
                        panel.state.update(cx, |s, cx| s.set_files(Vec::new(), cx));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn pick_diff_source(&mut self, source: DiffSource, cx: &mut Context<Self>) {
        self.right_panel.diff.picked = Some(source);
        self.load_diff(false, cx);
        cx.notify();
    }

    pub(crate) fn render_diff_panel(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.load_diff(false, cx);
        let panel = &self.right_panel.diff;
        let current = panel.source();
        let chip = |id: SharedString, label: String, selected: bool, source: DiffSource| {
            div()
                .id(id)
                .flex_none()
                .px(px(8.0))
                .py(px(3.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_xs()
                .border_1()
                .border_color(if selected {
                    palette.primary
                } else {
                    palette.border
                })
                .text_color(if selected {
                    palette.foreground
                } else {
                    palette.muted_foreground
                })
                .hover(|s| s.bg(palette.row_hover))
                .on_click(cx.listener(move |this, _, _, cx| this.pick_diff_source(source, cx)))
                .child(SharedString::from(label))
        };

        let mut sources = div()
            .id("diff-sources")
            .flex()
            .gap(px(6.0))
            .px(px(10.0))
            .py(px(8.0))
            .overflow_x_scroll()
            .border_b_1()
            .border_color(palette.border);
        if let Some(latest) = panel.turns.first() {
            sources = sources.child(chip(
                "diff-src-all".into(),
                self.i18n.tr("All turns").to_owned(),
                current == DiffSource::AllTurns(latest.turn),
                DiffSource::AllTurns(latest.turn),
            ));
        }
        for t in &panel.turns {
            let label = format!(
                "{}  +{} −{}",
                self.i18n
                    .tr_format("Turn {count}", &[("count", &t.turn.to_string())]),
                t.additions,
                t.deletions
            );
            sources = sources.child(chip(
                SharedString::from(format!("diff-src-turn-{}", t.turn)),
                label,
                current == DiffSource::Turn(t.turn),
                DiffSource::Turn(t.turn),
            ));
        }
        sources = sources.child(chip(
            "diff-src-uncommitted".into(),
            self.i18n.tr("Uncommitted").to_owned(),
            current == DiffSource::WorkingTree,
            DiffSource::WorkingTree,
        ));

        let notice = |text: String| {
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .p(px(16.0))
                .text_sm()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(text))
                .into_any_element()
        };
        let body = match &panel.status {
            Status::Idle | Status::Loading => notice(self.i18n.tr("Loading changes...").to_owned()),
            Status::Failed(err) => notice(err.clone()),
            Status::Ready if panel.files.is_empty() => {
                notice(self.i18n.tr("No net changes in this selection.").to_owned())
            }
            Status::Ready => {
                let mut file_list = div()
                    .id("diff-file-list")
                    .flex_none()
                    .max_h(px(140.0))
                    .overflow_y_scroll()
                    .py(px(4.0))
                    .border_b_1()
                    .border_color(palette.border);
                for (ix, (path, additions, deletions)) in panel.files.iter().enumerate() {
                    let target = path.clone();
                    file_list = file_list.child(
                        div()
                            .id(("diff-file", ix))
                            .flex()
                            .justify_between()
                            .gap(px(8.0))
                            .px(px(10.0))
                            .py(px(2.0))
                            .cursor_pointer()
                            .hover(|s| s.bg(palette.row_hover))
                            .text_xs()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let path = target.clone();
                                this.right_panel
                                    .diff
                                    .state
                                    .update(cx, |s, cx| s.scroll_to_file(&path, cx));
                            }))
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .font_family("monospace")
                                    .text_color(palette.foreground)
                                    .child(path.clone()),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .flex()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .text_color(palette.success)
                                            .child(SharedString::from(format!("+{additions}"))),
                                    )
                                    .child(
                                        div()
                                            .text_color(palette.error)
                                            .child(SharedString::from(format!("−{deletions}"))),
                                    ),
                            ),
                    );
                }
                let mut col = div().flex_1().min_h_0().flex().flex_col().child(file_list);
                if panel.truncated {
                    col = col.child(
                        div()
                            .flex_none()
                            .px(px(10.0))
                            .py(px(4.0))
                            .text_xs()
                            .bg(palette.warning_surface)
                            .text_color(palette.warning)
                            .child(SharedString::from(
                                self.i18n
                                    .tr("This preview exceeds the size limit. Changes shown are incomplete.")
                                    .to_owned(),
                            )),
                    );
                }
                col.child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .child(Diff::new(&panel.state).size_full()),
                )
                .into_any_element()
            }
        };

        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .child(div().flex_1().min_w_0().child(sources))
                    .child(
                        div()
                            .id("diff-refresh")
                            .flex_none()
                            .px(px(10.0))
                            .cursor_pointer()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(palette.muted_foreground)
                            .hover(|s| s.text_color(palette.foreground))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.load_diff(true, cx);
                                cx.notify();
                            }))
                            .child("↻"),
                    ),
            )
            .child(body)
    }
}

/// Parses a patch, accepting a tail cut at the server's size limit.
fn parse_patch(patch: &str) -> Result<(Vec<DiffFile>, bool), String> {
    let (body, truncated) = match patch.strip_suffix(CHECKPOINT_DIFF_TRUNCATED_MARKER) {
        Some(body) => (body, true),
        None => (patch, false),
    };
    if body.trim().is_empty() {
        return Ok((Vec::new(), truncated));
    }
    DiffFile::parse_with(body, DiffParseOptions::new().truncated_hunks(truncated))
        .map(|files| (files, truncated))
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(turn: Option<u64>, run: Option<&str>, adds: u64) -> Checkpoint {
        Checkpoint {
            id: format!("cp-{turn:?}-{run:?}"),
            run_id: run.map(ToOwned::to_owned),
            app_run_ordinal: turn,
            status: "ready".into(),
            files: vec![p0_protocol::CheckpointFileSummary {
                path: "a".into(),
                kind: "modified".into(),
                additions: adds,
                deletions: 0,
            }],
            files_total: None,
            captured_at: String::new(),
        }
    }

    #[test]
    fn summaries_are_newest_first_and_skip_baselines() {
        let turns = turn_summaries(&[
            checkpoint(Some(1), Some("r1"), 2),
            checkpoint(None, None, 9),
            checkpoint(Some(2), Some("r2"), 5),
        ]);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].turn, 2);
        assert_eq!(turns[0].additions, 5);
    }

    #[test]
    fn parses_truncated_patch() {
        let patch = format!(
            "diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1,3 +1,3 @@\n-a\n+b\n{CHECKPOINT_DIFF_TRUNCATED_MARKER}"
        );
        let (files, truncated) = parse_patch(&patch).unwrap();
        assert!(truncated);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].additions(), 1);
        assert!(parse_patch("").unwrap().0.is_empty());
    }
}
