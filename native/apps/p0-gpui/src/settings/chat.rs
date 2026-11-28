//! Chat settings (`/settings/chat`): composer send shortcut, follow-up behavior,
//! slash-menu skills, and tool call visibility (persisted in `LocalPrefs`).

use gpui_kit::component::switch::Switch;
use gpui_kit::{
    Context, IntoElement, ParentElement as _, StatefulInteractiveElement as _, Styled as _, div, px,
};

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::general::section_heading;
use crate::settings::setting_row;
use crate::theme::AppPalette;

const SEND_SHORTCUTS: [(&str, &str); 3] = [
    ("enter", "Enter"),
    ("mod-enter-multiline", "Mod + Enter for multiline prompts"),
    ("mod-enter", "Mod + Enter always"),
];

const FOLLOW_UP_MODES: [(&str, &str); 2] = [("steer", "Steer"), ("queue", "Queue")];

const TOOL_VISIBILITY_MODES: [(&str, &str); 4] = [
    ("showAll", "Show all"),
    ("hideSuccessful", "Hide successful"),
    ("hideAll", "Hide all"),
    ("zen", "Zen"),
];

impl P0App {
    pub(crate) fn render_chat_settings(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut col = div().flex().flex_col().gap(px(4.0));

        col = col.child(section_heading(self.i18n.tr("Composer"), palette));
        let send_shortcut = self.prefs.send_shortcut.clone();
        let mut send_choices = div().flex().flex_wrap().gap(px(6.0));
        for (value, label) in SEND_SHORTCUTS {
            send_choices = send_choices.child(
                choice(
                    format!("chat-send-{value}"),
                    self.i18n.tr(label).to_owned(),
                    send_shortcut == value,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.send_shortcut = value.to_owned();
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Send shortcut"),
            send_choices,
            palette,
        ));

        col = col.child(setting_row(
            self.i18n.tr("Show skills in slash menu"),
            Switch::new("chat-skills-slash")
                .checked(self.prefs.show_skills_in_slash_menu)
                .on_click(cx.listener(|this, checked: &bool, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.show_skills_in_slash_menu = *checked;
                    this.set_prefs(prefs, window, cx);
                })),
            palette,
        ));

        col = col.child(section_heading(self.i18n.tr("Follow-ups"), palette));
        let follow_up = self.prefs.follow_up_behavior.clone();
        let mut follow_choices = div().flex().flex_wrap().gap(px(6.0));
        for (value, label) in FOLLOW_UP_MODES {
            follow_choices = follow_choices.child(
                choice(
                    format!("chat-followup-{value}"),
                    self.i18n.tr(label).to_owned(),
                    follow_up == value,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.follow_up_behavior = value.to_owned();
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Follow-up behavior"),
            follow_choices,
            palette,
        ));

        col = col.child(section_heading(self.i18n.tr("Activity"), palette));
        let tool_vis = self.prefs.tool_call_visibility.clone();
        let mut vis_choices = div().flex().flex_wrap().gap(px(6.0));
        for (value, label) in TOOL_VISIBILITY_MODES {
            vis_choices = vis_choices.child(
                choice(
                    format!("chat-tool-vis-{value}"),
                    self.i18n.tr(label).to_owned(),
                    tool_vis == value,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.tool_call_visibility = value.to_owned();
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Tool calls in chat"),
            vis_choices,
            palette,
        ));

        col
    }
}
