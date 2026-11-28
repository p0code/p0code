//! About settings (`/settings/about`): native client & server versions, environment/backend
//! details, legal fork notice, privacy policy, and open-source licenses links.

use gpui_kit::component::button::Button;
use gpui_kit::{
    ClipboardItem, Context, FontWeight, IntoElement, ParentElement as _, SharedString, Styled as _,
    div, px,
};

use crate::app::P0App;
use crate::settings::general::section_heading;
use crate::settings::{setting_row, web_url};
use crate::theme::AppPalette;

const PRIVACY_POLICY_URL: &str = "https://t3.codes/privacy-policy";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

impl P0App {
    pub(crate) fn render_about(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut col = div().flex().flex_col().gap(px(12.0));
        let config = self.bridge.server_config();

        // 1. App & Backend
        col = col.child(section_heading(self.i18n.tr("App"), palette));

        let client_ver = format!("p0-gpui {CLIENT_VERSION}");
        let copy_ver = client_ver.clone();
        col = col.child(setting_row(
            self.i18n.tr("Version"),
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .text_xs()
                        .font_family("monospace")
                        .font_weight(FontWeight::MEDIUM)
                        .child(SharedString::from(client_ver)),
                )
                .child(
                    Button::new("about-copy-version")
                        .label(self.i18n.tr("Copy version").to_owned())
                        .compact()
                        .outline()
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_ver.clone()));
                        }),
                ),
            palette,
        ));

        let server_summary = config
            .as_ref()
            .map(|c| {
                format!(
                    "{} ({}) · {}/{}",
                    c.environment.server_version,
                    c.environment.label,
                    c.environment.platform.os,
                    c.environment.platform.arch
                )
            })
            .unwrap_or_else(|| self.i18n.tr("Not connected").to_owned());
        col = col.child(setting_row(
            "Server",
            div()
                .flex()
                .flex_col()
                .items_end()
                .gap(px(2.0))
                .child(
                    div()
                        .text_xs()
                        .font_family("monospace")
                        .child(SharedString::from(server_summary)),
                )
                .child(
                    div()
                        .text_xs()
                        .font_family("monospace")
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(self.bridge.base_url().to_owned())),
                ),
            palette,
        ));

        let welcome_url = web_url(self.bridge.base_url(), "/welcome");
        col = col.child(setting_row(
            self.i18n.tr("Welcome page"),
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
                        .child(SharedString::from(
                            self.i18n
                                .tr("See your agents, import projects, and set up your phone.")
                                .to_owned(),
                        )),
                )
                .child(
                    Button::new("about-open-welcome")
                        .label(self.i18n.tr("Open").to_owned())
                        .compact()
                        .outline()
                        .on_click(move |_, _, cx| cx.open_url(&welcome_url)),
                ),
            palette,
        ));

        let web_about_url = web_url(self.bridge.base_url(), "/settings/about");
        col = col.child(setting_row(
            "Updates & desktop backend",
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
                        .child(
                            "Native client self-updates are not built in yet. Manage server updates or inspect backend details in the web app.",
                        ),
                )
                .child(
                    Button::new("about-open-web")
                        .label(self.i18n.tr("Open in browser").to_owned())
                        .compact()
                        .outline()
                        .on_click(move |_, _, cx| cx.open_url(&web_about_url)),
                ),
            palette,
        ));

        // 2. Legal
        col = col.child(section_heading(self.i18n.tr("Legal"), palette));
        col = col.child(
            crate::feed::card(palette)
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child(SharedString::from(
                            self.i18n.tr("Unofficial fork").to_owned(),
                        )),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(
                            self.i18n
                                .tr("p0code is an independent, unofficial fork of T3 Code. It is not affiliated with, endorsed by, or sponsored by T3 Tools, Inc. 'T3 Code' is a trademark of T3 Tools, Inc.")
                                .to_owned(),
                        )),
                ),
        );

        col = col.child(setting_row(
            self.i18n.tr("Privacy policy"),
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
                        .child(SharedString::from(
                            self.i18n.tr("How we handle your data.").to_owned(),
                        )),
                )
                .child(
                    Button::new("about-privacy")
                        .label(self.i18n.tr("View policy").to_owned())
                        .compact()
                        .outline()
                        .on_click(|_, _, cx| cx.open_url(PRIVACY_POLICY_URL)),
                ),
            palette,
        ));

        let licenses_url = web_url(self.bridge.base_url(), "/settings/open-source-licenses");
        col = col.child(setting_row(
            self.i18n.tr("Open source licenses"),
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
                        .child(SharedString::from(
                            self.i18n
                                .tr("Notices for dependencies, assets, and optional tools used by p0code.")
                                .to_owned(),
                        )),
                )
                .child(
                    Button::new("about-licenses")
                        .label(self.i18n.tr("View licenses").to_owned())
                        .compact()
                        .outline()
                        .on_click(move |_, _, cx| cx.open_url(&licenses_url)),
                ),
            palette,
        ));

        let _ = cx;
        col
    }
}
