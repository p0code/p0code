//! Settings: the section list mirrors `apps/web/src/components/settings/settingsSearch.ts`
//! (same order, groups and English labels, so the web translations apply). Each native section
//! lives in its own module under `settings/`; sections still `todo` link to the web app.

pub mod about;
pub mod access;
pub mod archived;
pub mod chat;
pub mod connections;
pub mod diagnostics;
pub mod diffs;
pub mod general;
pub mod keybindings;
pub mod labs;
pub mod maintenance;
pub mod plugins;
pub mod projects;
pub mod providers;
pub mod scheduled_tasks;
pub mod source_control;
pub mod threads;
pub mod worktrees;

use std::path::PathBuf;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use p0_protocol::RuntimeMode;
use serde::{Deserialize, Serialize};

use crate::feed::choice;
use crate::theme::{AppPalette, ThemePreference};

#[derive(Default)]
pub struct SettingsUiState {
    pub archived: archived::ArchivedUiState,
    pub connections: connections::ConnectionsUiState,
    pub diagnostics: diagnostics::DiagnosticsUiState,
    pub keybindings: keybindings::KeybindingsUiState,
    pub labs: labs::LabsUiState,
    pub maintenance: maintenance::MaintenanceUiState,
    pub providers: providers::ProvidersUiState,
    pub scheduled_tasks: scheduled_tasks::ScheduledTasksUiState,
    pub source_control: source_control::SourceControlUiState,
    pub threads: threads::ThreadsUiState,
    pub worktrees: worktrees::WorktreesUiState,
}

pub struct Section {
    pub path: &'static str,
    pub label: &'static str,
    /// Heading shown above the section's group; `None` when the web app hides it.
    pub group: Option<&'static str>,
}

const fn section(path: &'static str, label: &'static str, group: Option<&'static str>) -> Section {
    Section { path, label, group }
}

pub const SECTIONS: [Section; 25] = [
    section("/settings/general", "General", None),
    section("/settings/appearance", "Appearance", None),
    section("/settings/chat", "Chat", None),
    section("/settings/diffs", "Diffs & pull requests", None),
    section("/settings/keybindings", "Keybindings", None),
    section("/settings/voice", "Voice", None),
    section("/settings/snap-shot", "SnapShots", None),
    section("/settings/providers", "Providers", Some("Agents")),
    section("/settings/threads", "Threads", Some("Agents")),
    section("/settings/browser", "Browser", Some("Agents")),
    section("/settings/devices", "Devices", Some("Agents")),
    section(
        "/settings/scheduled-tasks",
        "Scheduled tasks",
        Some("Agents"),
    ),
    section("/settings/projects", "Projects", Some("Code")),
    section(
        "/settings/source-control",
        "Source control & issues",
        Some("Code"),
    ),
    section("/settings/worktrees", "Worktrees", Some("Code")),
    section("/settings/deploy", "Deploy", Some("Code")),
    section("/settings/connections", "Environments", Some("Connections")),
    section("/settings/access", "Sharing & access", Some("Connections")),
    section("/settings/secrets", "Secrets", Some("Connections")),
    section("/settings/plugins", "Plugins", Some("Connections")),
    section("/settings/maintenance", "Maintenance", None),
    section("/settings/labs", "Labs", None),
    section("/settings/about", "About", None),
    section("/settings/archived", "Archive", None),
    section("/settings/diagnostics", "Diagnostics", None),
];

pub fn find_section(path: &str) -> Option<&'static Section> {
    SECTIONS.iter().find(|s| s.path == path)
}

/// The web app's page for a section, served by the same `p0d`.
pub fn web_url(base_url: &str, path: &str) -> String {
    format!("{}{path}", base_url.trim_end_matches('/'))
}

fn default_true() -> bool {
    true
}
fn default_off() -> String {
    "off".to_owned()
}
fn default_locale() -> String {
    "locale".to_owned()
}
fn default_left() -> String {
    "left".to_owned()
}
fn default_enter() -> String {
    "enter".to_owned()
}
fn default_steer() -> String {
    "steer".to_owned()
}
fn default_show_all() -> String {
    "showAll".to_owned()
}
fn default_stacked() -> String {
    "stacked".to_owned()
}
fn default_red_green() -> String {
    "red-green".to_owned()
}

