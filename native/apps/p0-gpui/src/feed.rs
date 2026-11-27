//! Virtualized thread feed rendering (messages, Markdown blocks, collapsible reasoning &
//! tool rows, plans, errors, and inline approval cards).

use std::collections::HashSet;

use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};
use p0_i18n::{Catalog, Key};
use p0_protocol::{ApprovalDecision, ProjectedTurnItem, RuntimeRequest, TurnItem, TurnItemStatus};

use crate::app::P0App;
use crate::markdown::{InlineSpan, MarkdownCache, MdBlock, estimate_markdown_height};
use crate::theme::AppPalette;

/// Estimates row height in CSS pixels for `v_virtual_list`.
pub fn estimate_turn_item_height(
    row: &ProjectedTurnItem,
    expanded: bool,
    md_cache: &mut MarkdownCache,
    has_pending_approval: bool,
) -> Pixels {
    let h = match &row.item {
        TurnItem::UserMessage {
            id,
            updated_at,
            text,
            ..
        } => {
            let blocks = md_cache.get_or_parse(id, updated_at, text);
            estimate_markdown_height(&blocks, 76) + 46.0
        }
        TurnItem::AssistantMessage {
            id,
            updated_at,
            text,
            ..
        } => {
            let blocks = md_cache.get_or_parse(id, updated_at, text);
            estimate_markdown_height(&blocks, 84) + 38.0
        }
        TurnItem::Reasoning { text, .. } => {
            if expanded {
                let lines = text.lines().count().clamp(1, 24);
                44.0 + (lines as f32) * 18.0
            } else {
                40.0
            }
        }
        TurnItem::ProposedPlan {
            id,
            updated_at,
            markdown,
            ..
        } => {
            let blocks = md_cache.get_or_parse(id, updated_at, markdown);
            estimate_markdown_height(&blocks, 80) + 52.0
        }
        TurnItem::TodoList { steps, .. } => 48.0 + (steps.len().min(20) as f32) * 22.0,
        TurnItem::CommandExecution { input, output, .. } => {
            if expanded {
                let in_lines = input.lines().count().clamp(1, 6);
                let out_lines = output
                    .as_deref()
                    .map(|o| o.lines().count().min(18))
                    .unwrap_or(0);
                54.0 + ((in_lines + out_lines) as f32) * 17.0
            } else {
                40.0
            }
        }
        TurnItem::FileChange { diff_str, .. } => {
            if expanded {
                let lines = diff_str
                    .as_deref()
                    .map(|d| d.lines().count().min(20))
                    .unwrap_or(1);
                50.0 + (lines as f32) * 17.0
            } else {
                40.0
            }
        }
        TurnItem::FileSearch { .. }
        | TurnItem::WebSearch { .. }
        | TurnItem::DynamicTool { .. }
        | TurnItem::Subagent { .. } => {
            if expanded {
                120.0
            } else {
                40.0
            }
        }
        TurnItem::ApprovalRequest { .. } => {
            if has_pending_approval {
                128.0
            } else {
                72.0
            }
        }
        TurnItem::SystemNotice { message, .. }
        | TurnItem::Notification {
            summary: message, ..
        } => {
            let lines = (message.len() / 80) + 1;
            36.0 + (lines as f32) * 18.0
        }
        TurnItem::Error { failure, .. } => {
            let lines = (failure.message.len() / 80) + 1;
            44.0 + (lines as f32) * 18.0
        }
        TurnItem::Unknown => 34.0,
    };
    px(h)
}

