//! Maintenance settings (`/settings/maintenance`): updates, background activity profile,
//! storage retention rules, manual storage cleanup (`server.getStorageCleanupReport` /
//! `server.runStorageCleanup`), and database storage (`server.getDatabaseStorage` /
//! `server.reclaimDatabaseSpace`).

use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    AppContext as _, Context, Entity, FontWeight, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use serde_json::{Value, json};

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::general::section_heading;
use crate::settings::setting_row;
use crate::theme::AppPalette;

const MAX_RETENTION_DAYS: u64 = 3650;
const DEFAULT_RETENTION_DAYS: u64 = 8;

#[derive(Default)]
pub struct MaintenanceUiState {
    storage_requested: bool,
    artifacts_days_input: Option<Entity<InputState>>,
    logs_days_input: Option<Entity<InputState>>,
    confirm_reclaim: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaintenanceServerSettings {
    pub enable_provider_update_checks: bool,
    pub continue_threads_after_server_update: bool,
    pub keep_awake_while_agents_work: bool,
    pub background_profile: String,
    pub has_background_overrides: bool,
    pub browser_artifacts_after_days: Option<u64>,
    pub logs_after_days: Option<u64>,
    pub has_any_cleanup_rule: bool,
}

impl MaintenanceServerSettings {
    pub fn from_json(settings: &Value) -> Self {
        let bool_or = |key: &str, default: bool| {
            settings
                .get(key)
                .and_then(Value::as_bool)
                .unwrap_or(default)
        };
        let bg = settings.get("backgroundActivity");
        let background_profile = bg
            .and_then(|v| v.get("profile"))
            .and_then(Value::as_str)
            .unwrap_or("balanced")
            .to_owned();
        let has_background_overrides = bg
            .and_then(|v| v.get("overrides"))
            .and_then(Value::as_object)
            .is_some_and(|m| !m.is_empty());

        let sc = settings.get("storageCleanup");
        let browser_artifacts_after_days = sc
            .and_then(|v| v.get("browserArtifactsAfterDays"))
            .and_then(Value::as_u64);
        let logs_after_days = sc
            .and_then(|v| v.get("logsAfterDays"))
            .and_then(Value::as_u64);
        let worktree_rules = sc.is_some_and(|v| {
            v.get("worktreeAfterDays").and_then(Value::as_u64).is_some()
                || v.get("worktreeSettledAfterDays")
                    .and_then(Value::as_u64)
                    .is_some()
                || v.get("worktreeOnMerge")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                || v.get("worktreeOnDelete")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                || v.get("worktreeUnchanged")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        });
        let has_any_cleanup_rule =
            browser_artifacts_after_days.is_some() || logs_after_days.is_some() || worktree_rules;

        Self {
            enable_provider_update_checks: bool_or("enableProviderUpdateChecks", true),
            continue_threads_after_server_update: bool_or("continueThreadsAfterServerUpdate", true),
            keep_awake_while_agents_work: bool_or("keepAwakeWhileAgentsWork", true),
            background_profile,
            has_background_overrides,
            browser_artifacts_after_days,
            logs_after_days,
            has_any_cleanup_rule,
        }
    }
}

pub fn parse_retention_days(raw: &str) -> Option<u64> {
    let val = raw.trim().parse::<u64>().ok()?;
    (1..=MAX_RETENTION_DAYS).contains(&val).then_some(val)
}

pub fn format_bytes(bytes: f64) -> String {
    if bytes < 1024.0 {
        format!("{} B", bytes.max(0.0).round() as u64)
    } else if bytes < 1024.0 * 1024.0 {
        format!("{:.1} KiB", bytes / 1024.0)
    } else if bytes < 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} MiB", bytes / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GiB", bytes / (1024.0 * 1024.0 * 1024.0))
    }
}

impl P0App {
    pub(crate) fn render_maintenance(
        &mut self,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if !self.settings_ui.maintenance.storage_requested {
            self.settings_ui.maintenance.storage_requested = true;
            self.bridge.ensure_storage_subscribed();
        }
        let Some(settings) = self.bridge.server_settings() else {
            return div()
                .text_sm()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(
                    self.i18n.get(p0_i18n::Key::Loading).to_owned(),
                ));
        };
        let maint = MaintenanceServerSettings::from_json(&settings);
        let mut col = div().flex().flex_col().gap(px(12.0));

