//! Connections / Environments settings (`/settings/connections`): shows this environment's
//! connection & endpoints from `server.getConfig` and linked peer environments via
//! `peerLinks.list` / `peerLinks.unlink`.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    Context, FontWeight, IntoElement, ParentElement as _, SharedString, Styled as _, div, px,
};
use p0_client::ConnectionState;
use serde_json::{Value, json};

use crate::app::P0App;
use crate::settings::general::section_heading;
use crate::settings::{setting_row, web_url};
use crate::theme::AppPalette;

#[derive(Default)]
pub struct ConnectionsUiState {
    peer_links_requested: bool,
}

impl P0App {
    pub(crate) fn render_connections(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if !self.settings_ui.connections.peer_links_requested {
            self.settings_ui.connections.peer_links_requested = true;
            self.bridge.refresh_peer_links();
        }

        let mut col = div().flex().flex_col().gap(px(12.0));

        // 1. This environment
        col = col.child(section_heading(self.i18n.tr("This machine"), palette));
        let conn = self.bridge.connection_state();
        let (dot, state_text) = match &conn {
            ConnectionState::Connected => (palette.success, self.i18n.tr("Connected").to_owned()),
            ConnectionState::Connecting => (palette.warning, self.i18n.tr("Connecting").to_owned()),
            ConnectionState::Reconnecting { attempt, .. } => (
                palette.warning,
                format!("{} (#{attempt})", self.i18n.tr("Reconnecting")),
            ),
            ConnectionState::SignedOutElsewhere { .. } => (
                palette.warning,
                self.i18n.tr("Signed in elsewhere").to_owned(),
            ),
            ConnectionState::Disconnected => (
                palette.muted_foreground,
                self.i18n.tr("Not connected").to_owned(),
            ),
            ConnectionState::AuthFailed(msg) => (palette.error, format!("Auth failed: {msg}")),
        };

        let config = self.bridge.server_config();
        let label = config
            .as_ref()
            .map(|c| c.environment.label.clone())
            .unwrap_or_else(|| self.i18n.tr("Local environment").to_owned());
        let env_id = config
            .as_ref()
            .map(|c| c.environment.environment_id.clone())
            .unwrap_or_default();
        let platform = config
            .as_ref()
            .map(|c| {
                format!(
                    "{}/{}",
                    c.environment.platform.os, c.environment.platform.arch
                )
            })
            .unwrap_or_default();
        let version = config
            .as_ref()
            .map(|c| c.environment.server_version.clone())
            .unwrap_or_default();

        let mut local_card = crate::feed::card(palette)
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
                            .child(div().w(px(8.0)).h(px(8.0)).rounded_full().bg(dot))
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(SharedString::from(label)),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(palette.muted_foreground)
                                    .child(SharedString::from(state_text)),
                            ),
                    )
                    .child(
                        Button::new("conn-reconnect")
                            .label(self.i18n.tr("Reconnect").to_owned())
                            .compact()
                            .outline()
                            .on_click(cx.listener(|this, _, _, _| {
                                this.bridge.reconnect_now();
                            })),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .font_family("monospace")
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(self.bridge.base_url().to_owned())),
            );

        let meta = [
            (!env_id.is_empty()).then_some(env_id),
            (!platform.is_empty()).then_some(platform),
            (!version.is_empty()).then(|| format!("v{version}")),
            config.as_ref().and_then(|c| c.hostname.clone()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        if !meta.is_empty() {
            local_card = local_card.child(
                div()
                    .text_xs()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(meta)),
            );
        }

        if let Some(cfg) = &config {
            local_card =
                local_card.child(div().text_xs().text_color(palette.muted_foreground).child(
                    SharedString::from(format!("Auth: {:?} · CWD: {}", cfg.auth.policy, cfg.cwd)),
                ));
            if !cfg.direct_endpoints.is_empty() {
                let endpoints = cfg
                    .direct_endpoints
                    .iter()
                    .map(|e| e.url.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                local_card = local_card.child(
                    div()
                        .text_xs()
                        .font_family("monospace")
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(format!("Endpoints: {endpoints}"))),
                );
            }
        }
        col = col.child(local_card);

        // 2. Linked environments
        col = col.child(section_heading(
            self.i18n.tr("Linked environments"),
            palette,
        ));
        let linked_enabled = self
            .bridge
            .server_settings()
            .and_then(|s| s.get("linkedEnvironmentsEnabled").and_then(Value::as_bool))
            .unwrap_or(false);
        col = col.child(setting_row(
            self.i18n.tr("Linked environments"),
            Switch::new("conn-linked-enabled")
                .checked(linked_enabled)
                .on_click(cx.listener(|this, checked: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "linkedEnvironmentsEnabled": *checked }));
                    cx.notify();
                })),
            palette,
        ));

        let open_web_url = web_url(self.bridge.base_url(), "/settings/connections");
        col = col.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    Button::new("conn-links-refresh")
                        .label(self.i18n.tr("Refresh").to_owned())
                        .compact()
                        .outline()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.bridge.refresh_peer_links();
                            cx.notify();
                        })),
                )
                .child(
                    Button::new("conn-open-web")
                        .label(self.i18n.tr("Open in browser").to_owned())
                        .compact()
                        .outline()
                        .on_click(move |_, _, cx| cx.open_url(&open_web_url)),
                ),
        );

        match self.bridge.peer_links() {
            None => {
                col = col.child(div().text_sm().text_color(palette.muted_foreground).child(
                    SharedString::from(self.i18n.tr("Loading linked environments…").to_owned()),
                ));
            }
            Some(links) if links.is_empty() => {
                col = col.child(
                    crate::feed::card(palette)
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .child(SharedString::from(
                                    self.i18n.tr("No linked environments").to_owned(),
                                )),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(palette.muted_foreground)
                                .child(SharedString::from(
                                    self.i18n
                                        .tr("Remote DPoP pairing and adding new peer links are managed in the web app.")
                                        .to_owned(),
                                )),
                        ),
                );
            }
            Some(links) => {
                for link in links {
                    let dot_color = match link.status.as_str() {
                        "reachable" => palette.success,
                        "expired" => palette.error,
                        _ => palette.warning,
                    };
                    let unlink_id = link.environment_id.clone();
                    let urls = link.urls.join(", ");
                    let mut card = crate::feed::card(palette).child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.0))
                                            .child(
                                                div()
                                                    .w(px(8.0))
                                                    .h(px(8.0))
                                                    .rounded_full()
                                                    .bg(dot_color),
                                            )
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .truncate()
                                                    .child(SharedString::from(link.label.clone())),
                                            ),
                                    )
                                    .child(
                                        div().text_xs().text_color(palette.muted_foreground).child(
                                            SharedString::from(format!(
                                                "{} · {}",
                                                link.access, link.status
                                            )),
                                        ),
                                    ),
                            )
                            .child(
                                Button::new(SharedString::from(format!(
                                    "peer-forget-{}",
                                    link.environment_id
                                )))
                                .label(self.i18n.tr("Forget").to_owned())
                                .compact()
                                .danger()
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.bridge.unlink_peer(unlink_id.clone());
                                        cx.notify();
                                    },
                                )),
                            ),
                    );
                    if !urls.is_empty() {
                        card = card.child(
                            div()
                                .text_xs()
                                .font_family("monospace")
                                .text_color(palette.muted_foreground)
                                .truncate()
                                .child(SharedString::from(urls)),
                        );
                    }
                    if let Some(err) = link.last_error.as_deref().filter(|e| !e.is_empty()) {
                        card = card.child(
                            div()
                                .text_xs()
                                .text_color(palette.error)
                                .child(SharedString::from(err.to_owned())),
                        );
                    }
                    col = col.child(card);
                }
            }
        }

        col
    }
}