#[allow(clippy::too_many_arguments)]
pub fn render_turn_item(
    row: &ProjectedTurnItem,
    expanded_items: &HashSet<String>,
    pending_requests: &[&RuntimeRequest],
    md_cache: &mut MarkdownCache,
    i18n: &Catalog,
    palette: &AppPalette,
    thread_id: &str,
    cx: &mut Context<P0App>,
) -> AnyElement {
    let item_id = row.source_item_id.clone();
    let expanded = expanded_items.contains(&item_id);

    let inner: AnyElement = match &row.item {
        TurnItem::UserMessage {
            id,
            updated_at,
            text,
            ..
        } => {
            let blocks = md_cache.get_or_parse(id, updated_at, text);
            div()
                .w_full()
                .flex()
                .justify_end()
                .child(
                    div()
                        .max_w(px(620.0))
                        .px(px(14.0))
                        .py(px(10.0))
                        .rounded(px(10.0))
                        .bg(palette.message_user)
                        .border_1()
                        .border_color(palette.border)
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(palette.muted_foreground)
                                .child(SharedString::from(i18n.get(Key::You).to_owned())),
                        )
                        .child(render_markdown_blocks(&blocks, palette)),
                )
                .into_any_element()
        }
        TurnItem::AssistantMessage {
            id,
            updated_at,
            text,
            streaming,
            ..
        } => {
            let blocks = md_cache.get_or_parse(id, updated_at, text);
            let mut body = div()
                .w_full()
                .px(px(4.0))
                .py(px(6.0))
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(render_markdown_blocks(&blocks, palette));
            if *streaming {
                body = body.child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(i18n.get(Key::Working).to_owned())),
                );
            }
            body.into_any_element()
        }
        TurnItem::Reasoning {
            text,
            streaming,
            status,
            ..
        } => {
            let label = if *streaming || matches!(status, TurnItemStatus::Running) {
                i18n.get(Key::Thinking).to_owned()
            } else {
                i18n.get(Key::Reasoning).to_owned()
            };
            let preview = first_line_preview(text, 72);
            render_collapsible_row(
                &item_id,
                &label,
                &preview,
                expanded,
                Some(text.clone()),
                false,
                palette,
                cx,
            )
            .into_any_element()
        }
        TurnItem::ProposedPlan {
            id,
            updated_at,
            markdown,
            ..
        } => {
            let blocks = md_cache.get_or_parse(id, updated_at, markdown);
            div()
                .w_full()
                .p(px(12.0))
                .rounded(px(8.0))
                .bg(palette.card)
                .border_1()
                .border_color(palette.border)
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(palette.primary)
                        .child(SharedString::from(i18n.get(Key::Plan).to_owned())),
                )
                .child(render_markdown_blocks(&blocks, palette))
                .into_any_element()
        }
        TurnItem::TodoList {
            steps, explanation, ..
        } => {
            let mut card = div()
                .w_full()
                .p(px(12.0))
                .rounded(px(8.0))
                .bg(palette.card)
                .border_1()
                .border_color(palette.border)
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(palette.primary)
                        .child(SharedString::from(i18n.get(Key::Plan).to_owned())),
                );
            if let Some(exp) = explanation {
                card = card.child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(exp.clone())),
                );
            }
            for step in steps {
                let marker = match step.status.as_str() {
                    "completed" => "[x]",
                    "running" => "[~]",
                    _ => "[ ]",
                };
                card = card.child(
                    div()
                        .flex()
                        .gap(px(6.0))
                        .text_sm()
                        .text_color(palette.foreground)
                        .child(
                            div()
                                .text_color(palette.muted_foreground)
                                .child(SharedString::from(marker.to_owned())),
                        )
                        .child(SharedString::from(step.text.clone())),
                );
            }
            card.into_any_element()
        }
        TurnItem::CommandExecution {
            input,
            output,
            exit_code,
            status,
            ..
        } => {
            let status_tag = match (status, exit_code) {
                (TurnItemStatus::Running, _) => i18n.get(Key::Running).to_owned(),
                (_, Some(0)) => i18n.get(Key::Done).to_owned(),
                (_, Some(code)) => format!("exit {code}"),
                _ => format!("{status:?}"),
            };
            let title = format!("{} · {status_tag}", i18n.get(Key::Command));
            let preview = format!("$ {}", first_line_preview(input, 68));
            let mut detail = format!("$ {input}");
            if let Some(out) = output
                && !out.is_empty()
            {
                detail.push_str("\n\n");
                detail.push_str(&truncate_chars(out, 2000));
            }
            render_collapsible_row(
                &item_id,
                &title,
                &preview,
                expanded,
                Some(detail),
                true,
                palette,
                cx,
            )
            .into_any_element()
        }
        TurnItem::FileChange {
            file_name,
            additions,
            deletions,
            diff_str,
            ..
        } => {
            let stats = match (additions, deletions) {
                (Some(a), Some(d)) => format!("+{a} -{d}"),
                _ => String::new(),
            };
            let preview = format!("{file_name} {stats}");
            render_collapsible_row(
                &item_id,
                i18n.get(Key::Tools),
                &preview,
                expanded,
                diff_str.as_deref().map(|d| truncate_chars(d, 2000)),
                true,
                palette,
                cx,
            )
            .into_any_element()
        }
        TurnItem::FileSearch { pattern, .. } => {
            let preview = pattern.as_deref().unwrap_or("search");
            render_collapsible_row(
                &item_id,
                i18n.get(Key::Tools),
                &format!("search: {preview}"),
                expanded,
                pattern.clone(),
                true,
                palette,
                cx,
            )
            .into_any_element()
        }
        TurnItem::WebSearch { patterns, .. } => {
            let preview = patterns
                .as_ref()
                .map(|p| p.join(", "))
                .unwrap_or_else(|| "web search".to_owned());
            render_collapsible_row(
                &item_id,
                i18n.get(Key::Tools),
                &first_line_preview(&preview, 68),
                expanded,
                Some(preview),
                false,
                palette,
                cx,
            )
            .into_any_element()
        }
        TurnItem::DynamicTool {
            tool_name,
            input,
            output,
            ..
        } => {
            let name = tool_name.as_deref().unwrap_or("tool");
            let detail = format!(
                "input: {}\noutput: {}",
                truncate_chars(&input.to_string(), 800),
                output
                    .as_ref()
                    .map(|o| truncate_chars(&o.to_string(), 1200))
                    .unwrap_or_else(|| "—".to_owned())
            );
            render_collapsible_row(
                &item_id,
                i18n.get(Key::Tools),
                name,
                expanded,
                Some(detail),
                true,
                palette,
                cx,
            )
            .into_any_element()
        }
        TurnItem::Subagent {
            subagent_id,
            prompt,
            result,
            ..
        } => {
            let detail = match result {
                Some(r) => format!("{prompt}\n\n---\n{}", truncate_chars(r, 1500)),
                None => prompt.clone(),
            };
            render_collapsible_row(
                &item_id,
                "Subagent",
                &format!("{subagent_id}: {}", first_line_preview(prompt, 56)),
                expanded,
                Some(detail),
                false,
                palette,
                cx,
            )
            .into_any_element()
        }
        TurnItem::ApprovalRequest {
            request_id,
            title,
            prompt,
            reason,
            ..
        } => {
            let is_pending = pending_requests.iter().any(|r| r.id == *request_id);
            render_approval_card(
                thread_id,
                request_id,
                title.as_deref(),
                prompt.as_deref(),
                reason.as_deref(),
                is_pending,
                i18n,
                palette,
                cx,
            )
            .into_any_element()
        }
        TurnItem::SystemNotice { message, .. } => div()
            .w_full()
            .px(px(12.0))
            .py(px(8.0))
            .rounded(px(8.0))
            .bg(palette.warning_surface)
            .border_1()
            .border_color(palette.border)
            .text_xs()
            .text_color(palette.foreground)
            .child(SharedString::from(format!(
                "{}: {message}",
                i18n.get(Key::System)
            )))
            .into_any_element(),
        TurnItem::Notification {
            summary, detail, ..
        } => {
            let mut text = summary.clone();
            if let Some(d) = detail
                && !d.is_empty()
            {
                text.push_str(" — ");
                text.push_str(&first_line_preview(d, 100));
            }
            div()
                .w_full()
                .px(px(12.0))
                .py(px(6.0))
                .rounded(px(6.0))
                .bg(palette.card)
                .border_1()
                .border_color(palette.border)
                .text_xs()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(text))
                .into_any_element()
        }
        TurnItem::Error { failure, .. } => div()
            .w_full()
            .px(px(12.0))
            .py(px(8.0))
            .rounded(px(8.0))
            .bg(palette.error_surface)
            .border_1()
            .border_color(palette.error)
            .text_sm()
            .text_color(palette.error)
            .child(SharedString::from(format!(
                "{}: {}",
                i18n.get(Key::Error),
                failure.message
            )))
            .into_any_element(),
        TurnItem::Unknown => div()
            .w_full()
            .px(px(10.0))
            .py(px(4.0))
            .text_xs()
            .text_color(palette.muted_foreground)
            .child(SharedString::from(format!("[{}]", row.source_item_id)))
            .into_any_element(),
    };

    div()
        .w_full()
        .max_w(px(760.0))
        .mx_auto()
        .px(px(16.0))
        .py(px(4.0))
        .child(inner)
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn render_collapsible_row(
    item_id: &str,
    badge: &str,
    preview: &str,
    expanded: bool,
    detail: Option<String>,
    monospace: bool,
    palette: &AppPalette,
    cx: &mut Context<P0App>,
) -> impl IntoElement {
    let chevron = if expanded { "▾" } else { "▸" };
    let toggle_id = SharedString::from(format!("item-toggle-{item_id}"));
    let owned_id = item_id.to_owned();

    let mut box_el = div()
        .w_full()
        .rounded(px(8.0))
        .bg(palette.card)
        .border_1()
        .border_color(palette.border)
        .flex()
        .flex_col()
        .child(
            div()
                .id(toggle_id)
                .flex()
                .items_center()
                .gap(px(8.0))
                .px(px(10.0))
                .py(px(7.0))
                .cursor_pointer()
                .hover(|s| s.bg(palette.row_hover))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.toggle_item_expanded(owned_id.clone(), cx);
                }))
                .child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(chevron),
                )
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(badge.to_owned())),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_xs()
                        .text_color(palette.foreground)
                        .truncate()
                        .child(SharedString::from(preview.to_owned())),
                ),
        );

    if expanded
        && let Some(text) = detail
    {
        let mut body = div()
            .px(px(12.0))
            .py(px(8.0))
            .border_t_1()
            .border_color(palette.border)
            .text_xs()
            .text_color(palette.foreground);
        if monospace {
            body = body.bg(palette.code_bg).font_family("monospace");
        }
        box_el = box_el.child(body.child(SharedString::from(text)));
    }

    box_el
}

