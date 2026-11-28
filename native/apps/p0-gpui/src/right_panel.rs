//! The panel beside the chat: the thread's changes, and later its files.

use gpui_kit::{
    Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, div, px,
};

use crate::app::P0App;
use crate::diff_panel::DiffPanel;
use crate::theme::AppPalette;

pub const RIGHT_PANEL_WIDTH: f32 = 560.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelTab {
    Diff,
}

pub struct RightPanel {
    pub open: bool,
    pub tab: PanelTab,
    pub diff: DiffPanel,
}

impl RightPanel {
    pub fn new(cx: &mut Context<P0App>) -> Self {
        Self {
            open: false,
            tab: PanelTab::Diff,
            diff: DiffPanel::new(cx),
        }
    }

    /// Width the chat column gives up while the panel shows.
    pub fn width(&self) -> f32 {
        if self.open { RIGHT_PANEL_WIDTH } else { 0.0 }
    }
}

impl P0App {
    /// Shows `tab`, or hides the panel when `tab` is already showing.
    pub(crate) fn toggle_right_panel(&mut self, tab: PanelTab, cx: &mut Context<Self>) {
        let panel = &mut self.right_panel;
        panel.open = !(panel.open && panel.tab == tab);
        panel.tab = tab;
        self.sync_right_panel();
        cx.notify();
    }

    /// Points the panel at the open thread; cheap enough to run on every store change.
    pub(crate) fn sync_right_panel(&mut self) {
        let thread_id = self.selected_thread_id().map(ToOwned::to_owned);
        let cwd = thread_id.as_deref().and_then(|id| self.thread_cwd(id));
        let checkpoints = self
            .thread
            .projection
            .as_ref()
            .map(|p| p.checkpoints.as_slice())
            .unwrap_or_default();
        self.right_panel
            .diff
            .sync(thread_id.as_deref(), cwd.as_deref(), checkpoints);
    }

    pub(crate) fn render_right_panel(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        if !self.right_panel.open || self.selected_thread_id().is_none() {
            return None;
        }
        let tab = |id: &'static str, label: &str, this_tab: PanelTab, current: PanelTab| {
            let selected = this_tab == current;
            div()
                .id(id)
                .px(px(8.0))
                .py(px(3.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .when_selected(selected, palette)
                .text_color(if selected {
                    palette.foreground
                } else {
                    palette.muted_foreground
                })
                .hover(|s| s.bg(palette.row_hover))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.right_panel.tab = this_tab;
                    cx.notify();
                }))
                .child(SharedString::from(label.to_owned()))
        };
        let current = self.right_panel.tab;
        let header = div()
            .flex_none()
            .flex()
            .items_center()
            .justify_between()
            .px(px(8.0))
            .py(px(6.0))
            .border_b_1()
            .border_color(palette.border)
            .child(div().flex().gap(px(4.0)).child(tab(
                "right-tab-diff",
                self.i18n.tr("Changes"),
                PanelTab::Diff,
                current,
            )))
            .child(
                div()
                    .id("right-panel-close")
                    .px(px(6.0))
                    .cursor_pointer()
                    .text_color(palette.muted_foreground)
                    .hover(|s| s.text_color(palette.foreground))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.right_panel.open = false;
                        cx.notify();
                    }))
                    .child("✕"),
            );
        let body = match current {
            PanelTab::Diff => self.render_diff_panel(palette, cx).into_any_element(),
        };
        Some(
            div()
                .w(px(RIGHT_PANEL_WIDTH))
                .flex_none()
                .h_full()
                .flex()
                .flex_col()
                .bg(palette.background)
                .border_l_1()
                .border_color(palette.border)
                .child(header)
                .child(body),
        )
    }
}

trait Selected {
    fn when_selected(self, selected: bool, palette: &AppPalette) -> Self;
}

impl Selected for gpui_kit::Stateful<gpui_kit::Div> {
    fn when_selected(self, selected: bool, palette: &AppPalette) -> Self {
        if selected {
            self.bg(palette.row_selected)
        } else {
            self
        }
    }
}
