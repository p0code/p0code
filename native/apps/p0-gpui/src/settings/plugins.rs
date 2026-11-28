//! Plugins settings (`/settings/plugins`): subscribes to `plugins.subscribe` and toggles
//! plugins via `plugins.setEnabled`.

use gpui_kit::component::button::Button;
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    Context, FontWeight, IntoElement, ParentElement as _, SharedString, Styled as _, div, px,
};

use crate::app::P0App;
use crate::settings::web_url;
use crate::theme::AppPalette;

impl P0App {
    pub(crate) fn render_plugins(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.bridge.ensure_plugins_subscribed();
        let open_web_url = web_url(self.bridge.base_url(), "/settings/plugins");

        let mut col = div().flex().flex_col().gap(px(12.0)).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(
                            "Plugin shop, installer, and per-plugin panels open in the web app.",
                        ),
                )
                .child(
                    div().flex_none().child(
                        Button::new("plugins-open-web")
                            .label(self.i18n.tr("Open in browser").to_owned())
                            .compact()
                            .outline()
                            .on_click(move |_, _, cx| cx.open_url(&open_web_url)),
                    ),
                ),
        );

        let Some(plugins) = self.bridge.plugins() else {
            return col.child(div().text_sm().text_color(palette.muted_foreground).child(
                SharedString::from(self.i18n.get(p0_i18n::Key::Loading).to_owned()),
            ));
        };

        if plugins.is_empty() {
            return col.child(
                crate::feed::card(palette).child(
                    div()
                        .text_sm()
                        .text_color(palette.muted_foreground)
                        .child("No plugins reported by this environment."),
                ),
            );
        }

        for plugin in plugins {
            let dot = match plugin.state.as_str() {
                "running" => palette.success,
                "starting" => palette.warning,
                "failed" => palette.error,
                _ => palette.muted_foreground,
            };
            let plugin_id = plugin.manifest.id.clone();
            let toggle_id = plugin_id.clone();
            let mut card = crate::feed::card(palette)
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
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .flex_none()
                                        .w(px(8.0))
                                        .h(px(8.0))
                                        .rounded_full()
                                        .bg(dot),
                                )
                                .child(
                                    div()
                                        .text_sm()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .truncate()
                                        .child(SharedString::from(plugin.manifest.name.clone())),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .font_family("monospace")
                                        .text_color(palette.muted_foreground)
                                        .child(SharedString::from(format!(
                                            "{} · {} · {}",
                                            plugin.manifest.id,
                                            plugin.manifest.version,
                                            plugin.origin
                                        ))),
                                ),
                        )
                        .child(
                            Switch::new(SharedString::from(format!("plugin-en-{plugin_id}")))
                                .checked(plugin.enabled)
                                .on_click(cx.listener(move |this, checked: &bool, _, cx| {
                                    this.bridge.set_plugin_enabled(toggle_id.clone(), *checked);
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(plugin.manifest.description.clone())),
                );

            if !plugin.manifest.capabilities.is_empty() {
                card = card.child(
                    div()
                        .text_xs()
                        .font_family("monospace")
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(format!(
                            "Capabilities: {}",
                            plugin.manifest.capabilities.join(", ")
                        ))),
                );
            }
            if let Some(msg) = plugin.message.as_deref().filter(|m| !m.is_empty()) {
                card = card.child(
                    div()
                        .text_xs()
                        .text_color(if plugin.state == "failed" {
                            palette.error
                        } else {
                            palette.muted_foreground
                        })
                        .child(SharedString::from(msg.to_owned())),
                );
            }
            col = col.child(card);
        }

        col
    }
}
