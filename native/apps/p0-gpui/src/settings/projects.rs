//! Projects settings (`/settings/projects`): lists registered projects from the shell snapshot,
//! toggles global `defaultAutoPull` and per-project `projectAutoPullOverrides` via
//! `server.updateSettings`, and links to the web app for scripts, icons, and checkouts.

use std::collections::HashMap;

use gpui_kit::component::button::Button;
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    Context, FontWeight, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use serde_json::{Value, json};

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::general::section_heading;
use crate::settings::{setting_row, web_url};
use crate::theme::AppPalette;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectsServerSettings {
    pub default_auto_pull: bool,
    pub auto_pull_overrides: HashMap<String, bool>,
}

impl ProjectsServerSettings {
    pub fn from_json(settings: &Value) -> Self {
        let default_auto_pull = settings
            .get("defaultAutoPull")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut auto_pull_overrides = HashMap::new();
        if let Some(obj) = settings
            .get("projectAutoPullOverrides")
            .and_then(Value::as_object)
        {
            for (k, v) in obj {
                if let Some(b) = v.as_bool() {
                    auto_pull_overrides.insert(k.clone(), b);
                }
            }
        }
        Self {
            default_auto_pull,
            auto_pull_overrides,
        }
    }
}

impl P0App {
    pub(crate) fn render_projects_settings(
        &mut self,
        palette: &AppPalette,
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
        let ps = ProjectsServerSettings::from_json(&settings);
        let shell = self.bridge.shell_state();
        let web_projects_url = web_url(self.bridge.base_url(), "/settings/projects");

        let mut thread_counts: HashMap<&str, usize> = HashMap::new();
        for t in &shell.threads {
            *thread_counts.entry(t.project_id.as_str()).or_default() += 1;
        }

        let mut col = div().flex().flex_col().gap(px(12.0));

        // 1. Defaults
        col = col.child(section_heading(self.i18n.tr("Defaults"), palette));
        col = col.child(setting_row(
            self.i18n.tr("Auto-pull before starting threads"),
            Switch::new("proj-default-autopull")
                .checked(ps.default_auto_pull)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "defaultAutoPull": *val }));
                    cx.notify();
                })),
            palette,
        ));

        // 2. Registered projects
        col = col.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(section_heading(self.i18n.tr("Projects"), palette))
                .child(
                    Button::new("proj-open-web")
                        .label("Edit scripts & icons in browser".to_owned())
                        .compact()
                        .outline()
                        .on_click(move |_, _, cx| cx.open_url(&web_projects_url)),
                ),
        );

        if shell.projects.is_empty() {
            return col.child(
                crate::feed::card(palette).child(
                    div()
                        .text_sm()
                        .text_color(palette.muted_foreground)
                        .child("No projects registered on this environment."),
                ),
            );
        }

        for proj in &shell.projects {
            let count = thread_counts.get(proj.id.as_str()).copied().unwrap_or(0);
            let current_override = ps.auto_pull_overrides.get(&proj.id).copied();
            let mut auto_pull_choices = div().flex().items_center().gap(px(4.0));
            for (opt, label) in [(None, "Inherit"), (Some(true), "On"), (Some(false), "Off")] {
                let pid = proj.id.clone();
                auto_pull_choices = auto_pull_choices.child(
                    choice(
                        format!(
                            "proj-ap-{}-{}",
                            proj.id,
                            opt.map(|b| b.to_string())
                                .unwrap_or_else(|| "inherit".to_owned())
                        ),
                        self.i18n.tr(label).to_owned(),
                        current_override == opt,
                        palette,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let val = match opt {
                            Some(b) => json!(b),
                            None => Value::Null,
                        };
                        this.bridge.update_settings(json!({
                            "projectAutoPullOverrides": { pid.clone(): val }
                        }));
                        cx.notify();
                    })),
                );
            }

            col = col.child(
                crate::feed::card(palette)
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
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(SharedString::from(proj.title.clone())),
                                    )
                                    .child(
                                        div().text_xs().text_color(palette.muted_foreground).child(
                                            SharedString::from(format!("{count} thread(s)")),
                                        ),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(palette.muted_foreground)
                                            .child("Auto-pull:"),
                                    )
                                    .child(auto_pull_choices),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .font_family("monospace")
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(proj.workspace_root.clone())),
                    ),
            );
        }

        col
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_project_auto_pull_settings() {
        let ps = ProjectsServerSettings::from_json(&json!({
            "defaultAutoPull": true,
            "projectAutoPullOverrides": {
                "proj-1": false,
                "proj-2": null
            }
        }));
        assert!(ps.default_auto_pull);
        assert_eq!(ps.auto_pull_overrides.get("proj-1"), Some(&false));
        assert_eq!(ps.auto_pull_overrides.get("proj-2"), None);
    }
}