/// Preferences the web app keeps per client (its `ClientSettings`); the native client keeps them
/// in a file of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LocalPrefs {
    pub theme: ThemePreference,
    /// A supported locale code; `None` follows the system.
    pub language: Option<String>,
    pub sidebar_hidden: bool,
    #[serde(default = "default_off")]
    pub notification_mode: String,
    pub in_app_notifications_enabled: bool,
    #[serde(default = "default_locale")]
    pub timestamp_format: String,
    #[serde(default = "default_left")]
    pub usage_display_mode: String,
    pub confirm_thread_unpin: bool,
    pub confirm_thread_archive: bool,
    #[serde(default = "default_true")]
    pub confirm_thread_delete: bool,
    #[serde(default = "default_true")]
    pub confirm_terminal_close: bool,
    #[serde(default = "default_enter")]
    pub send_shortcut: String,
    #[serde(default = "default_steer")]
    pub follow_up_behavior: String,
    #[serde(default = "default_show_all")]
    pub tool_call_visibility: String,
    #[serde(default = "default_true")]
    pub show_skills_in_slash_menu: bool,
    #[serde(default = "default_stacked")]
    pub diff_layout: String,
    pub diff_ignore_whitespace: bool,
    pub diff_files_collapsed: bool,
    #[serde(default = "default_red_green")]
    pub diff_color_scheme: String,
    #[serde(default = "default_true")]
    pub proactive_panels_enabled: bool,
    #[serde(default = "default_true")]
    pub pull_request_links_open_in_app: bool,
}

impl Default for LocalPrefs {
    fn default() -> Self {
        Self {
            theme: ThemePreference::default(),
            language: None,
            sidebar_hidden: false,
            notification_mode: default_off(),
            in_app_notifications_enabled: false,
            timestamp_format: default_locale(),
            usage_display_mode: default_left(),
            confirm_thread_unpin: false,
            confirm_thread_archive: false,
            confirm_thread_delete: true,
            confirm_terminal_close: true,
            send_shortcut: default_enter(),
            follow_up_behavior: default_steer(),
            tool_call_visibility: default_show_all(),
            show_skills_in_slash_menu: true,
            diff_layout: default_stacked(),
            diff_ignore_whitespace: false,
            diff_files_collapsed: false,
            diff_color_scheme: default_red_green(),
            proactive_panels_enabled: true,
            pull_request_links_open_in_app: true,
        }
    }
}

impl LocalPrefs {
    pub fn path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("p0code").join("native-client.json"))
    }

    pub fn load() -> Self {
        Self::path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let Some(path) = Self::path() else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(raw) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, raw);
        }
    }
}

/// Server settings General edits (`server.updateSettings`), read from `server.getSettings`.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneralServerSettings {
    pub default_runtime_mode: RuntimeMode,
    pub keep_awake_while_agents_work: bool,
    pub enable_provider_update_checks: bool,
    pub continue_threads_after_server_update: bool,
}

pub const BOOL_SETTINGS: [(&str, &str); 3] = [
    ("keepAwakeWhileAgentsWork", "Keep awake while agents work"),
    ("enableProviderUpdateChecks", "Provider update checks"),
    (
        "continueThreadsAfterServerUpdate",
        "Continue threads after restarts",
    ),
];

impl GeneralServerSettings {
    pub fn from_json(settings: &serde_json::Value) -> Self {
        let flag = |key: &str, default: bool| {
            settings
                .get(key)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(default)
        };
        Self {
            default_runtime_mode: settings
                .get("defaultRuntimeMode")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or(RuntimeMode::FullAccess),
            keep_awake_while_agents_work: flag("keepAwakeWhileAgentsWork", true),
            enable_provider_update_checks: flag("enableProviderUpdateChecks", true),
            continue_threads_after_server_update: flag("continueThreadsAfterServerUpdate", true),
        }
    }

    pub fn flag(&self, key: &str) -> bool {
        match key {
            "keepAwakeWhileAgentsWork" => self.keep_awake_while_agents_work,
            "enableProviderUpdateChecks" => self.enable_provider_update_checks,
            "continueThreadsAfterServerUpdate" => self.continue_threads_after_server_update,
            _ => false,
        }
    }
}