        // 1. Updates
        col = col.child(section_heading(self.i18n.tr("Updates"), palette));
        let update_rows: [(&str, &str, &str, bool); 2] = [
            (
                "enableProviderUpdateChecks",
                "Provider update checks",
                "Check installed provider CLIs for newer available versions and fetch model catalog updates.",
                maint.enable_provider_update_checks,
            ),
            (
                "continueThreadsAfterServerUpdate",
                "Continue threads after restarts",
                "Automatically resume interrupted threads after an update, crash, or machine restart.",
                maint.continue_threads_after_server_update,
            ),
        ];
        for (key, label, desc, checked) in update_rows {
            col = col.child(setting_row(
                self.i18n.tr(label),
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(self.i18n.tr(desc).to_owned())),
                    )
                    .child(
                        div().flex_none().child(
                            Switch::new(SharedString::from(format!("maint-{key}")))
                                .checked(checked)
                                .on_click(cx.listener(move |this, val: &bool, _, cx| {
                                    this.bridge.update_settings(json!({ key: *val }));
                                    cx.notify();
                                })),
                        ),
                    ),
                palette,
            ));
        }

        // 2. Background activity
        col = col.child(section_heading(
            self.i18n.tr("Background activity"),
            palette,
        ));
        let mut profiles = div().flex().flex_wrap().gap(px(6.0));
        for (id, label) in [
            ("balanced", "Balanced"),
            ("performance", "Performance"),
            ("battery-saver", "Battery saver"),
        ] {
            let selected = maint.background_profile == id && !maint.has_background_overrides;
            profiles = profiles.child(
                choice(
                    format!("maint-bg-{id}"),
                    self.i18n.tr(label).to_owned(),
                    selected,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bridge.update_settings(json!({
                        "backgroundActivity": {
                            "schemaVersion": 1,
                            "profile": id,
                            "overrides": {}
                        }
                    }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Background activity profile"),
            div()
                .flex()
                .flex_col()
                .items_start()
                .gap(px(4.0))
                .child(profiles)
                .children(maint.has_background_overrides.then(|| {
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(format!(
                            "Custom interval overrides active (base: {}). Selecting a profile resets overrides.",
                            maint.background_profile
                        )))
                })),
            palette,
        ));
        col = col.child(setting_row(
            self.i18n.tr("Keep awake while agents work"),
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(
                            self.i18n
                                .tr("Stop the computer from going to sleep while agents are working, and let it sleep once they finish. Closing a laptop lid still puts it to sleep.")
                                .to_owned(),
                        )),
                )
                .child(
                    div().flex_none().child(
                        Switch::new("maint-keep-awake")
                            .checked(maint.keep_awake_while_agents_work)
                            .on_click(cx.listener(|this, val: &bool, _, cx| {
                                this.bridge
                                    .update_settings(json!({ "keepAwakeWhileAgentsWork": *val }));
                                cx.notify();
                            })),
                    ),
                ),
            palette,
        ));

        // 3. Artifacts and logs
        col = col.child(section_heading(self.i18n.tr("Artifacts and logs"), palette));

        let artifacts_str = maint
            .browser_artifacts_after_days
            .unwrap_or(DEFAULT_RETENTION_DAYS)
            .to_string();
        let artifacts_in = self
            .settings_ui
            .maintenance
            .artifacts_days_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder("8");
                    st.set_value(artifacts_str, window, cx);
                    st
                })
            })
            .clone();
        col = col.child(self.render_retention_row(
            "browserArtifactsAfterDays",
            "Delete old browser artifacts",
            maint.browser_artifacts_after_days,
            artifacts_in,
            palette,
            cx,
        ));

        let logs_str = maint
            .logs_after_days
            .unwrap_or(DEFAULT_RETENTION_DAYS)
            .to_string();
        let logs_in = self
            .settings_ui
            .maintenance
            .logs_days_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder("8");
                    st.set_value(logs_str, window, cx);
                    st
                })
            })
            .clone();
        col = col.child(self.render_retention_row(
            "logsAfterDays",
            "Delete old rotated logs",
            maint.logs_after_days,
            logs_in,
            palette,
            cx,
        ));

        // 4. Cleanup run + report
        col = col.child(section_heading(self.i18n.tr("Cleanup"), palette));
        let report_state = self.bridge.storage_cleanup_report();
        let summary = match &report_state {
            None => self.i18n.tr("Loading last run…").to_owned(),
            Some(None) => {
                if maint.has_any_cleanup_rule {
                    self.i18n.tr("Cleanup hasn't run yet.").to_owned()
                } else {
                    self.i18n
                        .tr("Turn on a cleanup rule to use this.")
                        .to_owned()
                }
            }
            Some(Some(r)) => format!(
                "Last {} run finished {}: {} recovered ({} removed, {} kept, {} failed).",
                r.trigger,
                r.finished_at,
                format_bytes(r.bytes_freed),
                r.counts.removed,
                r.counts.kept,
                r.counts.failed
            ),
        };
        let can_run_cleanup = maint.has_any_cleanup_rule;
        col = col.child(setting_row(
            self.i18n.tr("Run cleanup"),
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(10.0))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(summary)),
                )
                .child(
                    div().flex_none().flex().items_center().gap(px(6.0)).child(
                        Button::new("maint-cleanup-run")
                            .label(self.i18n.tr("Delete now").to_owned())
                            .compact()
                            .outline()
                            .disabled(!can_run_cleanup)
                            .on_click(cx.listener(|this, _, _, _| {
                                this.bridge.run_storage_cleanup();
                            })),
                    ),
                ),
            palette,
        ));
        if let Some(Some(report)) = &report_state
            && !report.entries.is_empty()
        {
            let mut list = crate::feed::card(palette);
            for entry in report.entries.iter().take(10) {
                let bytes_txt = entry
                    .bytes
                    .map(format_bytes)
                    .map(|b| format!(" · {b}"))
                    .unwrap_or_default();
                list = list.child(
                    div()
                        .text_xs()
                        .text_color(if entry.outcome == "failed" {
                            palette.error
                        } else {
                            palette.muted_foreground
                        })
                        .child(SharedString::from(format!(
                            "[{} / {}] {}{}",
                            entry.kind, entry.outcome, entry.reason, bytes_txt
                        ))),
                );
            }
            if report.entries.len() > 10 || report.omitted_count > 0 {
                let extra = report.entries.len().saturating_sub(10) as u64 + report.omitted_count;
                list = list.child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(format!("+{extra} more results"))),
                );
            }
            col = col.child(list);
        }

        // 5. Database storage
        col = col.child(section_heading(self.i18n.tr("Database"), palette));
        match self.bridge.database_storage() {
            None => {
                col = col.child(div().text_xs().text_color(palette.muted_foreground).child(
                    SharedString::from(self.i18n.get(p0_i18n::Key::Loading).to_owned()),
                ));
            }
            Some(None) => {
                col = col.child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(
                            self.i18n
                                .tr("Database storage metrics are unavailable on this server.")
                                .to_owned(),
                        )),
                );
            }
            Some(Some(db)) => {
                let mut db_card = crate::feed::card(palette)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(
                                SharedString::from(format!(
                                    "Size: {} · Reclaimable: {}",
                                    format_bytes(db.database_bytes),
                                    format_bytes(db.reclaimable_bytes)
                                )),
                            ))
                            .child(
                                div().text_xs().text_color(palette.muted_foreground).child(
                                    SharedString::from(
                                        self.i18n
                                            .tr(if db.incremental_vacuum_enabled {
                                                "Incremental vacuum: on"
                                            } else {
                                                "Incremental vacuum: off"
                                            })
                                            .to_owned(),
                                    ),
                                ),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .font_family("monospace")
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(format!(
                                "Offline compact: {}",
                                db.compact_command
                            ))),
                    );
                if let Some(failure) = &db.reclaim_failure {
                    db_card = db_card.child(div().text_xs().text_color(palette.error).child(
                        SharedString::from(format!("Last reclaim failed: {failure}")),
                    ));
                }
                if db.can_reclaim == Some(true) && db.reclaimable_bytes > 0.0 {
                    if self.settings_ui.maintenance.confirm_reclaim {
                        db_card = db_card.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(palette.warning)
                                        .child(SharedString::from(
                                        self.i18n
                                            .tr("This restarts the server to reclaim free pages.")
                                            .to_owned(),
                                    )),
                                )
                                .child(
                                    Button::new("maint-reclaim-confirm")
                                        .label(self.i18n.tr("Restart and reclaim").to_owned())
                                        .compact()
                                        .danger()
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.settings_ui.maintenance.confirm_reclaim = false;
                                            this.bridge.reclaim_database_space();
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    Button::new("maint-reclaim-cancel")
                                        .label(self.i18n.tr("Cancel").to_owned())
                                        .compact()
                                        .outline()
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.settings_ui.maintenance.confirm_reclaim = false;
                                            cx.notify();
                                        })),
                                ),
                        );
                    } else {
                        db_card = db_card.child(
                            div().flex().child(
                                Button::new("maint-reclaim-start")
                                    .label(self.i18n.tr("Reclaim freed database space").to_owned())
                                    .compact()
                                    .outline()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.settings_ui.maintenance.confirm_reclaim = true;
                                        cx.notify();
                                    })),
                            ),
                        );
                    }
                }
                col = col.child(db_card);
            }
        }

        // 6. Diagnostics shortcut
        col = col.child(section_heading(self.i18n.tr("Diagnostics"), palette));
        col = col.child(setting_row(
            self.i18n.tr("Diagnostics"),
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(
                            self.i18n
                                .tr("Inspect processes, resource use, and logs on this environment.")
                                .to_owned(),
                        )),
                )
                .child(
                    div().flex_none().child(
                        Button::new("maint-open-diagnostics")
                            .label(self.i18n.tr("View diagnostics").to_owned())
                            .compact()
                            .outline()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.open_settings("/settings/diagnostics", cx);
                            })),
                    ),
                ),
            palette,
        ));

        col
    }

    fn render_retention_row(
        &self,
        field_key: &'static str,
        label: &'static str,
        value: Option<u64>,
        input: Entity<InputState>,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let enabled = value.is_some();
        let save_in = input.clone();
        let toggle_in = input.clone();
        let mut controls = div().flex().items_center().gap(px(8.0));
        if enabled {
            controls = controls
                .child(div().w(px(72.0)).child(Input::new(&input)))
                .child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(self.i18n.tr("days").to_owned())),
                )
                .child(
                    Button::new(SharedString::from(format!("maint-save-{field_key}")))
                        .label(self.i18n.tr("Save").to_owned())
                        .compact()
                        .primary()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let raw = save_in.read(cx).value().to_string();
                            if let Some(days) = parse_retention_days(&raw) {
                                this.bridge.update_settings(
                                    json!({ "storageCleanup": { field_key: days } }),
                                );
                                cx.notify();
                            }
                        })),
                );
        } else {
            controls = controls.child(
                div()
                    .text_xs()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(self.i18n.tr("Off").to_owned())),
            );
        }
        controls = controls.child(
            Switch::new(SharedString::from(format!("maint-toggle-{field_key}")))
                .checked(enabled)
                .on_click(cx.listener(move |this, on: &bool, _, cx| {
                    let next = if *on {
                        let raw = toggle_in.read(cx).value().to_string();
                        json!(parse_retention_days(&raw).unwrap_or(DEFAULT_RETENTION_DAYS))
                    } else {
                        Value::Null
                    };
                    this.bridge
                        .update_settings(json!({ "storageCleanup": { field_key: next } }));
                    cx.notify();
                })),
        );
        setting_row(self.i18n.tr(label), controls, palette)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_maintenance_settings_and_retention_days() {
        let defaults = MaintenanceServerSettings::from_json(&json!({}));
        assert!(defaults.enable_provider_update_checks);
        assert!(defaults.continue_threads_after_server_update);
        assert!(defaults.keep_awake_while_agents_work);
        assert_eq!(defaults.background_profile, "balanced");
        assert!(!defaults.has_background_overrides);
        assert_eq!(defaults.browser_artifacts_after_days, None);
        assert_eq!(defaults.logs_after_days, None);
        assert!(!defaults.has_any_cleanup_rule);

        let custom = MaintenanceServerSettings::from_json(&json!({
            "enableProviderUpdateChecks": false,
            "backgroundActivity": {
                "schemaVersion": 1,
                "profile": "battery-saver",
                "overrides": { "pauseWhenOnBattery": true }
            },
            "storageCleanup": {
                "logsAfterDays": 14,
                "browserArtifactsAfterDays": null
            }
        }));
        assert!(!custom.enable_provider_update_checks);
        assert_eq!(custom.background_profile, "battery-saver");
        assert!(custom.has_background_overrides);
        assert_eq!(custom.logs_after_days, Some(14));
        assert!(custom.has_any_cleanup_rule);

        assert_eq!(parse_retention_days("0"), None);
        assert_eq!(parse_retention_days("1"), Some(1));
        assert_eq!(parse_retention_days("3650"), Some(3650));
        assert_eq!(parse_retention_days("3651"), None);
        assert_eq!(format_bytes(512.0), "512 B");
        assert_eq!(format_bytes(2048.0), "2.0 KiB");
        assert_eq!(format_bytes(5.0 * 1024.0 * 1024.0), "5.0 MiB");
    }
}
