//! Root GPUI window shell: connection chip, collapsible project/thread sidebar, and main pane.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::{
    App, AppContext as _, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use p0_client::ConnectionState;
use p0_i18n::{Catalog, Key};
use p0_protocol::ThreadStatus;

use crate::bridge::AppBridge;
use crate::theme::AppPalette;

pub struct P0App {
    bridge: Arc<AppBridge>,
    i18n: Catalog,
    last_seen_version: u64,
    collapsed_projects: HashSet<String>,
    selected_thread_id: Option<String>,
}

impl P0App {
    pub fn new(bridge: Arc<AppBridge>, cx: &mut Context<Self>) -> Self {
        let last_seen_version = bridge.version();

        // Coalesce state notifications to <=60 Hz (~16ms), only repainting when version bumps.
        let bridge_poll = bridge.clone();
        cx.spawn(async move |this, cx| {
            let mut last = last_seen_version;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let current = bridge_poll.version();
                if current != last {
                    last = current;
                    let ok = this
                        .update(cx, |app, cx| {
                            app.last_seen_version = current;
                            app.auto_select_first_thread();
                            cx.notify();
                        })
                        .is_ok();
                    if !ok {
                        break;
                    }
                }
            }
        })
        .detach();

        Self {
            bridge,
            i18n: Catalog::for_system(),
            last_seen_version,
            collapsed_projects: HashSet::new(),
            selected_thread_id: None,
        }
    }

    fn auto_select_first_thread(&mut self) {
        if self.selected_thread_id.is_some() {
            return;
        }
        let shell = self.bridge.shell_state();
        if let Some(first) = shell
            .threads
            .iter()
            .find(|t| t.deleted_at.is_none() && t.archived_at.is_none())
        {
            self.selected_thread_id = Some(first.id.clone());
            self.bridge.select_thread(first.id.clone());
        }
    }

    fn toggle_project(&mut self, project_id: String, cx: &mut Context<Self>) {
        if !self.collapsed_projects.remove(&project_id) {
            self.collapsed_projects.insert(project_id);
        }
        cx.notify();
    }

    fn select_thread(&mut self, thread_id: String, cx: &mut Context<Self>) {
        if self.selected_thread_id.as_deref() == Some(thread_id.as_str()) {
            return;
        }
        self.selected_thread_id = Some(thread_id.clone());
        self.bridge.select_thread(thread_id);
        cx.notify();
    }

    fn render_connection_chip(&self, palette: &AppPalette, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.bridge.connection_state();
        let (dot_color, label, show_retry) = match &state {
            ConnectionState::Connected => (
                palette.success,
                self.i18n.get(Key::Connected).to_owned(),
                false,
            ),
            ConnectionState::Connecting => (
                palette.warning,
                self.i18n.get(Key::Connecting).to_owned(),
                false,
            ),
            ConnectionState::Reconnecting { attempt, .. } => (
                palette.warning,
                format!("{} (#{attempt})", self.i18n.get(Key::Reconnecting)),
                true,
            ),
            ConnectionState::Disconnected => (
                palette.muted_foreground,
                self.i18n.get(Key::NotConnected).to_owned(),
                true,
            ),
            ConnectionState::AuthFailed(msg) => (
                palette.error,
                format!("{}: {msg}", self.i18n.get(Key::Error)),
                true,
            ),
        };

        let mut chip = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .px(px(8.0))
            .py(px(4.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(palette.border)
            .bg(palette.card)
            .text_xs()
            .text_color(palette.foreground)
            .child(div().w(px(7.0)).h(px(7.0)).rounded_full().bg(dot_color))
            .child(SharedString::from(label));

        if show_retry {
            let bridge = self.bridge.clone();
            let retry_label = SharedString::from(self.i18n.get(Key::Reconnect).to_owned());
            chip = chip.child(
                div()
                    .id("conn-reconnect-btn")
                    .ml(px(6.0))
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded(px(4.0))
                    .bg(palette.primary)
                    .text_color(palette.primary_foreground)
                    .cursor_pointer()
                    .on_click(cx.listener(move |_, _, _, _| {
                        bridge.reconnect_now();
                    }))
                    .child(retry_label),
            );
        }

        chip
    }

    fn render_sidebar(&self, palette: &AppPalette, cx: &mut Context<Self>) -> impl IntoElement {
        let shell = self.bridge.shell_state();
        let mut projects_col = div().flex().flex_col().gap(px(6.0)).p(px(8.0));

        if shell.projects.is_empty() {
            projects_col = projects_col.child(
                div()
                    .px(px(8.0))
                    .py(px(12.0))
                    .text_sm()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(
                        self.i18n.get(Key::NoProjectsYet).to_owned(),
                    )),
            );
        } else {
            for project in &shell.projects {
                let project_id = project.id.clone();
                let collapsed = self.collapsed_projects.contains(&project_id);
                let threads = shell.threads_for_project(&project.id);
                let chevron = if collapsed { "▸" } else { "▾" };
                let toggle_id = SharedString::from(format!("proj-toggle-{}", project.id));
                let pid_click = project_id.clone();

                let header = div()
                    .id(toggle_id)
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(8.0))
                    .py(px(5.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .hover(|s| s.bg(palette.row_hover))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.toggle_project(pid_click.clone(), cx);
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .text_xs()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .text_color(palette.muted_foreground)
                            .child(chevron)
                            .child(SharedString::from(project.title.clone())),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(threads.len().to_string())),
                    );

                let mut group = div().flex().flex_col().gap(px(2.0)).child(header);

                if !collapsed {
                    for thread in threads {
                        let tid = thread.id.clone();
                        let selected = self.selected_thread_id.as_deref() == Some(tid.as_str());
                        let dot_color = status_dot_color(thread.status, palette);
                        let has_approval = thread.pending_runtime_request.is_some();
                        let unread = thread.is_unread();
                        let row_id = SharedString::from(format!("thread-row-{}", thread.id));
                        let title = if thread.title.trim().is_empty() {
                            self.i18n.get(Key::UntitledThread).to_owned()
                        } else {
                            thread.title.clone()
                        };

                        let mut row = div()
                            .id(row_id)
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(6.0))
                            .px(px(10.0))
                            .py(px(6.0))
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .bg(if selected {
                                palette.row_selected
                            } else {
                                gpui_kit::transparent_black()
                            })
                            .hover(|s| s.bg(palette.row_hover))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.select_thread(tid.clone(), cx);
                            }))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(7.0))
                                    .min_w_0()
                                    .child(div().w(px(7.0)).h(px(7.0)).rounded_full().bg(dot_color))
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(palette.foreground)
                                            .truncate()
                                            .child(SharedString::from(title)),
                                    ),
                            );

                        if has_approval {
                            row = row.child(
                                div()
                                    .px(px(5.0))
                                    .py(px(1.0))
                                    .rounded(px(4.0))
                                    .bg(palette.warning_surface)
                                    .text_xs()
                                    .text_color(palette.badge_approval)
                                    .child(SharedString::from(
                                        self.i18n.get(Key::ApprovalNeeded).to_owned(),
                                    )),
                            );
                        } else if unread {
                            row = row.child(
                                div()
                                    .w(px(6.0))
                                    .h(px(6.0))
                                    .rounded_full()
                                    .bg(palette.primary),
                            );
                        }

                        group = group.child(row);
                    }
                }

                projects_col = projects_col.child(group);
            }
        }

        div()
            .w(px(280.0))
            .h_full()
            .flex()
            .flex_col()
            .bg(palette.sidebar)
            .border_r_1()
            .border_color(palette.border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(12.0))
                    .py(px(10.0))
                    .border_b_1()
                    .border_color(palette.border)
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .text_color(palette.foreground)
                            .child("p0code"),
                    )
                    .child(self.render_connection_chip(palette, cx)),
            )
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex_1()
                    .overflow_y_scroll()
                    .child(projects_col),
            )
    }
}

