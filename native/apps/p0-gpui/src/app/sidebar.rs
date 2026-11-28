//! The thread sidebar, laid out like the web app's (`components/Sidebar.tsx`,
//! `components/sidebar/SidebarThreadRow.tsx` card rows).

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    Context, FontWeight, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, linear_color_stop,
    linear_gradient, px, svg,
};
use p0_i18n::Key;
use p0_protocol::{ProjectShell, ThreadShell, ThreadStatus};
use p0_theme as tokens;

use super::{P0App, View};
use crate::settings::SECTIONS;
use crate::theme::AppPalette;
use p0_client::ConnectionState;

const SIDEBAR_WIDTH: f32 = 256.0;
const ROW_HEIGHT: f32 = 78.0;
const ICON: f32 = 16.0;

fn icon(name: &str, size: f32, color: Hsla) -> impl IntoElement {
    svg()
        .path(SharedString::from(format!("icons/{name}.svg")))
        .flex_none()
        .size(px(size))
        .text_color(color)
}

impl P0App {
    /// Threads in sidebar order: pinned first, then most recently updated, like the web list.
    pub(super) fn sidebar_threads(&self) -> Vec<&ThreadShell> {
        if self.group_by_project {
            return self
                .shell
                .projects
                .iter()
                .flat_map(|p| self.shell.threads_for_project(&p.id))
                .collect();
        }
        let mut threads: Vec<&ThreadShell> = self
            .shell
            .threads
            .iter()
            .filter(|t| t.deleted_at.is_none() && t.archived_at.is_none())
            .collect();
        threads.sort_by(|a, b| {
            b.pinned_at
                .is_some()
                .cmp(&a.pinned_at.is_some())
                .then_with(|| b.activity_timestamp().cmp(a.activity_timestamp()))
        });
        threads
    }