#[allow(clippy::too_many_arguments)]
pub fn render_approval_card(
    thread_id: &str,
    request_id: &str,
    title: Option<&str>,
    prompt: Option<&str>,
    reason: Option<&str>,
    is_pending: bool,
    i18n: &Catalog,
    palette: &AppPalette,
    cx: &mut Context<P0App>,
) -> impl IntoElement {
    let heading = title.unwrap_or_else(|| i18n.get(Key::ApprovalRequested));
    let mut card = div()
        .w_full()
        .p(px(12.0))
        .rounded(px(10.0))
        .bg(palette.warning_surface)
        .border_1()
        .border_color(if is_pending {
            palette.warning
        } else {
            palette.border
        })
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(palette.foreground)
                        .child(SharedString::from(heading.to_owned())),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(if is_pending {
                            palette.warning
                        } else {
                            palette.muted_foreground
                        })
                        .child(SharedString::from(
                            i18n.get(if is_pending {
                                Key::WaitingForApproval
                            } else {
                                Key::Completed
                            })
                            .to_owned(),
                        )),
                ),
        );

    if let Some(p) = prompt {
        card = card.child(
            div()
                .text_sm()
                .text_color(palette.foreground)
                .child(SharedString::from(p.to_owned())),
        );
    }
    if let Some(r) = reason {
        card = card.child(
            div()
                .text_xs()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(r.to_owned())),
        );
    }

    if is_pending {
        let tid_accept = thread_id.to_owned();
        let req_accept = request_id.to_owned();
        let tid_decline = thread_id.to_owned();
        let req_decline = request_id.to_owned();
        let accept_id = SharedString::from(format!("approve-accept-{request_id}"));
        let decline_id = SharedString::from(format!("approve-decline-{request_id}"));

        card = card.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .pt(px(4.0))
                .child(
                    div()
                        .id(accept_id)
                        .px(px(12.0))
                        .py(px(5.0))
                        .rounded(px(6.0))
                        .bg(palette.primary)
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(palette.primary_foreground)
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.respond_approval(
                                tid_accept.clone(),
                                req_accept.clone(),
                                ApprovalDecision::Accept,
                                cx,
                            );
                        }))
                        .child(SharedString::from(i18n.get(Key::Accept).to_owned())),
                )
                .child(
                    div()
                        .id(decline_id)
                        .px(px(12.0))
                        .py(px(5.0))
                        .rounded(px(6.0))
                        .bg(palette.card)
                        .border_1()
                        .border_color(palette.border)
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(palette.error)
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.respond_approval(
                                tid_decline.clone(),
                                req_decline.clone(),
                                ApprovalDecision::Decline,
                                cx,
                            );
                        }))
                        .child(SharedString::from(i18n.get(Key::Decline).to_owned())),
                ),
        );
    }

    card
}

