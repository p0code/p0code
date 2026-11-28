//! Threads settings (`/settings/threads`): new project defaults, usage limits auto-resume/snooze,
//! hidden auto-archive, auto-settle rules, response streaming mode, and thread title instructions
//! via `server.updateSettings`.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use serde_json::{Value, json};

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::general::section_heading;
use crate::settings::setting_row;
use crate::theme::AppPalette;

const DEFAULT_HIDDEN_AUTO_ARCHIVE_DAYS: u64 = 30;
const MAX_HIDDEN_AUTO_ARCHIVE_DAYS: u64 = 365;
const DEFAULT_AUTO_SETTLE_DAYS: u64 = 7;
const MAX_AUTO_SETTLE_DAYS: u64 = 90;

#[derive(Default)]
pub struct ThreadsUiState {
    base_dir_input: Option<Entity<InputState>>,
    hidden_archive_days_input: Option<Entity<InputState>>,
    auto_settle_days_input: Option<Entity<InputState>>,
    title_instructions_input: Option<Entity<InputState>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadsServerSettings {
    pub add_project_base_directory: String,
    pub ghq_clone_layout: bool,
    pub default_thread_env_mode: Option<String>,
    pub auto_resume_limited_threads: bool,
    pub snooze_limited_threads: bool,
    pub hidden_auto_archive_after_days: Option<u64>,
    pub sidebar_auto_settle_on_merge: bool,
    pub sidebar_auto_settle_after_days: Option<u64>,
    pub sidebar_auto_settle_keep_pull_requests: bool,
    pub response_streaming_mode: String,
    pub thread_title_instructions: String,
}

impl ThreadsServerSettings {
    pub fn from_json(settings: &Value) -> Self {
        let bool_or = |key: &str, default: bool| {
            settings
                .get(key)
                .and_then(Value::as_bool)
                .unwrap_or(default)
        };
        let str_or = |key: &str, default: &str| {
            settings
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or(default)
                .to_owned()
        };
        let opt_days = |key: &str, default: Option<u64>| match settings.get(key) {
            Some(Value::Null) => None,
            Some(v) => v.as_u64().or(default),
            None => default,
        };
        Self {
            add_project_base_directory: str_or("addProjectBaseDirectory", ""),
            ghq_clone_layout: bool_or("ghqCloneLayout", false),
            default_thread_env_mode: settings
                .get("defaultThreadEnvMode")
                .and_then(Value::as_str)
                .map(str::to_owned),
            auto_resume_limited_threads: bool_or("autoResumeLimitedThreads", false),
            snooze_limited_threads: bool_or("snoozeLimitedThreads", false),
            hidden_auto_archive_after_days: opt_days(
                "hiddenAutoArchiveAfterDays",
                Some(DEFAULT_HIDDEN_AUTO_ARCHIVE_DAYS),
            ),
            sidebar_auto_settle_on_merge: bool_or("sidebarAutoSettleOnMerge", true),
            sidebar_auto_settle_after_days: opt_days(
                "sidebarAutoSettleAfterDays",
                Some(DEFAULT_AUTO_SETTLE_DAYS),
            ),
            sidebar_auto_settle_keep_pull_requests: bool_or(
                "sidebarAutoSettleKeepPullRequests",
                false,
            ),
            response_streaming_mode: str_or("responseStreamingMode", "paragraph"),
            thread_title_instructions: str_or("threadTitleInstructions", ""),
        }
    }
}

pub fn parse_bounded_days(raw: &str, max: u64) -> Option<u64> {
    let val = raw.trim().parse::<u64>().ok()?;
    (1..=max).contains(&val).then_some(val)
}

impl P0App {
    pub(crate) fn render_threads_settings(
        &mut self,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let Some(settings) = self.bridge.server_settings() else {
            return div()
                .text_sm()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(
                    self.i18n.get(p0_i18n::Key::Loading).to_owned(),
                ));
        };
        let th = ThreadsServerSettings::from_json(&settings);
        let mut col = div().flex().flex_col().gap(px(12.0));