    pub(super) fn render_sidebar(
        &self,
        palette: &AppPalette,
        dark: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut list = div()
            .flex()
            .flex_col()
            .px(px(tokens::SIDEBAR_CONTENT_INSET))
            .pb(px(tokens::SIDEBAR_CONTENT_INSET));
        let threads = self.sidebar_threads();

        if self.shell.projects.is_empty() || threads.is_empty() && !self.group_by_project {
            let key = if self.shell.projects.is_empty() {
                Key::NoProjectsYet
            } else {
                Key::NoThreadsFound
            };
            list = list.child(
                div()
                    .pt(px(24.0))
                    .flex()
                    .justify_center()
                    .text_xs()
                    .text_color(palette.sidebar_muted_foreground.opacity(0.75))
                    .child(SharedString::from(self.i18n.get(key).to_owned())),
            );
        } else if self.group_by_project {
            for project in &self.shell.projects {
                list = list.child(self.render_project_header(project, palette, cx));
                for thread in self.shell.threads_for_project(&project.id) {
                    list = list.child(self.render_thread_card(thread, palette, dark, cx));
                }
            }
        } else {
            for thread in threads {
                list = list.child(self.render_thread_card(thread, palette, dark, cx));
            }
        }

        div()
            .w(px(SIDEBAR_WIDTH))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(palette.sidebar)
            .border_r_1()
            .border_color(palette.sidebar_edge)
            .child(self.render_sidebar_header(palette, cx))
            .child(self.render_sidebar_search(palette, cx))
            .children(self.render_connection_notice(palette, cx))
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex_1()
                    .overflow_y_scroll()
                    .child(list),
            )
            .child(self.render_sidebar_footer(palette, cx))
    }

    /// The 52px title row. The web paints the theme's stage artwork here; this is its tint only.
    fn render_sidebar_header(
        &self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .relative()
            .h(px(tokens::WORKSPACE_TOPBAR_HEIGHT))
            .flex_none()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(80.0))
                    .bg(linear_gradient(
                        180.0,
                        linear_color_stop(palette.primary_accent.opacity(0.8), 0.0),
                        linear_color_stop(palette.sidebar.opacity(0.0), 1.0),
                    )),
            )
            .child(
                div()
                    .id("sidebar-toggle")
                    .absolute()
                    .top(px(12.0))
                    .left(px(13.0))
                    .size(px(tokens::WORKSPACE_TITLEBAR_CONTROL_SIZE))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(tokens::CONTROL_RADIUS))
                    .cursor_pointer()
                    .hover(|s| s.bg(palette.sidebar_row_hover))
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_sidebar(window, cx)))
                    .child(icon("panel-left-close", ICON, palette.sidebar_foreground)),
            )
    }

    fn render_sidebar_search(
        &self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let icon_button = |id: &'static str, name: &'static str, active: bool| {
            div()
                .id(id)
                .size(px(tokens::WORKSPACE_TITLEBAR_CONTROL_SIZE))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(tokens::CONTROL_RADIUS))
                .cursor_pointer()
                .when(active, |d| d.bg(palette.sidebar_row_active))
                .hover(|s| s.bg(palette.sidebar_row_hover))
                .child(icon(name, ICON, palette.sidebar_icon))
        };
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4.0))
            .p(px(tokens::SIDEBAR_CONTENT_INSET))
            .child(
                div()
                    .id("sidebar-search")
                    .flex_1()
                    .min_w_0()
                    .h(px(32.0))
                    .flex()
                    .items_center()
                    .gap(px(tokens::SIDEBAR_CONTROL_GAP))
                    .px(px(8.0))
                    .rounded(px(tokens::RADIUS_MD))
                    .cursor_pointer()
                    .hover(|s| s.bg(palette.sidebar_row_hover))
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_palette(window, cx)))
                    .child(icon("search", ICON, palette.sidebar_icon))
                    .child(
                        div()
                            .text_size(px(tokens::TEXT_SM.size))
                            .line_height(px(tokens::TEXT_SM.line_height))
                            .text_color(palette.sidebar_muted_foreground)
                            .child(SharedString::from(self.i18n.tr("Search").to_owned())),
                    ),
            )
            .child(
                icon_button("sidebar-projects", "folder", self.group_by_project).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.group_by_project = !this.group_by_project;
                        cx.notify();
                    }),
                ),
            )
            .child(
                icon_button("sidebar-new-thread", "square-pen", false).on_click(
                    cx.listener(|this, _, window, cx| this.start_new_thread(None, window, cx)),
                ),
            )
    }

    /// The web shows connection trouble as a banner; a healthy connection shows nothing.
    fn render_connection_notice(
        &self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        if matches!(self.bridge.connection_state(), ConnectionState::Connected) {
            return None;
        }
        Some(
            div()
                .px(px(tokens::SIDEBAR_CONTENT_INSET))
                .pb(px(tokens::SIDEBAR_CONTENT_INSET))
                .child(self.render_connection_chip(palette, cx)),
        )
    }

    fn render_project_header(
        &self,
        project: &ProjectShell,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let new_pid = project.id.clone();
        div()
            .id(SharedString::from(format!("proj-{}", project.id)))
            .h(px(32.0))
            .mt(px(4.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .px(px(tokens::SIDEBAR_ROW_CONTENT_INSET))
            .rounded(px(tokens::RADIUS_MD))
            .text_xs()
            .font_weight(FontWeight::MEDIUM)
            .text_color(palette.sidebar_muted_foreground)
            .hover(|s| s.bg(palette.sidebar_row_hover))
            .child(self.project_monogram(&project.title, palette))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(SharedString::from(project.title.clone())),
            )
            .child(
                div()
                    .id(SharedString::from(format!("proj-new-{}", project.id)))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.start_new_thread(Some(new_pid.clone()), window, cx);
                    }))
                    .child(icon("square-pen", 14.0, palette.sidebar_icon)),
            )
    }

    pub(super) fn project_monogram(&self, title: &str, palette: &AppPalette) -> impl IntoElement {
        let (text, color) = tokens::project_identity(title);
        let tint: Hsla = gpui_kit::rgba(if palette.dark {
            color.dark
        } else {
            color.light
        })
        .into();
        div()
            .flex_none()
            .size(px(16.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.0))
            .bg(tint.opacity(0.14))
            .text_color(tint)
            .text_size(px(8.25))
            .font_weight(FontWeight::BOLD)
            .child(SharedString::from(text))
    }

    fn render_thread_card(
        &self,
        thread: &ThreadShell,
        palette: &AppPalette,
        dark: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let tid = thread.id.clone();
        let active =
            self.view == View::Chat && self.selected_thread_id.as_deref() == Some(tid.as_str());
        let title = if thread.title.trim().is_empty() {
            self.i18n.get(Key::UntitledThread).to_owned()
        } else {
            thread.title.clone()
        };
        let project_title = self
            .shell
            .projects
            .iter()
            .find(|p| p.id == thread.project_id)
            .map(|p| p.title.clone());
        let status = self.top_status(thread, palette);
        let working = matches!(
            thread.status,
            ThreadStatus::Running | ThreadStatus::Starting | ThreadStatus::Preparing
        );
        // `shouldRecedeSidebarThread`: settled rows step back unless they need attention.
        let recede = !active
            && thread.pending_runtime_request.is_none()
            && (working
                || matches!(thread.status, ThreadStatus::Waiting | ThreadStatus::Queued)
                || !thread.is_unread());

        let secondary = palette.sidebar_secondary_label;
        let meta_text = |text: String| {
            div()
                .text_size(px(tokens::TEXT_XS.size))
                .line_height(px(tokens::TEXT_XS.line_height))
                .child(SharedString::from(text))
        };

        let mut top = div()
            .h(px(20.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0();
        if let Some(project) = &project_title {
            top = top.child(self.project_monogram(project, palette)).child(
                meta_text(project.clone())
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(secondary),
            );
        } else {
            top = top.child(div().flex_1());
        }
        top = top.child(match status {
            Some((label, name, color)) => div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(4.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(color)
                .child(icon(name, ICON, color))
                .child(meta_text(label)),
            None => div()
                .flex_none()
                .text_color(secondary)
                .child(meta_text(relative_time(
                    thread.activity_timestamp(),
                    &self.i18n,
                ))),
        });

        let title_color = if recede {
            palette.sidebar_foreground.opacity(0.75)
        } else {
            palette.sidebar_foreground
        };
        let mut meta = div()
            .mt(px(2.0))
            .h(px(16.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_color(secondary);
        if let Some(host) = machine_label() {
            meta = meta
                .child(icon("monitor", 14.0, palette.icon_muted))
                .child(meta_text(host).flex_1().min_w_0().truncate());
        }

        let ring = if active && !dark { 1.0 } else { 0.0 };
        div().py(px(2.0)).child(
            div()
                .id(SharedString::from(format!("thread-row-{}", thread.id)))
                .h(px(ROW_HEIGHT))
                // The web's light ring is inset; a GPUI border takes layout space, so the
                // padding gives that pixel back.
                .px(px(tokens::SIDEBAR_ROW_CONTENT_INSET - ring))
                .py(px(tokens::SIDEBAR_CONTENT_INSET - ring))
                .rounded(px(tokens::RADIUS_MD))
                .cursor_pointer()
                .when(active, |d| {
                    d.bg(palette.sidebar_row_active).when(!dark, |d| {
                        d.border_1()
                            .border_color(palette.sidebar_border.opacity(0.7))
                    })
                })
                .when(!active, |d| d.hover(|s| s.bg(palette.sidebar_row_hover)))
                .on_click(cx.listener(move |this, _, _, cx| this.open_thread(tid.clone(), cx)))
                .child(top)
                .child(
                    div()
                        .mt(px(4.0))
                        .h(px(20.0))
                        .truncate()
                        .text_size(px(tokens::TEXT_SM.size))
                        .line_height(px(tokens::TEXT_SM.line_height))
                        .font_weight(if recede {
                            FontWeight::NORMAL
                        } else {
                            FontWeight::MEDIUM
                        })
                        .text_color(title_color)
                        .child(SharedString::from(title)),
                )
                .child(meta),
        )
    }

    /// The web row's status slot (`topStatus`): label, lucide icon and color.
    fn top_status(
        &self,
        thread: &ThreadShell,
        palette: &AppPalette,
    ) -> Option<(String, &'static str, Hsla)> {
        if thread.pending_runtime_request.is_some() {
            return Some((
                self.i18n.tr("Approval").to_owned(),
                "shield-alert",
                palette.warning,
            ));
        }
        match thread.status {
            ThreadStatus::Preparing | ThreadStatus::Starting => Some((
                self.i18n.tr("Setting up").to_owned(),
                "loader-circle",
                palette.info,
            )),
            ThreadStatus::Running => Some((
                self.i18n.tr("Working").to_owned(),
                "loader-circle",
                palette.info,
            )),
            ThreadStatus::Waiting | ThreadStatus::Queued => Some((
                self.i18n.tr("Waiting").to_owned(),
                "clock",
                palette.sidebar_muted_foreground,
            )),
            ThreadStatus::Failed => Some((
                self.i18n.tr("Failed").to_owned(),
                "circle-alert",
                palette.error,
            )),
            _ => None,
        }
    }

    fn render_sidebar_footer(
        &self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4.0))
            .pt(px(4.0))
            .px(px(tokens::SIDEBAR_CONTENT_INSET))
            .pb(px(tokens::SIDEBAR_CONTENT_INSET))
            .child(
                div()
                    .id("sidebar-settings")
                    .size(px(32.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(tokens::CONTROL_RADIUS))
                    .cursor_pointer()
                    .hover(|s| s.bg(palette.sidebar_row_hover))
                    .on_click(
                        cx.listener(|this, _, _, cx| this.open_settings(SECTIONS[0].path, cx)),
                    )
                    .child(icon("settings", ICON, palette.sidebar_icon)),
            )
    }
}

/// The machine line of a row. The web names the thread's environment; the native client only
/// talks to its local server, so that is this host.
fn machine_label() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
}

/// The web row's compact age: `now`, `5m`, `3h`, `2d`.
fn relative_time(iso: &str, i18n: &p0_i18n::Catalog) -> String {
    let Some(then) = parse_unix_seconds(iso) else {
        return String::new();
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(then);
    let minutes = (now - then).max(0) / 60;
    let (count, unit) = match minutes {
        0 => return i18n.tr("now").to_owned(),
        1..60 => (minutes, "{count}m"),
        60..1440 => (minutes / 60, "{count}h"),
        _ => (minutes / 1440, "{count}d"),
    };
    i18n.tr_format(unit, &[("count", &count.to_string())])
}

/// Seconds since the epoch for an RFC 3339 UTC timestamp (`2026-01-02T03:04:05.678Z`).
fn parse_unix_seconds(iso: &str) -> Option<i64> {
    let num = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utc_timestamps() {
        assert_eq!(parse_unix_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_unix_seconds("2026-11-28T05:54:42.930Z"),
            Some(1_795_845_282)
        );
        assert_eq!(parse_unix_seconds("garbage"), None);
    }
}
