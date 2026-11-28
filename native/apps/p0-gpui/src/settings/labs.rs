//! Labs settings (`/settings/labs`): toggles server beta features (`guestSharingEnabled`,
//! `linkedEnvironmentsEnabled`, `workflowsEnabled`, `workflowSkippedRunsKept`,
//! `promptSuggestionsEnabled`, `simlockDeviceHostsEnabled`, `fastWorktreeCheckout`) via
//! `server.updateSettings`.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, SharedString, Styled as _,
    Window, div, px,
};
use serde_json::{Value, json};

use crate::app::P0App;
use crate::settings::{setting_row, web_url};
use crate::theme::AppPalette;

const DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT: u64 = 10;
const MAX_WORKFLOW_SKIPPED_RUNS_KEPT: u64 = 100;

#[derive(Default)]
pub struct LabsUiState {
    skipped_runs_input: Option<Entity<InputState>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabsServerSettings {
    pub guest_sharing_enabled: bool,
    pub linked_environments_enabled: bool,
    pub workflows_enabled: bool,
    pub workflow_skipped_runs_kept: u64,
    pub prompt_suggestions_enabled: bool,
    pub simlock_device_hosts_enabled: bool,
    pub fast_worktree_checkout: bool,
}

impl LabsServerSettings {
    pub fn from_json(settings: &Value) -> Self {
        let flag = |key: &str| settings.get(key).and_then(Value::as_bool).unwrap_or(false);
        Self {
            guest_sharing_enabled: flag("guestSharingEnabled"),
            linked_environments_enabled: flag("linkedEnvironmentsEnabled"),
            workflows_enabled: flag("workflowsEnabled"),
            workflow_skipped_runs_kept: settings
                .get("workflowSkippedRunsKept")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT),
            prompt_suggestions_enabled: flag("promptSuggestionsEnabled"),
            simlock_device_hosts_enabled: flag("simlockDeviceHostsEnabled"),
            fast_worktree_checkout: flag("fastWorktreeCheckout"),
        }
    }
}

pub fn parse_skipped_runs(raw: &str) -> Option<u64> {
    let val = raw.trim().parse::<u64>().ok()?;
    (val <= MAX_WORKFLOW_SKIPPED_RUNS_KEPT).then_some(val)
}

impl P0App {
    pub(crate) fn render_labs(
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
        let labs = LabsServerSettings::from_json(&settings);
        let mut col = div().flex().flex_col().gap(px(4.0));

        let toggles: [(&str, &str, &str, bool); 5] = [
            (
                "guestSharingEnabled",
                "Guest links",
                "Share a thread with a guest who watches it live in a browser and sends messages you approve.",
                labs.guest_sharing_enabled,
            ),
            (
                "linkedEnvironmentsEnabled",
                "Linked environments",
                "Let agents here work on your other machines, and theirs here.",
                labs.linked_environments_enabled,
            ),
            (
                "workflowsEnabled",
                "Workflows",
                "Run multi-step workflows from files in the workflows folder of this server's T3 home.",
                labs.workflows_enabled,
            ),
            (
                "promptSuggestionsEnabled",
                "Suggest next prompt",
                "Show a predicted next message in the empty composer after a Claude or Codex turn.",
                labs.prompt_suggestions_enabled,
            ),
            (
                "simlockDeviceHostsEnabled",
                "Simlock device hosts",
                "Let the Device panel lease simulators and emulators from a Simlock pool.",
                labs.simlock_device_hosts_enabled,
            ),
        ];

        for (key, label, desc, checked) in toggles {
            col = col.child(setting_row(
                self.i18n.tr(label),
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .child(
                        div()
                            .flex_1()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(self.i18n.tr(desc).to_owned())),
                    )
                    .child(
                        Switch::new(SharedString::from(format!("labs-{key}")))
                            .checked(checked)
                            .on_click(cx.listener(move |this, val: &bool, _, cx| {
                                this.bridge.update_settings(json!({ key: *val }));
                                cx.notify();
                            })),
                    ),
                palette,
            ));

            if key == "workflowsEnabled" && labs.workflows_enabled {
                let kept_str = labs.workflow_skipped_runs_kept.to_string();
                let skipped_in = self
                    .settings_ui
                    .labs
                    .skipped_runs_input
                    .get_or_insert_with(|| {
                        cx.new(|cx| {
                            let mut st = InputState::new(window, cx).placeholder("10");
                            st.set_value(kept_str, window, cx);
                            st
                        })
                    })
                    .clone();
                let save_in = skipped_in.clone();
                let workflows_url = web_url(self.bridge.base_url(), "/workflows");
                col = col.child(setting_row(
                    self.i18n.tr("Skipped runs kept"),
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(div().w(px(96.0)).child(Input::new(&skipped_in)))
                        .child(
                            Button::new("labs-skipped-save")
                                .label(self.i18n.tr("Save").to_owned())
                                .compact()
                                .primary()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let raw = save_in.read(cx).value().to_string();
                                    if let Some(count) = parse_skipped_runs(&raw) {
                                        this.bridge.update_settings(
                                            json!({ "workflowSkippedRunsKept": count }),
                                        );
                                        cx.notify();
                                    }
                                })),
                        )
                        .child(
                            Button::new("labs-workflows-open")
                                .label("Open Workflows in browser".to_owned())
                                .compact()
                                .outline()
                                .on_click(move |_, _, cx| cx.open_url(&workflows_url)),
                        ),
                    palette,
                ));
            }
        }

        let supports_fast_checkout = self
            .bridge
            .server_config()
            .and_then(|c| {
                c.environment
                    .capabilities
                    .get("fastWorktreeCheckout")
                    .cloned()
            })
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if supports_fast_checkout {
            col = col.child(setting_row(
                self.i18n.tr("Fast worktree checkout"),
                Switch::new("labs-fastWorktreeCheckout")
                    .checked(labs.fast_worktree_checkout)
                    .on_click(cx.listener(|this, val: &bool, _, cx| {
                        this.bridge
                            .update_settings(json!({ "fastWorktreeCheckout": *val }));
                        cx.notify();
                    })),
                palette,
            ));
        }

        col
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_labs_settings_and_validates_skipped_runs() {
        let labs = LabsServerSettings::from_json(&json!({
            "workflowsEnabled": true,
            "workflowSkippedRunsKept": 25,
            "promptSuggestionsEnabled": true
        }));
        assert!(labs.workflows_enabled);
        assert_eq!(labs.workflow_skipped_runs_kept, 25);
        assert!(labs.prompt_suggestions_enabled);
        assert!(!labs.guest_sharing_enabled);

        assert_eq!(parse_skipped_runs("0"), Some(0));
        assert_eq!(parse_skipped_runs("100"), Some(100));
        assert_eq!(parse_skipped_runs("101"), None);
        assert_eq!(parse_skipped_runs("-1"), None);
    }
}
