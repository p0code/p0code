//! Scheduled tasks settings (`/settings/scheduled-tasks`): streams tasks via
//! `scheduledTasks.subscribe` and toggles enablement (`scheduledTasks.setEnabled`), runs tasks
//! immediately (`scheduledTasks.runNow`), and deletes tasks (`scheduledTasks.delete`).

use std::collections::HashMap;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    Context, FontWeight, IntoElement, ParentElement as _, SharedString, Styled as _, div, px,
};
use serde_json::Value;

use crate::app::P0App;
use crate::settings::web_url;
use crate::theme::AppPalette;

#[derive(Default)]
pub struct ScheduledTasksUiState {
    confirm_delete_id: Option<String>,
}

pub fn describe_schedule(schedule: &Value) -> String {
    match schedule.get("type").and_then(Value::as_str) {
        Some("interval") => {
            let ms = schedule.get("everyMs").and_then(Value::as_u64).unwrap_or(0);
            if ms >= 3_600_000 && ms.is_multiple_of(3_600_000) {
                format!("Every {}h", ms / 3_600_000)
            } else if ms >= 60_000 {
                format!("Every {}m", ms / 60_000)
            } else {
                format!("Every {}s", ms / 1000)
            }
        }
        Some("fixed_time") => {
            let tod = schedule
                .get("timeOfDay")
                .and_then(Value::as_str)
                .unwrap_or("??:??");
            let weekdays = schedule
                .get("weekdays")
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty());
            match weekdays {
                None => format!("Daily at {tod}"),
                Some(days) => {
                    let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
                    let list: Vec<&str> = days
                        .iter()
                        .filter_map(Value::as_u64)
                        .filter_map(|d| names.get(d as usize).copied())
                        .collect();
                    format!("{} at {tod}", list.join(", "))
                }
            }
        }
        Some("once") => {
            let at = schedule
                .get("runAt")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Once at {at}")
        }
        Some("webhook") => "Webhook".to_owned(),
        Some(other) => other.to_owned(),
        None => "Scheduled".to_owned(),
    }
}

impl P0App {
    pub(crate) fn render_scheduled_tasks(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.bridge.ensure_scheduled_tasks_subscribed();
        let web_tasks_url = web_url(self.bridge.base_url(), "/settings/scheduled-tasks");
        let Some(list) = self.bridge.scheduled_tasks() else {
            return div().flex().flex_col().gap(px(10.0)).child(
                div()
                    .text_sm()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(
                        self.i18n.get(p0_i18n::Key::Loading).to_owned(),
                    )),
            );
        };

        let shell = self.bridge.shell_state();
        let project_titles: HashMap<&str, &str> = shell
            .projects
            .iter()
            .map(|p| (p.id.as_str(), p.title.as_str()))
            .collect();

