//! Source control & issues settings (`/settings/source-control`): commit/PR writing style,
//! PR merge method, agent credits removal, and review guides via `server.updateSettings`.

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
use crate::settings::{setting_row, web_url};
use crate::theme::AppPalette;

#[derive(Default)]
pub struct SourceControlUiState {
    writing_instructions_input: Option<Entity<InputState>>,
    review_guide_instructions_input: Option<Entity<InputState>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceControlServerSettings {
    pub writing_mode: String,
    pub writing_custom_instructions: String,
    pub follow_change_request_templates: bool,
    pub pull_request_merge_method: Option<String>,
    pub remove_agent_credits_on_merge: bool,
    pub review_guides_enabled: bool,
    pub review_guide_instructions: String,
}

impl SourceControlServerSettings {
    pub fn from_json(settings: &Value) -> Self {
        let style = settings.get("sourceControlWritingStyle");
        let writing_mode = style
            .and_then(|v| v.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("repo_conventions")
            .to_owned();
        let writing_custom_instructions = style
            .and_then(|v| v.get("customInstructions"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let follow_change_request_templates = style
            .and_then(|v| v.get("followChangeRequestTemplates"))
            .and_then(Value::as_bool)
            .unwrap_or(true);

        Self {
            writing_mode,
            writing_custom_instructions,
            follow_change_request_templates,
            pull_request_merge_method: settings
                .get("pullRequestMergeMethod")
                .and_then(Value::as_str)
                .map(str::to_owned),
            remove_agent_credits_on_merge: settings
                .get("removeAgentCreditsOnMerge")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            review_guides_enabled: settings
                .get("reviewGuidesEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            review_guide_instructions: settings
                .get("reviewGuideInstructions")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        }
    }
}

impl P0App {
    pub(crate) fn render_source_control_settings(
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
        let sc = SourceControlServerSettings::from_json(&settings);
        let web_sc_url = web_url(self.bridge.base_url(), "/settings/source-control");
        let mut col = div().flex().flex_col().gap(px(12.0));

        // 1. Writing style
        col = col.child(section_heading(self.i18n.tr("Writing & commits"), palette));
        let mut modes = div().flex().flex_wrap().gap(px(6.0));
        for (mode, label) in [
            ("repo_conventions", "Repository conventions"),
            ("conventional_commits", "Conventional Commits"),
            ("custom", "Custom instructions"),
        ] {
            modes = modes.child(
                choice(
                    format!("sc-mode-{mode}"),
                    self.i18n.tr(label).to_owned(),
                    sc.writing_mode == mode,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bridge.update_settings(json!({
                        "sourceControlWritingStyle": { "mode": mode }
                    }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Commit and pull request writing"),
            modes,
            palette,
        ));

        if sc.writing_mode == "custom" {
            let instr_val = sc.writing_custom_instructions.clone();
            let instr_placeholder = self
                .i18n
                .tr("Custom commit/PR writing instructions")
                .to_owned();
            let instr_in = self
                .settings_ui
                .source_control
                .writing_instructions_input
                .get_or_insert_with(|| {
                    cx.new(|cx| {
                        let mut st = InputState::new(window, cx).placeholder(instr_placeholder);
                        st.set_value(instr_val, window, cx);
                        st
                    })
                })
                .clone();
            let save_in = instr_in.clone();
            col = col.child(setting_row(
                self.i18n.tr("Writing instructions"),
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().w(px(260.0)).child(Input::new(&instr_in)))
                    .child(
                        Button::new("sc-writing-save")
                            .label(self.i18n.tr("Save").to_owned())
                            .compact()
                            .primary()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let val = save_in.read(cx).value().trim().to_owned();
                                this.bridge.update_settings(json!({
                                    "sourceControlWritingStyle": { "customInstructions": val }
                                }));
                                cx.notify();
                            })),
                    ),
                palette,
            ));
        }

        col = col.child(setting_row(
            self.i18n.tr("Follow pull request templates"),
            Switch::new("sc-pr-templates")
                .checked(sc.follow_change_request_templates)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge.update_settings(json!({
                        "sourceControlWritingStyle": { "followChangeRequestTemplates": *val }
                    }));
                    cx.notify();
                })),
            palette,
        ));

        // 2. Pull request defaults
        col = col.child(section_heading(self.i18n.tr("Pull requests"), palette));
        let mut merge_methods = div().flex().flex_wrap().gap(px(6.0));
        for (method, label) in [
            (None, "Default"),
            (Some("merge"), "Merge"),
            (Some("squash"), "Squash"),
            (Some("rebase"), "Rebase"),
            (Some("fast-forward"), "Fast-forward"),
        ] {
            let selected = sc.pull_request_merge_method.as_deref() == method;
            merge_methods = merge_methods.child(
                choice(
                    format!("sc-merge-{}", method.unwrap_or("default")),
                    self.i18n.tr(label).to_owned(),
                    selected,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    let val = match method {
                        Some(m) => json!(m),
                        None => Value::Null,
                    };
                    this.bridge
                        .update_settings(json!({ "pullRequestMergeMethod": val }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Default merge method"),
            merge_methods,
            palette,
        ));

        col = col.child(setting_row(
            self.i18n.tr("Remove agent credits when merging"),
            Switch::new("sc-remove-credits")
                .checked(sc.remove_agent_credits_on_merge)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "removeAgentCreditsOnMerge": *val }));
                    cx.notify();
                })),
            palette,
        ));

        // 3. Review guides
        col = col.child(section_heading(self.i18n.tr("Review guides"), palette));
        col = col.child(setting_row(
            self.i18n.tr("Enable PR review guides"),
            Switch::new("sc-review-guides")
                .checked(sc.review_guides_enabled)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "reviewGuidesEnabled": *val }));
                    cx.notify();
                })),
            palette,
        ));
        if sc.review_guides_enabled {
            let rg_val = sc.review_guide_instructions.clone();
            let rg_placeholder = self
                .i18n
                .tr("Optional instructions for PR review guides")
                .to_owned();
            let rg_in = self
                .settings_ui
                .source_control
                .review_guide_instructions_input
                .get_or_insert_with(|| {
                    cx.new(|cx| {
                        let mut st = InputState::new(window, cx).placeholder(rg_placeholder);
                        st.set_value(rg_val, window, cx);
                        st
                    })
                })
                .clone();
            let save_rg = rg_in.clone();
            col = col.child(setting_row(
                self.i18n.tr("Review guide instructions"),
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().w(px(260.0)).child(Input::new(&rg_in)))
                    .child(
                        Button::new("sc-rg-save")
                            .label(self.i18n.tr("Save").to_owned())
                            .compact()
                            .primary()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let val = save_rg.read(cx).value().trim().to_owned();
                                this.bridge
                                    .update_settings(json!({ "reviewGuideInstructions": val }));
                                cx.notify();
                            })),
                    ),
                palette,
            ));
        }

        // 4. Host accounts & issue trackers (OAuth/tokens stay in browser)
        col = col.child(section_heading(
            self.i18n.tr("Hosts & issue trackers"),
            palette,
        ));
        col = col.child(setting_row(
            self.i18n.tr("GitHub, GitLab & trackers"),
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
                                .tr("Manage host CLI discovery, OAuth sign-ins, and personal access tokens in the web app.")
                                .to_owned(),
                        )),
                )
                .child(
                    div().flex_none().child(
                        Button::new("sc-open-web")
                            .label(self.i18n.tr("Open in browser").to_owned())
                            .compact()
                            .outline()
                            .on_click(move |_, _, cx| cx.open_url(&web_sc_url)),
                    ),
                ),
            palette,
        ));

        col
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_source_control_settings() {
        let sc = SourceControlServerSettings::from_json(&json!({
            "sourceControlWritingStyle": {
                "mode": "conventional_commits",
                "customInstructions": "Use scope",
                "followChangeRequestTemplates": false
            },
            "pullRequestMergeMethod": "squash",
            "removeAgentCreditsOnMerge": true,
            "reviewGuidesEnabled": true,
            "reviewGuideInstructions": "Focus on API changes"
        }));
        assert_eq!(sc.writing_mode, "conventional_commits");
        assert_eq!(sc.writing_custom_instructions, "Use scope");
        assert!(!sc.follow_change_request_templates);
        assert_eq!(sc.pull_request_merge_method.as_deref(), Some("squash"));
        assert!(sc.remove_agent_credits_on_merge);
        assert!(sc.review_guides_enabled);
        assert_eq!(sc.review_guide_instructions, "Focus on API changes");
    }
}
