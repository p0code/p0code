//! Sharing & access settings (`/settings/access`): device approval, guest links, preview tunnels,
//! and public tunnel controls via `server.updateSettings`, plus auth policy summary.

use gpui_kit::component::button::Button;
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    Context, IntoElement, ParentElement as _, SharedString, StatefulInteractiveElement as _,
    Styled as _, div, px,
};
use serde_json::{Value, json};

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::general::section_heading;
use crate::settings::{setting_row, web_url};
use crate::theme::AppPalette;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessServerSettings {
    pub require_connect_device_approval: bool,
    pub guest_sharing_enabled: bool,
    pub enable_preview_tunnel: bool,
    pub public_tunnels_enabled: bool,
    pub public_tunnels_agent_publishing: String,
}

impl AccessServerSettings {
    pub fn from_json(settings: &Value) -> Self {
        let bool_or = |key: &str, default: bool| {
            settings
                .get(key)
                .and_then(Value::as_bool)
                .unwrap_or(default)
        };
        let pt = settings.get("publicTunnels");
        Self {
            require_connect_device_approval: bool_or("requireConnectDeviceApproval", false),
            guest_sharing_enabled: bool_or("guestSharingEnabled", false),
            enable_preview_tunnel: bool_or("enablePreviewTunnel", true),
            public_tunnels_enabled: pt
                .and_then(|v| v.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            public_tunnels_agent_publishing: pt
                .and_then(|v| v.get("agentPublishing"))
                .and_then(Value::as_str)
                .unwrap_or("ask")
                .to_owned(),
        }
    }
}

impl P0App {
    pub(crate) fn render_access_settings(
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
        let acc = AccessServerSettings::from_json(&settings);
        let web_access_url = web_url(self.bridge.base_url(), "/settings/access");
        let mut col = div().flex().flex_col().gap(px(12.0));

        // 1. Access & guest sharing
        col = col.child(section_heading("Access & sharing", palette));
        let auth_policy = self
            .bridge
            .server_config()
            .map(|c| format!("{:?}", c.auth.policy))
            .unwrap_or_else(|| "unknown".to_owned());
        col = col.child(setting_row(
            "Auth policy",
            div()
                .text_xs()
                .font_family("monospace")
                .text_color(palette.muted_foreground)
                .child(SharedString::from(auth_policy)),
            palette,
        ));
        col = col.child(setting_row(
            "Require device approval for Connect",
            Switch::new("access-device-approval")
                .checked(acc.require_connect_device_approval)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "requireConnectDeviceApproval": *val }));
                    cx.notify();
                })),
            palette,
        ));
        col = col.child(setting_row(
            self.i18n.tr("Guest links"),
            Switch::new("access-guest-links")
                .checked(acc.guest_sharing_enabled)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "guestSharingEnabled": *val }));
                    cx.notify();
                })),
            palette,
        ));

        // 2. Tunnels
        col = col.child(section_heading("Tunnels", palette));
        col = col.child(setting_row(
            "Preview tunnel",
            Switch::new("access-preview-tunnel")
                .checked(acc.enable_preview_tunnel)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "enablePreviewTunnel": *val }));
                    cx.notify();
                })),
            palette,
        ));
        col = col.child(setting_row(
            "Public tunnels",
            Switch::new("access-public-tunnels")
                .checked(acc.public_tunnels_enabled)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge.update_settings(json!({
                        "publicTunnels": { "enabled": *val }
                    }));
                    cx.notify();
                })),
            palette,
        ));
        if acc.public_tunnels_enabled {
            let mut pub_modes = div().flex().flex_wrap().gap(px(6.0));
            for (mode, label) in [
                ("off", "Off"),
                ("ask", "Ask"),
                ("allow-full-access", "Allow in full access"),
            ] {
                pub_modes = pub_modes.child(
                    choice(
                        format!("access-pub-{mode}"),
                        label.to_owned(),
                        acc.public_tunnels_agent_publishing == mode,
                        palette,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.bridge.update_settings(json!({
                            "publicTunnels": { "agentPublishing": mode }
                        }));
                        cx.notify();
                    })),
                );
            }
            col = col.child(setting_row("Agent publishing", pub_modes, palette));
        }

        // 3. Sessions, pairing & relay in browser
        col = col.child(section_heading("Pairing & sessions", palette));
        col = col.child(setting_row(
            "Devices, pairing & relay",
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
                        .child("Pair phones/browsers, manage signed-in sessions, and configure relay servers in the web app."),
                )
                .child(
                    div().flex_none().child(
                        Button::new("access-open-web")
                            .label(self.i18n.tr("Open in browser").to_owned())
                            .compact()
                            .outline()
                            .on_click(move |_, _, cx| cx.open_url(&web_access_url)),
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
    fn parses_access_settings() {
        let acc = AccessServerSettings::from_json(&json!({
            "requireConnectDeviceApproval": true,
            "guestSharingEnabled": true,
            "enablePreviewTunnel": false,
            "publicTunnels": {
                "enabled": true,
                "agentPublishing": "off"
            }
        }));
        assert!(acc.require_connect_device_approval);
        assert!(acc.guest_sharing_enabled);
        assert!(!acc.enable_preview_tunnel);
        assert!(acc.public_tunnels_enabled);
        assert_eq!(acc.public_tunnels_agent_publishing, "off");
    }
}