fn render_markdown_blocks(blocks: &[MdBlock], palette: &AppPalette) -> impl IntoElement {
    let mut container = div().flex().flex_col().gap(px(6.0)).w_full();

    for block in blocks {
        match block {
            MdBlock::Heading { level, spans } => {
                let mut h = div()
                    .font_weight(FontWeight::BOLD)
                    .text_color(palette.foreground);
                h = match level {
                    1 => h.text_lg(),
                    2 => h.text_base(),
                    _ => h.text_sm(),
                };
                container = container.child(h.child(render_inline_spans(spans, palette)));
            }
            MdBlock::Paragraph(spans) => {
                container = container.child(
                    div()
                        .text_sm()
                        .text_color(palette.foreground)
                        .child(render_inline_spans(spans, palette)),
                );
            }
            MdBlock::ListItem {
                ordered_index,
                spans,
            } => {
                let bullet = match ordered_index {
                    Some(n) => format!("{n}."),
                    None => "•".to_owned(),
                };
                container = container.child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(6.0))
                        .pl(px(8.0))
                        .text_sm()
                        .text_color(palette.foreground)
                        .child(
                            div()
                                .text_color(palette.muted_foreground)
                                .child(SharedString::from(bullet)),
                        )
                        .child(div().flex_1().child(render_inline_spans(spans, palette))),
                );
            }
            MdBlock::BlockQuote(spans) => {
                container = container.child(
                    div()
                        .pl(px(10.0))
                        .border_l_2()
                        .border_color(palette.border)
                        .text_sm()
                        .text_color(palette.muted_foreground)
                        .child(render_inline_spans(spans, palette)),
                );
            }
            MdBlock::CodeBlock { language, code } => {
                let mut code_card = div()
                    .w_full()
                    .rounded(px(6.0))
                    .bg(palette.code_bg)
                    .border_1()
                    .border_color(palette.border)
                    .flex()
                    .flex_col();
                if let Some(lang) = language {
                    code_card = code_card.child(
                        div()
                            .px(px(10.0))
                            .py(px(4.0))
                            .border_b_1()
                            .border_color(palette.border)
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(lang.clone())),
                    );
                }
                code_card = code_card.child(
                    div()
                        .px(px(10.0))
                        .py(px(8.0))
                        .font_family("monospace")
                        .text_xs()
                        .text_color(palette.foreground)
                        .child(SharedString::from(code.clone())),
                );
                container = container.child(code_card);
            }
            MdBlock::ThematicBreak => {
                container = container.child(div().w_full().h(px(1.0)).bg(palette.border));
            }
        }
    }

    container
}