impl Render for P0App {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = AppPalette::for_appearance(window.appearance());
        let selected_label = self
            .selected_thread_id
            .as_deref()
            .and_then(|id| self.bridge.shell_state().thread_by_id(id).map(|t| t.title.clone()))
            .unwrap_or_else(|| self.i18n.get(Key::NoThreadsFound).to_owned());

        div()
            .size_full()
            .flex()
            .flex_row()
            .bg(palette.background)
            .text_color(palette.foreground)
            .child(self.render_sidebar(&palette, cx))
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .text_sm()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(selected_label)),
                    ),
            )
    }
}

pub fn status_dot_color(status: ThreadStatus, palette: &AppPalette) -> gpui_kit::Hsla {
    match status {
        ThreadStatus::Running | ThreadStatus::Starting | ThreadStatus::Preparing => palette.info,
        ThreadStatus::Waiting | ThreadStatus::Queued => palette.warning,
        ThreadStatus::Completed => palette.success,
        ThreadStatus::Failed => palette.error,
        ThreadStatus::Idle
        | ThreadStatus::Interrupted
        | ThreadStatus::Cancelled
        | ThreadStatus::RolledBack
        | ThreadStatus::Unknown => palette.muted_foreground,
    }
}

pub fn run_gui(bridge: Arc<AppBridge>) {
    gpui_kit::application().run(move |cx: &mut App| {
        gpui_kit::init(cx);
        let window_opts = gpui_kit::WindowOptions {
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some("p0code".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let bridge_w = bridge.clone();
        gpui_kit::open_window(window_opts, cx, move |window, cx| {
            gpui_kit::component::Theme::sync_system_appearance(Some(window), cx);
            let view = cx.new(|cx| P0App::new(bridge_w.clone(), cx));
            cx.new(|cx| gpui_kit::component::Root::new(view, window, cx))
        })
        .expect("failed to open p0-gpui window");
    });
}