        // 1. New projects
        col = col.child(section_heading(self.i18n.tr("New projects"), palette));
        let base_dir_val = th.add_project_base_directory.clone();
        let base_dir_in = self
            .settings_ui
            .threads
            .base_dir_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder("~/");
                    st.set_value(base_dir_val, window, cx);
                    st
                })
            })
            .clone();
        let save_base_dir = base_dir_in.clone();
        col = col.child(setting_row(
            self.i18n.tr("Add project starts in"),
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().w(px(220.0)).child(Input::new(&base_dir_in)))
                .child(
                    Button::new("threads-basedir-save")
                        .label(self.i18n.tr("Save").to_owned())
                        .compact()
                        .primary()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let val = save_base_dir.read(cx).value().trim().to_owned();
                            this.bridge
                                .update_settings(json!({ "addProjectBaseDirectory": val }));
                            cx.notify();
                        })),
                ),
            palette,
        ));
        col = col.child(setting_row(
            self.i18n.tr("Clone into host folders"),
            Switch::new("threads-ghq")
                .checked(th.ghq_clone_layout)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "ghqCloneLayout": *val }));
                    cx.notify();
                })),
            palette,
        ));

        let mut env_modes = div().flex().flex_wrap().gap(px(6.0));
        for (mode, label) in [
            (None, "Automatic"),
            (Some("local"), "Local"),
            (Some("worktree"), "New worktree"),
        ] {
            let selected = th.default_thread_env_mode.as_deref() == mode;
            env_modes = env_modes.child(
                choice(
                    format!("threads-env-{}", mode.unwrap_or("auto")),
                    self.i18n.tr(label).to_owned(),
                    selected,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    let val = match mode {
                        Some(m) => json!(m),
                        None => Value::Null,
                    };
                    this.bridge
                        .update_settings(json!({ "defaultThreadEnvMode": val }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Default workspace"),
            env_modes,
            palette,
        ));

        // 2. Usage limits
        col = col.child(section_heading(self.i18n.tr("Usage limits"), palette));
        for (key, label, checked) in [
            (
                "autoResumeLimitedThreads",
                "Resume after usage limits",
                th.auto_resume_limited_threads,
            ),
            (
                "snoozeLimitedThreads",
                "Snooze until limits reset",
                th.snooze_limited_threads,
            ),
        ] {
            col = col.child(setting_row(
                self.i18n.tr(label),
                Switch::new(SharedString::from(format!("threads-{key}")))
                    .checked(checked)
                    .on_click(cx.listener(move |this, val: &bool, _, cx| {
                        this.bridge.update_settings(json!({ key: *val }));
                        cx.notify();
                    })),
                palette,
            ));
        }

        let archive_days_str = th
            .hidden_auto_archive_after_days
            .unwrap_or(DEFAULT_HIDDEN_AUTO_ARCHIVE_DAYS)
            .to_string();
        let archive_in = self
            .settings_ui
            .threads
            .hidden_archive_days_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder("30");
                    st.set_value(archive_days_str, window, cx);
                    st
                })
            })
            .clone();
        col = col.child(self.render_optional_days_row(
            "hiddenAutoArchiveAfterDays",
            "Archive hidden threads",
            th.hidden_auto_archive_after_days,
            DEFAULT_HIDDEN_AUTO_ARCHIVE_DAYS,
            MAX_HIDDEN_AUTO_ARCHIVE_DAYS,
            archive_in,
            palette,
            cx,
        ));

        // 3. Auto-settle
        col = col.child(section_heading(self.i18n.tr("Auto-settle"), palette));
        col = col.child(setting_row(
            self.i18n.tr("Auto-settle merged threads"),
            Switch::new("threads-autosettle-merge")
                .checked(th.sidebar_auto_settle_on_merge)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "sidebarAutoSettleOnMerge": *val }));
                    cx.notify();
                })),
            palette,
        ));

        let settle_days_str = th
            .sidebar_auto_settle_after_days
            .unwrap_or(DEFAULT_AUTO_SETTLE_DAYS)
            .to_string();
        let settle_in = self
            .settings_ui
            .threads
            .auto_settle_days_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder("7");
                    st.set_value(settle_days_str, window, cx);
                    st
                })
            })
            .clone();
        col = col.child(self.render_optional_days_row(
            "sidebarAutoSettleAfterDays",
            "Auto-settle inactive threads",
            th.sidebar_auto_settle_after_days,
            DEFAULT_AUTO_SETTLE_DAYS,
            MAX_AUTO_SETTLE_DAYS,
            settle_in,
            palette,
            cx,
        ));
        if th.sidebar_auto_settle_after_days.is_some() {
            col = col.child(setting_row(
                self.i18n.tr("Keep threads with a PR"),
                Switch::new("threads-autosettle-keep-pr")
                    .checked(th.sidebar_auto_settle_keep_pull_requests)
                    .on_click(cx.listener(|this, val: &bool, _, cx| {
                        this.bridge
                            .update_settings(json!({ "sidebarAutoSettleKeepPullRequests": *val }));
                        cx.notify();
                    })),
                palette,
            ));
        }

        // 4. Text generation & streaming
        col = col.child(section_heading(self.i18n.tr("Text generation"), palette));
        let mut streaming = div().flex().gap(px(6.0));
        for (mode, label) in [("paragraph", "Paragraph"), ("turn", "Turn")] {
            streaming = streaming.child(
                choice(
                    format!("threads-stream-{mode}"),
                    self.i18n.tr(label).to_owned(),
                    th.response_streaming_mode == mode,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bridge
                        .update_settings(json!({ "responseStreamingMode": mode }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Response streaming"),
            streaming,
            palette,
        ));

        let title_instr_val = th.thread_title_instructions.clone();
        let title_placeholder = self
            .i18n
            .tr("Optional instructions for generated thread titles")
            .to_owned();
        let title_in = self
            .settings_ui
            .threads
            .title_instructions_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder(title_placeholder);
                    st.set_value(title_instr_val, window, cx);
                    st
                })
            })
            .clone();
        let save_title_in = title_in.clone();
        col = col.child(setting_row(
            self.i18n.tr("Thread title instructions"),
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().w(px(260.0)).child(Input::new(&title_in)))
                .child(
                    Button::new("threads-title-instr-save")
                        .label(self.i18n.tr("Save").to_owned())
                        .compact()
                        .primary()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let val = save_title_in.read(cx).value().trim().to_owned();
                            this.bridge
                                .update_settings(json!({ "threadTitleInstructions": val }));
                            cx.notify();
                        })),
                ),
            palette,
        ));

        col
    }

    #[allow(clippy::too_many_arguments)]
    fn render_optional_days_row(
        &self,
        key: &'static str,
        label: &'static str,
        value: Option<u64>,
        default_days: u64,
        max_days: u64,
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
                .child(div().w(px(68.0)).child(Input::new(&input)))
                .child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(self.i18n.tr("days").to_owned())),
                )
                .child(
                    Button::new(SharedString::from(format!("threads-save-{key}")))
                        .label(self.i18n.tr("Save").to_owned())
                        .compact()
                        .primary()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let raw = save_in.read(cx).value().to_string();
                            if let Some(days) = parse_bounded_days(&raw, max_days) {
                                this.bridge.update_settings(json!({ key: days }));
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
            Switch::new(SharedString::from(format!("threads-toggle-{key}")))
                .checked(enabled)
                .on_click(cx.listener(move |this, on: &bool, _, cx| {
                    let next = if *on {
                        let raw = toggle_in.read(cx).value().to_string();
                        json!(parse_bounded_days(&raw, max_days).unwrap_or(default_days))
                    } else {
                        Value::Null
                    };
                    this.bridge.update_settings(json!({ key: next }));
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
    fn parses_threads_settings_and_day_bounds() {
        let defaults = ThreadsServerSettings::from_json(&json!({}));
        assert_eq!(defaults.default_thread_env_mode, None);
        assert_eq!(defaults.hidden_auto_archive_after_days, Some(30));
        assert!(defaults.sidebar_auto_settle_on_merge);
        assert_eq!(defaults.sidebar_auto_settle_after_days, Some(7));
        assert!(!defaults.auto_resume_limited_threads);

        let custom = ThreadsServerSettings::from_json(&json!({
            "addProjectBaseDirectory": "~/code",
            "ghqCloneLayout": true,
            "defaultThreadEnvMode": "worktree",
            "autoResumeLimitedThreads": true,
            "snoozeLimitedThreads": true,
            "hiddenAutoArchiveAfterDays": null,
            "sidebarAutoSettleAfterDays": 14,
            "sidebarAutoSettleKeepPullRequests": true,
            "responseStreamingMode": "turn",
            "threadTitleInstructions": "Keep titles under 6 words"
        }));
        assert_eq!(custom.add_project_base_directory, "~/code");
        assert!(custom.ghq_clone_layout);
        assert_eq!(custom.default_thread_env_mode.as_deref(), Some("worktree"));
        assert!(custom.auto_resume_limited_threads);
        assert!(custom.snooze_limited_threads);
        assert_eq!(custom.hidden_auto_archive_after_days, None);
        assert_eq!(custom.sidebar_auto_settle_after_days, Some(14));
        assert!(custom.sidebar_auto_settle_keep_pull_requests);
        assert_eq!(custom.response_streaming_mode, "turn");
        assert_eq!(
            custom.thread_title_instructions,
            "Keep titles under 6 words"
        );

        assert_eq!(parse_bounded_days("0", 90), None);
        assert_eq!(parse_bounded_days("1", 90), Some(1));
        assert_eq!(parse_bounded_days("90", 90), Some(90));
        assert_eq!(parse_bounded_days("91", 90), None);
    }
}
