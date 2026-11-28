//! General settings (`/settings/general`): notifications, confirmations, display preferences
//! (kept in `LocalPrefs`), and server-backed default permissions (`server.updateSettings`).

use gpui_kit::component::switch::Switch;
use gpui_kit::{
    Context, FontWeight, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use p0_i18n::SUPPORTED_LOCALES;
use p0_protocol::RuntimeMode;

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::{BOOL_SETTINGS, GeneralServerSettings, setting_row};
use crate::theme::AppPalette;

pub const NOTIFICATION_MODES: [(&str, &str); 4] = [
    ("off", "Off"),
    ("notifications", "Notifications only"),
    ("sound", "Sound only"),
    ("notifications-and-sound", "Notifications with sound"),
];

pub const TIMESTAMP_FORMATS: [(&str, &str); 3] = [
    ("locale", "System default"),
    ("12-hour", "12-hour"),
    ("24-hour", "24-hour"),
];

pub const USAGE_DISPLAY_MODES: [(&str, &str); 2] = [("left", "Left"), ("used", "Used")];

impl P0App {
    pub(crate) fn render_general(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut col = div().flex().flex_col().gap(px(4.0));

        // Notifications
        col = col.child(section_heading(self.i18n.tr("Notifications"), palette));
        let current_notif = self.prefs.notification_mode.clone();
        let mut notif_choices = div().flex().flex_wrap().gap(px(6.0));
        for (value, label) in NOTIFICATION_MODES {
            notif_choices = notif_choices.child(
                choice(
                    format!("notif-mode-{value}"),
                    self.i18n.tr(label).to_owned(),
                    current_notif == value,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.notification_mode = value.to_owned();
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Thread notifications"),
            notif_choices,
            palette,
        ));
        col = col.child(setting_row(
            self.i18n.tr("In-app notifications"),
            Switch::new("setting-in-app-notifications")
                .checked(self.prefs.in_app_notifications_enabled)
                .on_click(cx.listener(|this, checked: &bool, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.in_app_notifications_enabled = *checked;
                    this.set_prefs(prefs, window, cx);
                })),
            palette,
        ));

        // Display
        col = col.child(section_heading(self.i18n.tr("Display"), palette));
        let current = self.prefs.language.clone();
        let mut languages = div().flex().flex_wrap().gap(px(6.0));
        let follow = choice(
            "lang-system",
            self.i18n.tr("Follow system").to_owned(),
            current.is_none(),
            palette,
        )
        .on_click(cx.listener(|this, _, window, cx| {
            let mut prefs = this.prefs.clone();
            prefs.language = None;
            this.set_prefs(prefs, window, cx);
        }));
        languages = languages.child(follow);
        for (code, name) in SUPPORTED_LOCALES {
            languages = languages.child(
                choice(
                    format!("lang-{code}"),
                    *name,
                    current.as_deref() == Some(*code),
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.language = Some((*code).to_owned());
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(self.i18n.tr("Language"), languages, palette));

        let current_ts = self.prefs.timestamp_format.clone();
        let mut ts_choices = div().flex().flex_wrap().gap(px(6.0));
        for (value, label) in TIMESTAMP_FORMATS {
            ts_choices = ts_choices.child(
                choice(
                    format!("ts-fmt-{value}"),
                    self.i18n.tr(label).to_owned(),
                    current_ts == value,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.timestamp_format = value.to_owned();
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Time format"),
            ts_choices,
            palette,
        ));

        let current_usage = self.prefs.usage_display_mode.clone();
        let mut usage_choices = div().flex().flex_wrap().gap(px(6.0));
        for (value, label) in USAGE_DISPLAY_MODES {
            usage_choices = usage_choices.child(
                choice(
                    format!("usage-mode-{value}"),
                    self.i18n.tr(label).to_owned(),
                    current_usage == value,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.usage_display_mode = value.to_owned();
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Show usage as"),
            usage_choices,
            palette,
        ));

        // Confirmations
        col = col.child(section_heading(self.i18n.tr("Confirmations"), palette));
        col = col
            .child(setting_row(
                self.i18n.tr("Unpin confirmation"),
                Switch::new("setting-confirm-unpin")
                    .checked(self.prefs.confirm_thread_unpin)
                    .on_click(cx.listener(|this, checked: &bool, window, cx| {
                        let mut prefs = this.prefs.clone();
                        prefs.confirm_thread_unpin = *checked;
                        this.set_prefs(prefs, window, cx);
                    })),
                palette,
            ))
            .child(setting_row(
                self.i18n.tr("Archive confirmation"),
                Switch::new("setting-confirm-archive")
                    .checked(self.prefs.confirm_thread_archive)
                    .on_click(cx.listener(|this, checked: &bool, window, cx| {
                        let mut prefs = this.prefs.clone();
                        prefs.confirm_thread_archive = *checked;
                        this.set_prefs(prefs, window, cx);
                    })),
                palette,
            ))
            .child(setting_row(
                self.i18n.tr("Delete confirmation"),
                Switch::new("setting-confirm-delete")
                    .checked(self.prefs.confirm_thread_delete)
                    .on_click(cx.listener(|this, checked: &bool, window, cx| {
                        let mut prefs = this.prefs.clone();
                        prefs.confirm_thread_delete = *checked;
                        this.set_prefs(prefs, window, cx);
                    })),
                palette,
            ))
            .child(setting_row(
                self.i18n.tr("Terminal close confirmation"),
                Switch::new("setting-confirm-terminal-close")
                    .checked(self.prefs.confirm_terminal_close)
                    .on_click(cx.listener(|this, checked: &bool, window, cx| {
                        let mut prefs = this.prefs.clone();
                        prefs.confirm_terminal_close = *checked;
                        this.set_prefs(prefs, window, cx);
                    })),
                palette,
            ));

        // Server-backed settings
        col = col.child(section_heading(self.i18n.tr("Server"), palette));
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
                choice(
                    format!("mode-{}", mode.as_wire_str()),
                    crate::composer::runtime_mode_label(mode, &self.i18n),
                    server.default_runtime_mode == mode,
                    palette,
                )
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
}

pub(crate) fn section_heading(title: &str, palette: &AppPalette) -> impl IntoElement {
    div()
        .pt(px(14.0))
        .pb(px(4.0))
        .text_xs()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(palette.muted_foreground)
        .child(SharedString::from(title.to_owned()))
}
