//! The workspace title row above the chat (`[data-chat-header]` in the web app).

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, px, svg,
};
use p0_theme as tokens;

use super::P0App;
use crate::right_panel::PanelTab;
use crate::theme::AppPalette;

impl P0App {
    /// A borderless 52px breadcrumb: project, a slash, then the thread title.
    pub(super) fn render_chat_header(
        &self,
        palette: &AppPalette,
        project: Option<String>,
        title: String,
        branch: Option<String>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let text = |s: String| {
            div()
                .text_size(px(tokens::TEXT_SM.size))
                .line_height(px(tokens::TEXT_SM.line_height))
                .font_weight(FontWeight::MEDIUM)
                .child(SharedString::from(s))
        };
        let mut crumbs = div().flex_1().min_w_0().flex().items_center().gap(px(12.0));
        if let Some(project) = project {
            crumbs = crumbs
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .min_w_0()
                        .child(self.project_monogram(&project, palette))
                        .child(
                            text(project)
                                .truncate()
                                .text_color(palette.muted_foreground),
                        ),
                )
                .child(
                    text("/".to_owned())
                        .font_weight(FontWeight::NORMAL)
                        .text_color(palette.sidebar_secondary_label),
                );
        }
        crumbs = crumbs.child(
            text(title)
                .min_w_0()
                .truncate()
                .text_color(palette.foreground),
        );

        let mut controls = div().flex_none().flex().items_center().gap(px(4.0));
        if let Some(branch) = branch {
            controls = controls.child(
                div()
                    .mr(px(8.0))
                    .text_size(px(tokens::TEXT_XS.size))
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(branch)),
            );
        }
        let open = self.right_panel.open;
        controls = controls.child(
            div()
                .id("chat-header-panel")
                .size(px(tokens::WORKSPACE_TITLEBAR_CONTROL_SIZE))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(tokens::CONTROL_RADIUS))
                .cursor_pointer()
                .when(open, |d| d.bg(palette.row_selected))
                .hover(|s| s.bg(palette.row_hover))
                .on_click(cx.listener(|this, _, _, cx| this.toggle_right_panel(PanelTab::Diff, cx)))
                .child(
                    svg()
                        .path("icons/panel-right.svg")
                        .size(px(16.0))
                        .text_color(palette.foreground),
                ),
        );

        div()
            .w_full()
            .flex_none()
            .h(px(tokens::WORKSPACE_TOPBAR_HEIGHT))
            .pl(px(20.0))
            .pr(px(tokens::WORKSPACE_GUTTER))
            .bg(palette.background)
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(crumbs)
            .child(controls)
            .into_any_element()
    }
}
