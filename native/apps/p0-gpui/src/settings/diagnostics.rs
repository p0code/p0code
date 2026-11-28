//! Diagnostics settings (`/settings/diagnostics`): reads host resources
//! (`server.getHostResources`), server process tree (`server.getProcessDiagnostics`), and trace
//! summary (`server.getTraceDiagnostics`).

use gpui_kit::component::button::Button;
use gpui_kit::{
    Context, FontWeight, IntoElement, ParentElement as _, SharedString, Styled as _, div, px,
};
use serde_json::Value;

use crate::app::P0App;
use crate::settings::general::section_heading;
use crate::settings::maintenance::format_bytes;
use crate::settings::web_url;
use crate::theme::AppPalette;

#[derive(Default)]
pub struct DiagnosticsUiState {
    requested: bool,
}

/// Extracts `message` from an Effect `Schema.Option<{ message }>` JSON payload.
pub fn extract_effect_option_error(opt: Option<&Value>) -> Option<String> {
    let val = opt?;
    if val.get("_tag").and_then(Value::as_str) == Some("Some") {
        return val
            .get("value")
            .and_then(|v| v.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    val.get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

impl P0App {
    pub(crate) fn render_diagnostics(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        if !self.settings_ui.diagnostics.requested {
            self.settings_ui.diagnostics.requested = true;
            self.bridge.refresh_diagnostics();
        }
        let web_diag_url = web_url(self.bridge.base_url(), "/settings/diagnostics");
        let mut col = div().flex().flex_col().gap(px(12.0)).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(div().text_xs().text_color(palette.muted_foreground).child(
                    "Live snapshot of host resources, server process tree, and local traces.",
                ))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            Button::new("diag-refresh")
                                .label(self.i18n.tr("Refresh").to_owned())
                                .compact()
                                .outline()
                                .on_click(cx.listener(|this, _, _, _| {
                                    this.bridge.refresh_diagnostics();
                                })),
                        )
                        .child(
                            Button::new("diag-open-web")
                                .label("Charts & export in browser".to_owned())
                                .compact()
                                .outline()
                                .on_click(move |_, _, cx| cx.open_url(&web_diag_url)),
                        ),
                ),
        );

        // 1. Host resources
        col = col.child(section_heading("Host resources", palette));
        match self.bridge.host_resources() {
            None => {
                col = col.child(div().text_xs().text_color(palette.muted_foreground).child(
                    SharedString::from(self.i18n.get(p0_i18n::Key::Loading).to_owned()),
                ));
            }
            Some(hr) => {
                let cpu_pct = hr
                    .cpu_utilization
                    .map(|u| format!("{:.1}%", u * 100.0))
                    .unwrap_or_else(|| "n/a".to_owned());
                let used_mem = (hr.total_memory_bytes - hr.available_memory_bytes).max(0.0);
                col = col.child(
                    crate::feed::card(palette).child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(SharedString::from(format!(
                                "CPU: {cpu_pct} ({} cores) · Memory: {} / {} ({} free)",
                                hr.cpu_count,
                                format_bytes(used_mem),
                                format_bytes(hr.total_memory_bytes),
                                format_bytes(hr.available_memory_bytes)
                            ))),
                    ),
                );
            }
        }

        // 2. Process tree
        col = col.child(section_heading("Server processes", palette));
        match self.bridge.process_diagnostics() {
            None => {
                col = col.child(div().text_xs().text_color(palette.muted_foreground).child(
                    SharedString::from(self.i18n.get(p0_i18n::Key::Loading).to_owned()),
                ));
            }
            Some(pd) => {
                let mut card = crate::feed::card(palette).child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child(SharedString::from(format!(
                            "PID {} · {} process(es) · Total RSS: {} · Total CPU: {:.1}%",
                            pd.server_pid,
                            pd.process_count,
                            format_bytes(pd.total_rss_bytes),
                            pd.total_cpu_percent
                        ))),
                );
                if let Some(err) = extract_effect_option_error(pd.error.as_ref()) {
                    card = card.child(
                        div()
                            .text_xs()
                            .text_color(palette.error)
                            .child(SharedString::from(err)),
                    );
                }
                let mut sorted = pd.processes.clone();
                sorted.sort_by(|a, b| {
                    b.rss_bytes
                        .partial_cmp(&a.rss_bytes)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                for proc in sorted.iter().take(12) {
                    let cmd = if proc.command.len() > 80 {
                        format!("{}…", &proc.command[..proc.command.floor_char_boundary(80)])
                    } else {
                        proc.command.clone()
                    };
                    card = card.child(
                        div()
                            .text_xs()
                            .font_family("monospace")
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(format!(
                                "pid {:<7} {:>6.1}%  {:>9}  {}",
                                proc.pid,
                                proc.cpu_percent,
                                format_bytes(proc.rss_bytes),
                                cmd
                            ))),
                    );
                }
                if sorted.len() > 12 {
                    card = card.child(div().text_xs().text_color(palette.muted_foreground).child(
                        SharedString::from(format!("+{} more process(es)", sorted.len() - 12)),
                    ));
                }
                col = col.child(card);
            }
        }

        // 3. Trace diagnostics
        col = col.child(section_heading("Traces & logs", palette));
        match self.bridge.trace_diagnostics() {
            None => {
                col = col.child(div().text_xs().text_color(palette.muted_foreground).child(
                    SharedString::from(self.i18n.get(p0_i18n::Key::Loading).to_owned()),
                ));
            }
            Some(td) => {
                let mut card = crate::feed::card(palette)
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(SharedString::from(format!(
                                "Records: {} · Failures: {} · Slow spans (>{}ms): {} · Interruptions: {}",
                                td.record_count,
                                td.failure_count,
                                td.slow_span_threshold_ms,
                                td.slow_span_count,
                                td.interruption_count
                            ))),
                    )
                    .child(
                        div()
                            .text_xs()
                            .font_family("monospace")
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(td.trace_file_path)),
                    );
                if let Some(err) = extract_effect_option_error(td.error.as_ref()) {
                    card = card.child(
                        div()
                            .text_xs()
                            .text_color(palette.warning)
                            .child(SharedString::from(err)),
                    );
                }
                col = col.child(card);
            }
        }

        col
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_effect_option_error_payloads() {
        assert_eq!(
            extract_effect_option_error(Some(&json!({"_tag": "None"}))),
            None
        );
        assert_eq!(
            extract_effect_option_error(Some(
                &json!({"_tag": "Some", "value": {"message": "trace file missing"}})
            )),
            Some("trace file missing".to_owned())
        );
    }
}