impl crate::app::P0App {
    pub(crate) fn render_settings(
        &mut self,
        path: &'static str,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let i18n = self.i18n.clone();
        let t = |s: &'static str| SharedString::from(i18n.tr(s).to_owned());
        let mut nav = div()
            .id("settings-nav")
            .w(px(232.0))
            .flex_none()
            .h_full()
            .overflow_y_scroll()
            .bg(palette.sidebar)
            .border_r_1()
            .border_color(palette.border)
            .p(px(8.0))
            .flex()
            .flex_col()
            .gap(px(1.0))
            .child(
                div()
                    .id("settings-back")
                    .px(px(10.0))
                    .py(px(6.0))
                    .mb(px(6.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_sm()
                    .text_color(palette.muted_foreground)
                    .hover(|s| s.bg(palette.row_hover).text_color(palette.foreground))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.view = crate::app::View::Chat;
                        cx.notify();
                    }))
                    .child(SharedString::from(format!("← {}", self.i18n.tr("Back")))),
            );
        let mut last_group: Option<&str> = None;
        for section in &SECTIONS {
            if section.group != last_group {
                if let Some(group) = section.group {
                    nav = nav.child(
                        div()
                            .px(px(10.0))
                            .pt(px(12.0))
                            .pb(px(4.0))
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(palette.muted_foreground)
                            .child(t(group)),
                    );
                } else {
                    nav = nav.child(div().h(px(10.0)));
                }
                last_group = section.group;
            }
            let selected = section.path == path;
            let target = section.path;
            nav = nav.child(
                div()
                    .id(SharedString::from(format!("settings-nav-{}", section.path)))
                    .px(px(10.0))
                    .py(px(5.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_sm()
                    .text_color(if selected {
                        palette.foreground
                    } else {
                        palette.muted_foreground
                    })
                    .when(selected, |d| d.bg(palette.row_selected))
                    .hover(|s| s.bg(palette.row_hover))
                    .on_click(cx.listener(move |this, _, _, cx| this.open_settings(target, cx)))
                    .child(t(section.label)),
            );
        }

        let section = find_section(path).unwrap_or(&SECTIONS[0]);
        let body = match section.path {
            "/settings/general" => self.render_general(palette, cx).into_any_element(),
            "/settings/appearance" => self.render_appearance(palette, cx).into_any_element(),
            "/settings/chat" => self.render_chat_settings(palette, cx).into_any_element(),
            "/settings/diffs" => self.render_diffs_settings(palette, cx).into_any_element(),
            "/settings/keybindings" => self
                .render_keybindings(palette, window, cx)
                .into_any_element(),
            "/settings/providers" => self
                .render_providers(palette, window, cx)
                .into_any_element(),
            "/settings/threads" => self
                .render_threads_settings(palette, window, cx)
                .into_any_element(),
            "/settings/scheduled-tasks" => {
                self.render_scheduled_tasks(palette, cx).into_any_element()
            }
            "/settings/projects" => self
                .render_projects_settings(palette, cx)
                .into_any_element(),
            "/settings/source-control" => self
                .render_source_control_settings(palette, window, cx)
                .into_any_element(),
            "/settings/worktrees" => self
                .render_worktrees_settings(palette, window, cx)
                .into_any_element(),
            "/settings/connections" => self.render_connections(palette, cx).into_any_element(),
            "/settings/access" => self.render_access_settings(palette, cx).into_any_element(),
            "/settings/plugins" => self.render_plugins(palette, cx).into_any_element(),
            "/settings/maintenance" => self
                .render_maintenance(palette, window, cx)
                .into_any_element(),
            "/settings/labs" => self.render_labs(palette, window, cx).into_any_element(),
            "/settings/about" => self.render_about(palette, cx).into_any_element(),
            "/settings/archived" => self.render_archived(palette, cx).into_any_element(),
            "/settings/diagnostics" => self.render_diagnostics(palette, cx).into_any_element(),
            _ => {
                let url = web_url(self.bridge.base_url(), section.path);
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(12.0))
                    .child(
                        div()
                            .text_sm()
                            .text_color(palette.muted_foreground)
                            .child("Not in the native client yet."),
                    )
                    .child(
                        Button::new("settings-open-web")
                            .label(self.i18n.tr("Open in browser").to_owned())
                            .primary()
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    )
                    .into_any_element()
            }
        };
        let mut content = div()
            .max_w(px(720.0))
            .px(px(32.0))
            .py(px(28.0))
            .flex()
            .flex_col()
            .gap(px(20.0));
        if let Some(notice) = self.bridge.notice() {
            let bridge = self.bridge.clone();
            content = content.child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(6.0))
                    .bg(palette.error_surface)
                    .border_1()
                    .border_color(palette.error)
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .text_xs()
                    .text_color(palette.error)
                    .child(div().min_w_0().child(SharedString::from(notice)))
                    .child(
                        div()
                            .id("settings-dismiss-notice")
                            .flex_none()
                            .cursor_pointer()
                            .on_click(cx.listener(move |_, _, _, _| bridge.clear_notice()))
                            .child("✕"),
                    ),
            );
        }
        content = content
            .child(
                div()
                    .text_xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(t(section.label)),
            )
            .child(body);
        div().size_full().flex().flex_row().child(nav).child(
            div()
                .id("settings-body")
                .flex_1()
                .min_w_0()
                .h_full()
                .overflow_y_scroll()
                .child(content),
        )
    }

    fn render_appearance(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut schemes = div().flex().gap(px(6.0));
        for (pref, label) in [
            (ThemePreference::System, "System"),
            (ThemePreference::Light, "Light"),
            (ThemePreference::Dark, "Dark"),
        ] {
            schemes = schemes.child(
                choice(
                    format!("theme-{label}"),
                    self.i18n.tr(label).to_owned(),
                    self.prefs.theme == pref,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.theme = pref;
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        div()
            .flex()
            .flex_col()
            .child(setting_row(self.i18n.tr("Color scheme"), schemes, palette))
    }
}

pub(crate) fn setting_row(
    label: &str,
    control: impl IntoElement,
    palette: &AppPalette,
) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.0))
        .py(px(12.0))
        .border_b_1()
        .border_color(palette.border)
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .child(SharedString::from(label.to_owned())),
        )
        .child(control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_match_the_web_settings_paths() {
        let web = include_str!("../../../../../apps/web/src/components/settings/settingsSearch.ts");
        let union = &web[web.find("export type SettingsPath =").unwrap()..];
        let union = &union[..union.find(';').unwrap()];
        let mut web_paths: Vec<&str> = union
            .split('"')
            .filter(|s| s.starts_with("/settings/"))
            .collect();
        let mut ours: Vec<&str> = SECTIONS.iter().map(|s| s.path).collect();
        web_paths.sort_unstable();
        ours.sort_unstable();
        assert_eq!(ours, web_paths);
        for s in &SECTIONS {
            assert!(
                web.contains(&format!("\"{}\": msg(\"{}\")", s.path, s.label)),
                "label of {} differs from the web app",
                s.path
            );
        }
    }

    #[test]
    fn reads_general_settings_with_web_defaults() {
        let parsed = GeneralServerSettings::from_json(&serde_json::json!({
            "defaultRuntimeMode": "approval-required",
            "keepAwakeWhileAgentsWork": false
        }));
        assert_eq!(parsed.default_runtime_mode, RuntimeMode::ApprovalRequired);
        assert!(!parsed.flag("keepAwakeWhileAgentsWork"));
        assert!(parsed.flag("enableProviderUpdateChecks"));
    }

    #[test]
    fn prefs_round_trip_and_tolerate_unknown_fields() {
        let prefs = LocalPrefs {
            theme: ThemePreference::Dark,
            language: Some("zh-TW".to_owned()),
            sidebar_hidden: true,
            notification_mode: "notifications-and-sound".to_owned(),
            in_app_notifications_enabled: true,
            ..LocalPrefs::default()
        };
        let raw = serde_json::to_string(&prefs).unwrap();
        assert_eq!(serde_json::from_str::<LocalPrefs>(&raw).unwrap(), prefs);
        let partial: LocalPrefs = serde_json::from_str(r#"{"theme":"light","future":1}"#).unwrap();
        assert_eq!(partial.theme, ThemePreference::Light);
        assert_eq!(partial.language, None);
        assert_eq!(partial.notification_mode, "off");
        assert!(partial.confirm_thread_delete);
    }

    #[test]
    fn web_url_joins_without_double_slash() {
        assert_eq!(
            web_url("http://127.0.0.1:3773/", "/settings/labs"),
            "http://127.0.0.1:3773/settings/labs"
        );
    }
}
