//! Archived threads settings (`/settings/archived`): fetches archived threads via
//! `orchestration.getArchivedShellSnapshot` and dispatches `thread.unarchive` / `thread.delete`.

use std::collections::BTreeMap;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::{
    Context, FontWeight, IntoElement, ParentElement as _, SharedString, Styled as _, div, px,
};
use p0_protocol::{ProjectShell, ThreadShell};

use crate::app::P0App;
use crate::settings::general::section_heading;
use crate::theme::AppPalette;

#[derive(Default)]
pub struct ArchivedUiState {
    requested: bool,
    confirm_delete_id: Option<String>,
}

pub fn group_archived_threads<'a>(
    projects: &'a [ProjectShell],
    threads: &'a [ThreadShell],
) -> Vec<(String, Vec<&'a ThreadShell>)> {
    let project_titles: BTreeMap<&str, &str> = projects
        .iter()
        .map(|p| (p.id.as_str(), p.title.as_str()))
        .collect();
    let mut grouped: BTreeMap<String, Vec<&'a ThreadShell>> = BTreeMap::new();
    for thread in threads.iter().filter(|t| t.deleted_at.is_none()) {
        let title = project_titles
            .get(thread.project_id.as_str())
            .copied()
            .filter(|s| !s.is_empty())
            .unwrap_or("No project")
            .to_owned();
        grouped.entry(title).or_default().push(thread);
    }
    for list in grouped.values_mut() {
        list.sort_by(|a, b| {
            let a_key = a.archived_at.as_deref().unwrap_or(&a.created_at);
            let b_key = b.archived_at.as_deref().unwrap_or(&b.created_at);
            b_key.cmp(a_key).then_with(|| b.id.cmp(&a.id))
        });
    }
    grouped.into_iter().collect()
}

fn short_iso_date(ts: &str) -> &str {
    ts.get(..10).unwrap_or(ts)
}

impl P0App {
    pub(crate) fn render_archived(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if !self.settings_ui.archived.requested {
            self.settings_ui.archived.requested = true;
            self.bridge.refresh_archived_threads();
        }

        let mut col = div().flex().flex_col().gap(px(10.0)).child(
            div().child(
                Button::new("archived-refresh")
                    .label(self.i18n.tr("Refresh").to_owned())
                    .compact()
                    .outline()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.bridge.refresh_archived_threads();
                        cx.notify();
                    })),
            ),
        );

        let snap = self.bridge.archived_snapshot();
        let (projects, threads) = match snap.as_ref() {
            Some(s) => (s.projects.as_slice(), s.threads.as_slice()),
            None => (
                self.shell.projects.as_slice(),
                self.shell.archived_threads.as_slice(),
            ),
        };

        if snap.is_none() && threads.is_empty() {
            return col.child(div().text_sm().text_color(palette.muted_foreground).child(
                SharedString::from(self.i18n.tr("Loading archived threads").to_owned()),
            ));
        }

        let groups = group_archived_threads(projects, threads);
        if groups.is_empty() {
            return col.child(
                crate::feed::card(palette)
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(
                        SharedString::from(self.i18n.tr("No archived threads").to_owned()),
                    ))
                    .child(
                        div().text_xs().text_color(palette.muted_foreground).child(
                            SharedString::from(
                                self.i18n
                                    .tr("Archived threads will appear here.")
                                    .to_owned(),
                            ),
                        ),
                    ),
            );
        }

        let confirm_delete_id = self.settings_ui.archived.confirm_delete_id.clone();
        let require_confirm = self.prefs.confirm_thread_delete;

        for (project_title, project_threads) in groups {
            col = col.child(section_heading(&project_title, palette));
            for thread in project_threads {
                let tid = thread.id.clone();
                let unarchive_id = tid.clone();
                let delete_id = tid.clone();
                let confirm_id = tid.clone();
                let title = if thread.title.trim().is_empty() {
                    self.i18n.get(p0_i18n::Key::UntitledThread).to_owned()
                } else {
                    thread.title.clone()
                };
                let archived_date =
                    short_iso_date(thread.archived_at.as_deref().unwrap_or(&thread.created_at));
                let created_date = short_iso_date(&thread.created_at);
                let confirming = confirm_delete_id.as_deref() == Some(tid.as_str());

                let mut controls = div().flex().items_center().gap(px(6.0)).flex_none();
                if confirming {
                    controls = controls
                        .child(
                            Button::new(SharedString::from(format!("arch-del-ok-{tid}")))
                                .label(self.i18n.tr("Delete").to_owned())
                                .compact()
                                .danger()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.settings_ui.archived.confirm_delete_id = None;
                                    this.bridge.delete_thread(delete_id.clone());
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("arch-del-cancel-{tid}")))
                                .label(self.i18n.tr("Cancel").to_owned())
                                .compact()
                                .outline()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.settings_ui.archived.confirm_delete_id = None;
                                    cx.notify();
                                })),
                        );
                } else {
                    controls = controls
                        .child(
                            Button::new(SharedString::from(format!("arch-restore-{tid}")))
                                .label(self.i18n.tr("Unarchive").to_owned())
                                .compact()
                                .outline()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.bridge.unarchive_thread(unarchive_id.clone());
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("arch-del-{tid}")))
                                .label(self.i18n.tr("Delete").to_owned())
                                .compact()
                                .danger()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if require_confirm {
                                        this.settings_ui.archived.confirm_delete_id =
                                            Some(confirm_id.clone());
                                    } else {
                                        this.bridge.delete_thread(confirm_id.clone());
                                    }
                                    cx.notify();
                                })),
                        );
                }

                col = col.child(
                    crate::feed::card(palette).child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::MEDIUM)
                                            .truncate()
                                            .child(SharedString::from(title)),
                                    )
                                    .child(
                                        div().text_xs().text_color(palette.muted_foreground).child(
                                            SharedString::from(format!(
                                                "Archived {archived_date} · Created {created_date}"
                                            )),
                                        ),
                                    ),
                            )
                            .child(controls),
                    ),
                );
            }
        }
        col
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_project(id: &str, title: &str) -> ProjectShell {
        serde_json::from_value(json!({
            "id": id,
            "title": title,
            "workspaceRoot": "/tmp/p",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }))
        .unwrap()
    }

    fn sample_thread(id: &str, project_id: &str, archived_at: &str) -> ThreadShell {
        serde_json::from_value(json!({
            "id": id,
            "projectId": project_id,
            "title": id,
            "providerInstanceId": "replay",
            "modelSelection": {"instanceId": "replay", "model": "m"},
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "status": "idle",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "archivedAt": archived_at
        }))
        .unwrap()
    }

    #[test]
    fn groups_by_project_and_sorts_newest_archived_first() {
        let projects = vec![sample_project("p1", "Alpha")];
        let threads = vec![
            sample_thread("t-old", "p1", "2026-01-02T00:00:00.000Z"),
            sample_thread("t-new", "p1", "2026-01-05T00:00:00.000Z"),
            sample_thread("t-orphan", "missing", "2026-01-03T00:00:00.000Z"),
        ];
        let grouped = group_archived_threads(&projects, &threads);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].0, "Alpha");
        assert_eq!(grouped[0].1[0].id, "t-new");
        assert_eq!(grouped[0].1[1].id, "t-old");
        assert_eq!(grouped[1].0, "No project");
    }
}