fn render_inline_spans(spans: &[InlineSpan], palette: &AppPalette) -> impl IntoElement {
    let mut row = div().flex().flex_wrap().items_baseline().gap_x(px(2.0));
    for span in spans {
        match span {
            InlineSpan::Text(t) => {
                row = row.child(SharedString::from(t.clone()));
            }
            InlineSpan::Strong(t) => {
                row = row.child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .child(SharedString::from(t.clone())),
                );
            }
            InlineSpan::Emphasis(t) => {
                row = row.child(
                    div()
                        .italic()
                        .child(SharedString::from(t.clone())),
                );
            }
            InlineSpan::Code(t) => {
                row = row.child(
                    div()
                        .px(px(4.0))
                        .py(px(1.0))
                        .rounded(px(4.0))
                        .bg(palette.code_bg)
                        .font_family("monospace")
                        .text_xs()
                        .child(SharedString::from(t.clone())),
                );
            }
            InlineSpan::Link { label, url } => {
                let text = if label == url {
                    label.clone()
                } else {
                    format!("{label} ({url})")
                };
                row = row.child(
                    div()
                        .text_color(palette.primary)
                        .underline()
                        .child(SharedString::from(text)),
                );
            }
        }
    }
    row
}

fn first_line_preview(text: &str, max_chars: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    truncate_chars(line, max_chars)
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in text.chars().enumerate() {
        if idx >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}
