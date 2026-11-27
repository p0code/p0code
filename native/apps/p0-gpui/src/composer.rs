//! Multiline prompt composer with Send/Stop, model picker (fed by `server.getConfig`),
//! and runtime-mode toggle.

use gpui_kit::component::input::Textarea;
use gpui_kit::{
    Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use p0_i18n::{Catalog, Key};
use p0_protocol::{ModelSelection, RuntimeMode, ServerConfig};

use crate::app::P0App;
use crate::theme::AppPalette;

#[derive(Debug, Clone)]
pub struct ModelChoice {
    pub instance_id: String,
    pub provider_label: String,
    pub model_slug: String,
    pub model_label: String,
}

impl ModelChoice {
    pub fn to_selection(&self) -> ModelSelection {
        ModelSelection {
            instance_id: self.instance_id.clone(),
            model: self.model_slug.clone(),
            options: None,
        }
    }
}

pub fn available_models(config: Option<&ServerConfig>) -> Vec<ModelChoice> {
    let Some(cfg) = config else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for provider in &cfg.providers {
        if !provider.is_available() {
            continue;
        }
        let provider_label = provider.label().to_owned();
        for model in &provider.models {
            out.push(ModelChoice {
                instance_id: provider.instance_id.clone(),
                provider_label: provider_label.clone(),
                model_slug: model.slug.clone(),
                model_label: model
                    .short_name
                    .clone()
                    .unwrap_or_else(|| model.name.clone()),
            });
        }
    }
    out
}

pub fn runtime_mode_label(mode: RuntimeMode, i18n: &Catalog) -> String {
    match mode {
        RuntimeMode::ApprovalRequired => i18n.get(Key::Supervised).to_owned(),
        RuntimeMode::AutoAcceptEdits => i18n.get(Key::AutoAcceptEdits).to_owned(),
        RuntimeMode::Auto => i18n.get(Key::Auto).to_owned(),
        RuntimeMode::FullAccess => i18n.get(Key::FullAccess).to_owned(),
        RuntimeMode::Unknown => mode.as_wire_str().to_owned(),
    }
}

pub fn render_composer(
    app: &P0App,
    palette: &AppPalette,
    cx: &mut Context<P0App>,
) -> impl IntoElement {
    let thread_id = app.selected_thread_id();
    let tstate = app.bridge().thread_state();
    let shell = app.bridge().shell_state();
    let cfg = app.bridge().server_config();
    let choices = available_models(cfg.as_ref());

    let current_model = app
        .selected_model()
        .cloned()
        .or_else(|| tstate.projection.as_ref().map(|p| p.thread.model_selection.clone()))
        .or_else(|| {
            thread_id
                .and_then(|id| shell.thread_by_id(id).map(|t| t.model_selection.clone()))
        })
        .or_else(|| choices.first().map(ModelChoice::to_selection));

    let model_text = current_model
        .as_ref()
        .map(|m| {
            choices
                .iter()
                .find(|c| c.instance_id == m.instance_id && c.model_slug == m.model)
                .map(|c| format!("{} · {}", c.provider_label, c.model_label))
                .unwrap_or_else(|| format!("{} · {}", m.instance_id, m.model))
        })
        .unwrap_or_else(|| app.i18n().get(Key::Model).to_owned());

    let current_runtime_mode = app
        .selected_runtime_mode()
        .or_else(|| tstate.projection.as_ref().map(|p| p.thread.runtime_mode))
        .or_else(|| thread_id.and_then(|id| shell.thread_by_id(id).map(|t| t.runtime_mode)))
        .unwrap_or(RuntimeMode::ApprovalRequired);

    let is_running = tstate.active_run_id().is_some()
        || thread_id
            .and_then(|id| shell.thread_by_id(id))
            .is_some_and(|t| t.status.is_active());

    let mut wrapper = div()
        .w_full()
        .max_w(px(760.0))
        .mx_auto()
        .px(px(16.0))
        .pb(px(14.0))
        .pt(px(8.0))
        .flex()
        .flex_col()
        .gap(px(6.0));

    // Inline model picker menu when expanded.
    if app.model_picker_open() {
        let mut menu = div()
            .id("model-picker-menu")
            .w_full()
            .max_h(px(220.0))
            .overflow_y_scroll()
            .p(px(6.0))
            .rounded(px(8.0))
            .bg(palette.card)
            .border_1()
            .border_color(palette.border)
            .flex()
            .flex_col()
            .gap(px(2.0));

        if choices.is_empty() {
            menu = menu.child(
                div()
                    .px(px(8.0))
                    .py(px(6.0))
                    .text_xs()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(app.i18n().get(Key::Model).to_owned())),
            );
        } else {
            for choice in &choices {
                let sel = choice.to_selection();
                let is_selected = current_model
                    .as_ref()
                    .is_some_and(|m| m.instance_id == sel.instance_id && m.model == sel.model);
                let row_id = SharedString::from(format!(
                    "model-opt-{}-{}",
                    choice.instance_id, choice.model_slug
                ));
                let label = format!("{} · {}", choice.provider_label, choice.model_label);
                menu = menu.child(
                    div()
                        .id(row_id)
                        .px(px(8.0))
                        .py(px(5.0))
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .bg(if is_selected {
                            palette.row_selected
                        } else {
                            gpui_kit::transparent_black()
                        })
                        .hover(|s| s.bg(palette.row_hover))
                        .text_xs()
                        .text_color(palette.foreground)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.pick_model(sel.clone(), cx);
                        }))
                        .child(SharedString::from(label)),
                );
            }
        }
        wrapper = wrapper.child(menu);
    }

    let mut action_row = div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .pt(px(6.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(
                    div()
                        .id("composer-model-btn")
                        .px(px(8.0))
                        .py(px(4.0))
                        .rounded(px(6.0))
                        .bg(palette.background)
                        .border_1()
                        .border_color(palette.border)
                        .cursor_pointer()
                        .hover(|s| s.bg(palette.row_hover))
                        .text_xs()
                        .text_color(palette.foreground)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.toggle_model_picker(cx);
                        }))
                        .child(SharedString::from(format!("{model_text} ▾"))),
                )
                .child(
                    div()
                        .id("composer-runtime-mode-btn")
                        .px(px(8.0))
                        .py(px(4.0))
                        .rounded(px(6.0))
                        .bg(palette.background)
                        .border_1()
                        .border_color(palette.border)
                        .cursor_pointer()
                        .hover(|s| s.bg(palette.row_hover))
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.cycle_runtime_mode(current_runtime_mode, cx);
                        }))
                        .child(SharedString::from(runtime_mode_label(
                            current_runtime_mode,
                            app.i18n(),
                        ))),
                ),
        );

    let mut right_btns = div().flex().items_center().gap(px(6.0));
    if is_running {
        right_btns = right_btns.child(
            div()
                .id("composer-stop-btn")
                .px(px(12.0))
                .py(px(5.0))
                .rounded(px(6.0))
                .bg(palette.error_surface)
                .border_1()
                .border_color(palette.error)
                .cursor_pointer()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(palette.error)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.stop_active_thread(cx);
                }))
                .child(SharedString::from(app.i18n().get(Key::Stop).to_owned())),
        );
    }

    right_btns = right_btns.child(
        div()
            .id("composer-send-btn")
            .px(px(14.0))
            .py(px(5.0))
            .rounded(px(6.0))
            .bg(palette.primary)
            .cursor_pointer()
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(palette.primary_foreground)
            .on_click(cx.listener(|this, _, window, cx| {
                this.submit_composer(window, cx);
            }))
            .child(SharedString::from(app.i18n().get(Key::Send).to_owned())),
    );

    action_row = action_row.child(right_btns);

    let box_card = div()
        .w_full()
        .p(px(10.0))
        .rounded(px(10.0))
        .bg(palette.card)
        .border_1()
        .border_color(palette.border)
        .flex()
        .flex_col()
        .child(Textarea::new(app.composer_input()).bordered(false))
        .child(action_row);

    wrapper.child(box_card)
}
