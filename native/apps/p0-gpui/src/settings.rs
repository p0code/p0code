//! Settings: the section list mirrors `apps/web/src/components/settings/settingsSearch.ts`
//! (same order, groups and English labels, so the web translations apply). General, Appearance
//! and Providers are native; every other section links to the web app.

use std::path::PathBuf;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::switch::Switch;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use p0_i18n::SUPPORTED_LOCALES;
use p0_protocol::{RuntimeMode, ServerProviderState};
use serde::{Deserialize, Serialize};

use crate::theme::{AppPalette, ThemePreference};

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

/// Preferences the web app keeps per client (its `ClientSettings`); the native client keeps them
/// in a file of its own.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LocalPrefs {
    pub theme: ThemePreference,
    /// A supported locale code; `None` follows the system.
    pub language: Option<String>,
    pub sidebar_hidden: bool,
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
            "/settings/providers" => self.render_providers(palette, cx).into_any_element(),
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
        let _ = window;
        div().size_full().flex().flex_row().child(nav).child(
            div()
                .id("settings-body")
                .flex_1()
                .min_w_0()
                .h_full()
                .overflow_y_scroll()
                .child(
                    div()
                        .max_w(px(720.0))
                        .px(px(32.0))
                        .py(px(28.0))
                        .flex()
                        .flex_col()
                        .gap(px(20.0))
                        .child(
                            div()
                                .text_xl()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(t(section.label)),
                        )
                        .child(body),
                ),
        )
    }

    fn render_general(&mut self, palette: &AppPalette, cx: &mut Context<Self>) -> impl IntoElement {
        let mut col = div().flex().flex_col().gap(px(4.0));
        let current = self.prefs.language.clone();
        let mut languages = div().flex().flex_wrap().gap(px(6.0));
        let follow = Button::new("lang-system")
            .label(self.i18n.tr("Follow system").to_owned())
            .compact()
            .toggled(current.is_none())
            .on_click(cx.listener(|this, _, window, cx| {
                let mut prefs = this.prefs.clone();
                prefs.language = None;
                this.set_prefs(prefs, window, cx);
            }));
        languages = languages.child(follow);
        for (code, name) in SUPPORTED_LOCALES {
            languages = languages.child(
                Button::new(SharedString::from(format!("lang-{code}")))
                    .label(*name)
                    .compact()
                    .toggled(current.as_deref() == Some(*code))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let mut prefs = this.prefs.clone();
                        prefs.language = Some((*code).to_owned());
                        this.set_prefs(prefs, window, cx);
                    })),
            );
        }
        col = col.child(setting_row(self.i18n.tr("Language"), languages, palette));

        let Some(settings) = self.bridge.server_settings() else {
            return col.child(div().text_sm().text_color(palette.muted_foreground).child(
                SharedString::from(self.i18n.get(p0_i18n::Key::Loading).to_owned()),
            ));
        };
        let server = GeneralServerSettings::from_json(&settings);
        let mut modes = div().flex().flex_wrap().gap(px(6.0));
        for mode in [
            RuntimeMode::ApprovalRequired,
            RuntimeMode::AutoAcceptEdits,
            RuntimeMode::Auto,
            RuntimeMode::FullAccess,
        ] {
            modes = modes.child(
                Button::new(SharedString::from(format!("mode-{}", mode.as_wire_str())))
                    .label(crate::composer::runtime_mode_label(mode, &self.i18n))
                    .compact()
                    .toggled(server.default_runtime_mode == mode)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.bridge.update_settings(
                            serde_json::json!({ "defaultRuntimeMode": mode.as_wire_str() }),
                        );
                        cx.notify();
                    })),
            );
        }
        col = col.child(setting_row(self.i18n.tr("Permissions"), modes, palette));
        for (key, label) in BOOL_SETTINGS {
            col = col.child(setting_row(
                self.i18n.tr(label),
                Switch::new(SharedString::from(format!("setting-{key}")))
                    .checked(server.flag(key))
                    .on_click(cx.listener(move |this, checked: &bool, _, cx| {
                        this.bridge
                            .update_settings(serde_json::json!({ key: *checked }));
                        cx.notify();
                    })),
                palette,
            ));
        }
        col
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
                Button::new(SharedString::from(format!("theme-{label}")))
                    .label(self.i18n.tr(label).to_owned())
                    .compact()
                    .toggled(self.prefs.theme == pref)
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

    fn render_providers(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut col = div().flex().flex_col().gap(px(10.0)).child(
            div().child(
                Button::new("providers-refresh")
                    .label(self.i18n.tr("Refresh").to_owned())
                    .compact()
                    .outline()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.bridge.refresh_providers();
                        cx.notify();
                    })),
            ),
        );
        let Some(config) = self.bridge.server_config() else {
            return col;
        };
        for provider in &config.providers {
            let (dot, status) = match provider.status {
                ServerProviderState::Ready => (palette.success, self.i18n.tr("Ready")),
                ServerProviderState::Warning => (palette.warning, self.i18n.tr("Warning")),
                ServerProviderState::Error => (palette.error, self.i18n.get(p0_i18n::Key::Error)),
                ServerProviderState::Disabled => {
                    (palette.muted_foreground, self.i18n.tr("Disabled"))
                }
                ServerProviderState::Unknown => (palette.muted_foreground, ""),
            };
            let mut c = crate::feed::card(palette).child(
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
                            .child(div().w(px(8.0)).h(px(8.0)).rounded_full().bg(dot))
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(SharedString::from(provider.label().to_owned())),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(palette.muted_foreground)
                                    .child(SharedString::from(provider.driver.clone())),
                            ),
                    )
                    .child(
                        div().text_xs().text_color(palette.muted_foreground).child(
                            SharedString::from(
                                [Some(status.to_owned()), provider.version.clone()]
                                    .into_iter()
                                    .flatten()
                                    .filter(|s| !s.is_empty())
                                    .collect::<Vec<_>>()
                                    .join(" · "),
                            ),
                        ),
                    ),
            );
            if let Some(message) = provider.message.as_deref().filter(|m| !m.is_empty()) {
                c = c.child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(message.to_owned())),
                );
            }
            let models = provider
                .models
                .iter()
                .map(|m| m.short_name.clone().unwrap_or_else(|| m.name.clone()))
                .collect::<Vec<_>>()
                .join(", ");
            if !models.is_empty() {
                c = c.child(div().text_xs().child(SharedString::from(models)));
            }
            col = col.child(c);
        }
        col
    }
}

fn setting_row(label: &str, control: impl IntoElement, palette: &AppPalette) -> impl IntoElement {
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
        let web = include_str!("../../../../apps/web/src/components/settings/settingsSearch.ts");
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
        };
        let raw = serde_json::to_string(&prefs).unwrap();
        assert_eq!(serde_json::from_str::<LocalPrefs>(&raw).unwrap(), prefs);
        let partial: LocalPrefs = serde_json::from_str(r#"{"theme":"light","future":1}"#).unwrap();
        assert_eq!(partial.theme, ThemePreference::Light);
        assert_eq!(partial.language, None);
    }

    #[test]
    fn web_url_joins_without_double_slash() {
        assert_eq!(
            web_url("http://127.0.0.1:3773/", "/settings/labs"),
            "http://127.0.0.1:3773/settings/labs"
        );
    }
}