        let tz_note = list
            .time_zone
            .as_deref()
            .map(|tz| format!(" · {tz}"))
            .unwrap_or_default();
        let mut col = div().flex().flex_col().gap(px(12.0)).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(div().text_xs().text_color(palette.muted_foreground).child(
                    SharedString::from(format!("{} scheduled task(s){tz_note}", list.tasks.len())),
                ))
                .child(
                    Button::new("sched-open-web")
                        .label("Create / edit in browser".to_owned())
                        .compact()
                        .outline()
                        .on_click(move |_, _, cx| cx.open_url(&web_tasks_url)),
                ),
        );

        if list.tasks.is_empty() {
            return col.child(
                crate::feed::card(palette).child(
                    div()
                        .text_sm()
                        .text_color(palette.muted_foreground)
                        .child("No scheduled tasks configured on this environment."),
                ),
            );
        }

        for task in &list.tasks {
            let task_id_toggle = task.id.clone();
            let task_id_run = task.id.clone();
            let task_id_del = task.id.clone();
            let task_id_confirm = task.id.clone();
            let confirming = self
                .settings_ui
                .scheduled_tasks
                .confirm_delete_id
                .as_deref()
                == Some(task.id.as_str());
            let project_name = project_titles
                .get(task.project_id.as_str())
                .copied()
                .unwrap_or(&task.project_id);
            let sched_label = describe_schedule(&task.schedule);
            let status_dot = match task.last_run_status.as_str() {
                "succeeded" => palette.success,
                "running" => palette.warning,
                "failed" => palette.error,
                _ => palette.muted_foreground,
            };

            let mut card = crate::feed::card(palette)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .min_w_0()
                                .child(div().w(px(8.0)).h(px(8.0)).rounded_full().bg(status_dot))
                                .child(
                                    div()
                                        .text_sm()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(SharedString::from(task.title.clone())),
                                )
                                .child(div().text_xs().text_color(palette.muted_foreground).child(
                                    SharedString::from(format!("{sched_label} · {project_name}")),
                                )),
                        )
                        .child(
                            Switch::new(SharedString::from(format!("sched-en-{}", task.id)))
                                .checked(task.enabled)
                                .on_click(cx.listener(move |this, val: &bool, _, cx| {
                                    this.bridge
                                        .set_scheduled_task_enabled(task_id_toggle.clone(), *val);
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(task.prompt.clone())),
                );

            let mut meta = vec![format!(
                "Runs: {} (last: {})",
                task.run_count, task.last_run_status
            )];
            if let Some(next) = &task.next_run_at {
                meta.push(format!("Next: {next}"));
            }
            if let Some(last) = &task.last_run_at {
                meta.push(format!("Last: {last}"));
            }
            card = card.child(
                div()
                    .text_xs()
                    .font_family("monospace")
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(meta.join(" · "))),
            );
            if let Some(err) = &task.last_run_error {
                card = card.child(
                    div()
                        .text_xs()
                        .text_color(palette.error)
                        .child(SharedString::from(format!("Last error: {err}"))),
                );
            }
            if let Some(reason) = &task.blocked_by_policy {
                card = card.child(
                    div()
                        .text_xs()
                        .text_color(palette.warning)
                        .child(SharedString::from(format!("Blocked by policy: {reason}"))),
                );
            }

            let mut actions = div().flex().items_center().gap(px(6.0)).child(
                Button::new(SharedString::from(format!("sched-run-{}", task.id)))
                    .label("Run now".to_owned())
                    .compact()
                    .outline()
                    .on_click(cx.listener(move |this, _, _, _| {
                        this.bridge.run_scheduled_task_now(task_id_run.clone());
                    })),
            );
            if confirming {
                actions = actions
                    .child(
                        Button::new(SharedString::from(format!("sched-del-yes-{}", task.id)))
                            .label("Confirm delete".to_owned())
                            .compact()
                            .danger()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.settings_ui.scheduled_tasks.confirm_delete_id = None;
                                this.bridge.delete_scheduled_task(task_id_confirm.clone());
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("sched-del-no-{}", task.id)))
                            .label(self.i18n.tr("Cancel").to_owned())
                            .compact()
                            .outline()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.settings_ui.scheduled_tasks.confirm_delete_id = None;
                                cx.notify();
                            })),
                    );
            } else {
                actions = actions.child(
                    Button::new(SharedString::from(format!("sched-del-{}", task.id)))
                        .label(self.i18n.tr("Delete").to_owned())
                        .compact()
                        .outline()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.settings_ui.scheduled_tasks.confirm_delete_id =
                                Some(task_id_del.clone());
                            cx.notify();
                        })),
                );
            }
            card = card.child(actions);
            col = col.child(card);
        }

        col
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describes_scheduled_task_triggers() {
        assert_eq!(
            describe_schedule(&json!({"type": "interval", "everyMs": 900_000})),
            "Every 15m"
        );
        assert_eq!(
            describe_schedule(&json!({"type": "interval", "everyMs": 7_200_000})),
            "Every 2h"
        );
        assert_eq!(
            describe_schedule(&json!({"type": "fixed_time", "timeOfDay": "09:30"})),
            "Daily at 09:30"
        );
        assert_eq!(
            describe_schedule(
                &json!({"type": "fixed_time", "timeOfDay": "08:00", "weekdays": [1, 3, 5]})
            ),
            "Mon, Wed, Fri at 08:00"
        );
        assert_eq!(describe_schedule(&json!({"type": "webhook"})), "Webhook");
    }
}
