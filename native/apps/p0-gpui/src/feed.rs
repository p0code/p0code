//! Thread feed: a measured virtual list (`MessageScroller`) that follows the tail unless the
//! user scrolled up. Rows are re-measured only when their signature changes (content, status,
//! expansion), so streaming one message never re-lays out the others.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash as _, Hasher as _};
use std::ops::Range;

use gpui_kit::component::message_scroller::MessageScrollerState;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FontStyle, FontWeight, HighlightStyle,
    InteractiveElement as _, InteractiveText, IntoElement, ObjectFit, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, StrikethroughStyle, Styled as _,
    StyledImage as _, StyledText, UnderlineStyle, Window, div, img, px,
};
use p0_i18n::Key;
use p0_protocol::{AttachmentType, ChatAttachment, ProjectedTurnItem, TurnItem, TurnItemStatus};

use crate::app::P0App;
use crate::attachments::{FeedImageState, file_badge, human_size};
use crate::markdown::{Inline, ListMarker, MdBlock};
use crate::theme::AppPalette;

pub struct FeedState {
    pub state: Entity<MessageScrollerState>,
    rows: Vec<(String, u64)>,
    thread_id: Option<String>,
}

impl FeedState {
    pub fn new(cx: &mut Context<P0App>) -> Self {
        Self {
            state: cx.new(|cx| MessageScrollerState::new(0, cx)),
            rows: Vec::new(),
            thread_id: None,
        }
    }

    pub fn follow_tail(&self, cx: &mut App) {
        self.state.update(cx, |s, cx| s.scroll_to_end(cx));
    }
}

/// What changed between two lists of `(row id, signature)`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FeedPlan {
    /// Rows from the first differing id on are replaced by this many new rows.
    pub splice: Option<(Range<usize>, usize)>,
    /// Surviving rows whose signature changed.
    pub remeasure: Vec<usize>,
}

pub fn plan_feed_update(old: &[(String, u64)], new: &[(String, u64)]) -> FeedPlan {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a.0 == b.0).count();
    FeedPlan {
        splice: (prefix < old.len() || prefix < new.len())
            .then(|| (prefix..old.len(), new.len() - prefix)),
        remeasure: (0..prefix).filter(|&i| old[i].1 != new[i].1).collect(),
    }
}

/// Everything a row's height depends on.
pub fn row_signature(row: &ProjectedTurnItem, expanded: bool, extra: u64) -> u64 {
    let mut h = DefaultHasher::new();
    row.item.updated_at().hash(&mut h);
    expanded.hash(&mut h);
    extra.hash(&mut h);
    match &row.item {
        TurnItem::UserMessage {
            text, attachments, ..
        } => {
            text.hash(&mut h);
            attachments.len().hash(&mut h);
            for att in attachments {
                att.id.hash(&mut h);
                att.kind.hash(&mut h);
                att.name.hash(&mut h);
                att.size_bytes.hash(&mut h);
            }
        }
        TurnItem::AssistantMessage { text, .. } | TurnItem::Reasoning { text, .. } => {
            text.hash(&mut h)
        }
        TurnItem::ProposedPlan { markdown, .. } => markdown.hash(&mut h),
        TurnItem::CommandExecution { output, status, .. } => {
            output.as_ref().map(String::len).hash(&mut h);
            std::mem::discriminant(status).hash(&mut h);
        }
        TurnItem::SecretRequest { secret_status, .. } => {
            std::mem::discriminant(secret_status).hash(&mut h)
        }
        _ => {}
    }
    h.finish()
}

impl P0App {
    /// Brings the scroller in line with the open thread.
    pub(crate) fn sync_feed(&mut self, cx: &mut Context<Self>) {
        let rows: Vec<(String, u64)> = self
            .thread
            .projection
            .as_ref()
            .map(|p| {
                p.visible_turn_items
                    .iter()
                    .map(|row| {
                        let expanded = self.expanded_items.contains(&row.source_item_id);
                        let mut extra = self.cards.signature(&row.item, &self.thread);
                        if let TurnItem::UserMessage { attachments, .. } = &row.item
                            && !attachments.is_empty()
                        {
                            extra ^= self.attachment_images.signature_for(attachments);
                        }
                        (
                            row.source_item_id.clone(),
                            row_signature(row, expanded, extra),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();

        if self.feed.thread_id != self.thread.thread_id {
            self.feed.thread_id.clone_from(&self.thread.thread_id);
            self.md_cache.clear();
            let count = rows.len();
            self.feed.rows = rows;
            self.feed.state.update(cx, |s, cx| s.reset(count, cx));
            return;
        }
        let plan = plan_feed_update(&self.feed.rows, &rows);
        self.feed.rows = rows;
        if plan == FeedPlan::default() {
            return;
        }
        self.feed.state.update(cx, |s, cx| {
            for ix in &plan.remeasure {
                s.remeasure_items(*ix..*ix + 1, cx);
            }
            if let Some((range, count)) = plan.splice {
                s.splice(range, count, cx);
            }
        });
    }

    pub fn toggle_item_expanded(&mut self, item_id: String, cx: &mut Context<Self>) {
        if !self.expanded_items.remove(&item_id) {
            self.expanded_items.insert(item_id);
        }
        self.sync_feed(cx);
        cx.notify();
    }

    pub(crate) fn render_feed_row(
        &mut self,
        ix: usize,
        palette: AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(row) = self
            .thread
            .projection
            .as_ref()
            .and_then(|p| p.visible_turn_items.get(ix))
            .cloned()
        else {
            return div().into_any_element();
        };
        let inner = self.render_turn_item(&row, &palette, window, cx);
        div()
            .w_full()
            .max_w(px(760.0))
            .mx_auto()
            .px(px(16.0))
            .py(px(4.0))
            .child(inner)
            .into_any_element()
    }

    fn render_turn_item(
        &mut self,
        row: &ProjectedTurnItem,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let item_id = row.source_item_id.clone();
        let expanded = self.expanded_items.contains(&item_id);
        let i18n = self.i18n.clone();
        match &row.item {
            TurnItem::UserMessage {
                text, attachments, ..
            } => {
                let mut stack = div()
                    .max_w(px(620.0))
                    .flex()
                    .flex_col()
                    .items_end()
                    .gap(px(6.0));
                if !attachments.is_empty() {
                    stack = stack.child(self.render_user_attachments(
                        &item_id,
                        attachments,
                        palette,
                        cx,
                    ));
                }
                if !text.trim().is_empty() || attachments.is_empty() {
                    let blocks = self.md_cache.get_or_parse(&item_id, text);
                    stack = stack.child(
                        div()
                            .max_w(px(620.0))
                            .px(px(14.0))
                            .py(px(10.0))
                            .rounded(px(10.0))
                            .bg(palette.message_user)
                            .border_1()
                            .border_color(palette.border)
                            .child(render_markdown(&item_id, &blocks, palette)),
                    );
                }
                div()
                    .w_full()
                    .flex()
                    .justify_end()
                    .child(stack)
                    .into_any_element()
            }
            TurnItem::AssistantMessage {
                text, streaming, ..
            } => {
                let blocks = self.md_cache.get_or_parse(&item_id, text);
                let mut body = div()
                    .w_full()
                    .px(px(4.0))
                    .py(px(6.0))
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(render_markdown(&item_id, &blocks, palette));
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
                    i18n.get(Key::Thinking)
                } else {
                    i18n.get(Key::Reasoning)
                };
                self.collapsible(
                    &item_id,
                    label,
                    &first_line(text, 72),
                    expanded,
                    Some(text.clone()),
                    false,
                    palette,
                    cx,
                )
            }
            TurnItem::ProposedPlan { markdown, .. } => {
                let blocks = self.md_cache.get_or_parse(&item_id, markdown);
                card(palette)
                    .child(caption(i18n.get(Key::Plan), palette.primary))
                    .child(render_markdown(&item_id, &blocks, palette))
                    .into_any_element()
            }
            TurnItem::TodoList {
                steps, explanation, ..
            } => {
                let mut c = card(palette).child(caption(i18n.get(Key::Plan), palette.primary));
                if let Some(exp) = explanation {
                    c = c.child(
                        div()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(exp.clone())),
                    );
                }
                for step in steps {
                    let marker = match step.status.as_str() {
                        "completed" => "☑",
                        "running" => "◐",
                        _ => "☐",
                    };
                    c = c.child(
                        div()
                            .flex()
                            .gap(px(6.0))
                            .text_sm()
                            .child(div().text_color(palette.muted_foreground).child(marker))
                            .child(SharedString::from(step.text.clone())),
                    );
                }
                c.into_any_element()
            }
            TurnItem::CommandExecution {
                input,
                output,
                exit_code,
                status,
                ..
            } => {
                let tag = match (status, exit_code) {
                    (TurnItemStatus::Running, _) => i18n.get(Key::Running).to_owned(),
                    (_, Some(0)) => i18n.get(Key::Done).to_owned(),
                    (_, Some(code)) => format!("exit {code}"),
                    _ => String::new(),
                };
                let mut detail = format!("$ {input}");
                if let Some(out) = output.as_deref().filter(|o| !o.is_empty()) {
                    detail.push_str("\n\n");
                    detail.push_str(&truncate_chars(out, 4000));
                }
                let title = if tag.is_empty() {
                    i18n.get(Key::Command).to_owned()
                } else {
                    format!("{} · {tag}", i18n.get(Key::Command))
                };
                self.collapsible(
                    &item_id,
                    &title,
                    &format!("$ {}", first_line(input, 68)),
                    expanded,
                    Some(detail),
                    true,
                    palette,
                    cx,
                )
            }
            TurnItem::FileChange {
                file_name,
                additions,
                deletions,
                diff_str,
                ..
            } => {
                let stats = match (additions, deletions) {
                    (Some(a), Some(d)) => format!(" +{a} -{d}"),
                    _ => String::new(),
                };
                self.collapsible(
                    &item_id,
                    i18n.get(Key::Tools),
                    &format!("{file_name}{stats}"),
                    expanded,
                    diff_str.as_deref().map(|d| truncate_chars(d, 4000)),
                    true,
                    palette,
                    cx,
                )
            }
            TurnItem::FileSearch { pattern, .. } => {
                let p = pattern.clone().unwrap_or_default();
                self.collapsible(
                    &item_id,
                    i18n.get(Key::Tools),
                    &p,
                    expanded,
                    pattern.clone(),
                    true,
                    palette,
                    cx,
                )
            }
            TurnItem::WebSearch { patterns, .. } => {
                let p = patterns.as_ref().map(|p| p.join(", ")).unwrap_or_default();
                self.collapsible(
                    &item_id,
                    i18n.get(Key::Tools),
                    &first_line(&p, 68),
                    expanded,
                    Some(p.clone()),
                    false,
                    palette,
                    cx,
                )
            }
            TurnItem::DynamicTool {
                tool_name,
                input,
                output,
                ..
            } => {
                let detail = format!(
                    "{}\n\n{}",
                    truncate_chars(&input.to_string(), 1200),
                    output
                        .as_ref()
                        .map(|o| truncate_chars(&o.to_string(), 2000))
                        .unwrap_or_default()
                );
                let name = tool_name.clone().unwrap_or_default();
                self.collapsible(
                    &item_id,
                    i18n.get(Key::Tools),
                    &name,
                    expanded,
                    Some(detail),
                    true,
                    palette,
                    cx,
                )
            }
            TurnItem::Subagent {
                subagent_id,
                prompt,
                result,
                ..
            } => {
                let detail = match result {
                    Some(r) => format!("{prompt}\n\n{}", truncate_chars(r, 2000)),
                    None => prompt.clone(),
                };
                self.collapsible(
                    &item_id,
                    subagent_id,
                    &first_line(prompt, 64),
                    expanded,
                    Some(detail),
                    false,
                    palette,
                    cx,
                )
            }
            TurnItem::ApprovalRequest { .. }
            | TurnItem::UserInputRequest { .. }
            | TurnItem::SecretRequest { .. } => self.render_card(row, palette, window, cx),
            TurnItem::SystemNotice { message, .. } => div()
                .w_full()
                .px(px(12.0))
                .py(px(8.0))
                .rounded(px(8.0))
                .bg(palette.warning_surface)
                .text_xs()
                .child(SharedString::from(message.clone()))
                .into_any_element(),
            TurnItem::Notification {
                summary, detail, ..
            } => {
                let mut text = summary.clone();
                if let Some(d) = detail.as_deref().filter(|d| !d.is_empty()) {
                    text.push_str(" — ");
                    text.push_str(&first_line(d, 120));
                }
                div()
                    .w_full()
                    .px(px(12.0))
                    .py(px(6.0))
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
                .child(SharedString::from(failure.message.clone()))
                .into_any_element(),
            TurnItem::Unknown => div().into_any_element(),
        }
    }

    fn render_user_attachments(
        &mut self,
        item_id: &str,
        attachments: &[ChatAttachment],
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut images = Vec::new();
        let mut files = Vec::new();
        for att in attachments {
            if att.kind == AttachmentType::Image {
                images.push(att);
            } else {
                files.push(att);
            }
        }
        let mut col = div().flex().flex_col().items_end().gap(px(6.0));
        if !images.is_empty() {
            let mut img_row = div().flex().flex_wrap().justify_end().gap(px(6.0));
            for (ix, att) in images.iter().enumerate() {
                let state = self.feed_image_for(att, cx);
                let caption_text = format!("{} · {}", att.name, human_size(att.size_bytes));
                let mut tile = div()
                    .id(SharedString::from(format!("feed-img-{item_id}-{ix}")))
                    .p(px(4.0))
                    .rounded(px(8.0))
                    .bg(palette.card)
                    .border_1()
                    .border_color(palette.border)
                    .flex()
                    .flex_col()
                    .gap(px(4.0));
                match state {
                    FeedImageState::Ready(image) => {
                        tile = tile.child(
                            img(image)
                                .w(px(180.0))
                                .h(px(120.0))
                                .object_fit(ObjectFit::Contain)
                                .rounded(px(6.0)),
                        );
                    }
                    FeedImageState::Loading | FeedImageState::Failed => {
                        let badge = file_badge(&att.name, &att.mime_type);
                        let sub = if matches!(state, FeedImageState::Loading) {
                            self.i18n.get(Key::Loading).to_owned()
                        } else {
                            human_size(att.size_bytes)
                        };
                        tile = tile.child(
                            div()
                                .w(px(180.0))
                                .h(px(72.0))
                                .rounded(px(6.0))
                                .bg(palette.code_bg)
                                .flex()
                                .flex_col()
                                .items_center()
                                .justify_center()
                                .gap(px(2.0))
                                .child(
                                    div()
                                        .text_xs()
                                        .font_family("monospace")
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(palette.foreground)
                                        .child(SharedString::from(badge)),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(palette.muted_foreground)
                                        .child(SharedString::from(sub)),
                                ),
                        );
                    }
                }
                tile = tile.child(
                    div()
                        .max_w(px(180.0))
                        .px(px(2.0))
                        .truncate()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(caption_text)),
                );
                img_row = img_row.child(tile);
            }
            col = col.child(img_row);
        }
        if !files.is_empty() {
            let mut file_row = div().flex().flex_wrap().justify_end().gap(px(6.0));
            for (ix, att) in files.iter().enumerate() {
                let badge = file_badge(&att.name, &att.mime_type);
                let mut chip = div()
                    .id(SharedString::from(format!("feed-file-{item_id}-{ix}")))
                    .max_w(px(300.0))
                    .px(px(8.0))
                    .py(px(5.0))
                    .rounded(px(8.0))
                    .bg(palette.card)
                    .border_1()
                    .border_color(palette.border)
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex_none()
                            .px(px(5.0))
                            .py(px(1.0))
                            .rounded(px(4.0))
                            .bg(palette.code_bg)
                            .font_family("monospace")
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(badge)),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.foreground)
                            .child(SharedString::from(att.name.clone())),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(human_size(att.size_bytes))),
                    );
                if crate::preview::policy::is_pdf(&att.name, &att.mime_type) {
                    let source = crate::preview::DocSource::Attachment((*att).clone());
                    chip = chip
                        .cursor_pointer()
                        .hover(|s| s.bg(palette.row_hover))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_document(source.clone(), cx)
                        }));
                }
                file_row = file_row.child(chip);
            }
            col = col.child(file_row);
        }
        col
    }

    #[allow(clippy::too_many_arguments)]
    fn collapsible(
        &self,
        item_id: &str,
        badge: &str,
        preview: &str,
        expanded: bool,
        detail: Option<String>,
        monospace: bool,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let owned_id = item_id.to_owned();
        let mut el = div()
            .w_full()
            .rounded(px(8.0))
            .bg(palette.card)
            .border_1()
            .border_color(palette.border)
            .flex()
            .flex_col()
            .child(
                div()
                    .id(SharedString::from(format!("item-toggle-{item_id}")))
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
                            .child(if expanded { "▾" } else { "▸" }),
                    )
                    .child(
                        div()
                            .flex_none()
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
                            .truncate()
                            .child(SharedString::from(preview.to_owned())),
                    ),
            );
        if expanded && let Some(text) = detail {
            let mut body = div()
                .px(px(12.0))
                .py(px(8.0))
                .border_t_1()
                .border_color(palette.border)
                .text_xs();
            if monospace {
                body = body.bg(palette.code_bg).font_family("monospace");
            }
            el = el.child(body.child(SharedString::from(text)));
        }
        el.into_any_element()
    }
}

/// One option of a choice group; the chosen one is filled.
pub fn choice(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    selected: bool,
    palette: &AppPalette,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let chip = div()
        .id(gpui_kit::ElementId::Name(id.into()))
        .px(px(10.0))
        .py(px(4.0))
        .rounded(px(6.0))
        .border_1()
        .text_sm()
        .cursor_pointer()
        .child(label.into());
    if selected {
        chip.bg(palette.primary)
            .border_color(palette.primary)
            .text_color(palette.primary_foreground)
    } else {
        chip.border_color(palette.border)
            .hover(|s| s.bg(palette.row_hover))
    }
}

pub fn card(palette: &AppPalette) -> gpui_kit::Div {
    div()
        .w_full()
        .p(px(12.0))
        .rounded(px(10.0))
        .bg(palette.card)
        .border_1()
        .border_color(palette.border)
        .flex()
        .flex_col()
        .gap(px(6.0))
}

pub fn caption(text: &str, color: gpui_kit::Hsla) -> gpui_kit::Div {
    div()
        .text_xs()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(color)
        .child(SharedString::from(text.to_owned()))
}

fn inline_text(id: SharedString, inline: &Inline, palette: &AppPalette) -> AnyElement {
    let highlights: Vec<(Range<usize>, HighlightStyle)> = inline
        .runs
        .iter()
        .map(|run| {
            let mut style = HighlightStyle::default();
            if run.style.strong {
                style.font_weight = Some(FontWeight::BOLD);
            }
            if run.style.emphasis {
                style.font_style = Some(FontStyle::Italic);
            }
            if run.style.strike {
                style.strikethrough = Some(StrikethroughStyle {
                    thickness: px(1.0),
                    ..Default::default()
                });
            }
            if run.style.code {
                style.background_color = Some(palette.code_bg);
            }
            if run.link.is_some() {
                style.color = Some(palette.primary);
                style.underline = Some(UnderlineStyle {
                    thickness: px(1.0),
                    ..Default::default()
                });
            }
            (run.range.clone(), style)
        })
        .collect();
    let text = StyledText::new(SharedString::from(inline.text.clone())).with_highlights(highlights);
    let links: Vec<(Range<usize>, String)> = inline
        .runs
        .iter()
        .filter_map(|r| Some((r.range.clone(), r.link.clone()?)))
        .collect();
    if links.is_empty() {
        return text.into_any_element();
    }
    let ranges = links.iter().map(|(r, _)| r.clone()).collect();
    InteractiveText::new(id, text)
        .on_click(ranges, move |ix, _, cx| {
            if let Some((_, url)) = links.get(ix) {
                crate::preview::open_link(url, cx);
            }
        })
        .into_any_element()
}

pub fn render_markdown(item_id: &str, blocks: &[MdBlock], palette: &AppPalette) -> AnyElement {
    let mut container = div().flex().flex_col().gap(px(6.0)).w_full().text_sm();
    for (ix, block) in blocks.iter().enumerate() {
        let id = SharedString::from(format!("md-{item_id}-{ix}"));
        container = container.child(match block {
            MdBlock::Heading { level, inline } => {
                let h = div().font_weight(FontWeight::BOLD);
                match level {
                    1 => h.text_lg(),
                    2 => h.text_base(),
                    _ => h,
                }
                .child(inline_text(id, inline, palette))
                .into_any_element()
            }
            MdBlock::Paragraph(inline) => div()
                .child(inline_text(id, inline, palette))
                .into_any_element(),
            MdBlock::ListItem {
                depth,
                marker,
                inline,
            } => {
                let bullet = match marker {
                    ListMarker::Bullet => "•".to_owned(),
                    ListMarker::Number(n) => format!("{n}."),
                    ListMarker::Continuation => String::new(),
                };
                div()
                    .flex()
                    .items_start()
                    .gap(px(6.0))
                    .pl(px(8.0 + 16.0 * *depth as f32))
                    .child(
                        div()
                            .flex_none()
                            .min_w(px(14.0))
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(bullet)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(inline_text(id, inline, palette)),
                    )
                    .into_any_element()
            }
            MdBlock::Quote(inline) => div()
                .pl(px(10.0))
                .border_l_2()
                .border_color(palette.border)
                .text_color(palette.muted_foreground)
                .child(inline_text(id, inline, palette))
                .into_any_element(),
            MdBlock::Code { language, code } => {
                let mut c = div()
                    .w_full()
                    .rounded(px(6.0))
                    .bg(palette.code_bg)
                    .border_1()
                    .border_color(palette.border)
                    .flex()
                    .flex_col();
                if let Some(lang) = language {
                    c = c.child(
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
                c.child(
                    div()
                        .px(px(10.0))
                        .py(px(8.0))
                        .font_family("monospace")
                        .text_xs()
                        .child(SharedString::from(code.clone())),
                )
                .into_any_element()
            }
            MdBlock::Rule => div()
                .w_full()
                .h(px(1.0))
                .bg(palette.border)
                .into_any_element(),
        });
    }
    container.into_any_element()
}

fn first_line(text: &str, max_chars: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    truncate_chars(line, max_chars)
}

pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(spec: &[(&str, u64)]) -> Vec<(String, u64)> {
        spec.iter()
            .map(|(id, sig)| ((*id).to_owned(), *sig))
            .collect()
    }

    #[test]
    fn streaming_tail_only_remeasures_that_row() {
        let plan = plan_feed_update(&rows(&[("a", 1), ("b", 1)]), &rows(&[("a", 1), ("b", 2)]));
        assert_eq!(
            plan,
            FeedPlan {
                splice: None,
                remeasure: vec![1]
            }
        );
    }

    #[test]
    fn appended_rows_splice_at_the_end() {
        let plan = plan_feed_update(&rows(&[("a", 1)]), &rows(&[("a", 1), ("b", 1), ("c", 1)]));
        assert_eq!(
            plan,
            FeedPlan {
                splice: Some((1..1, 2)),
                remeasure: vec![]
            }
        );
    }

    #[test]
    fn inserted_or_removed_rows_splice_from_first_difference() {
        let plan = plan_feed_update(
            &rows(&[("a", 1), ("c", 1), ("d", 1)]),
            &rows(&[("a", 2), ("b", 1), ("c", 1), ("d", 1)]),
        );
        assert_eq!(
            plan,
            FeedPlan {
                splice: Some((1..3, 3)),
                remeasure: vec![0]
            }
        );
        let removed = plan_feed_update(&rows(&[("a", 1), ("b", 1)]), &rows(&[("a", 1)]));
        assert_eq!(removed.splice, Some((1..2, 0)));
        assert_eq!(
            plan_feed_update(&rows(&[("a", 1)]), &rows(&[("a", 1)])),
            FeedPlan::default()
        );
    }

    #[test]
    fn user_message_signature_tracks_attachments() {
        let make = |attachments: Vec<ChatAttachment>| ProjectedTurnItem {
            position: 0,
            visibility: "visible".into(),
            source_thread_id: "t1".into(),
            source_item_id: "u1".into(),
            item: TurnItem::UserMessage {
                id: "u1".into(),
                thread_id: "t1".into(),
                run_id: None,
                ordinal: 1,
                status: TurnItemStatus::Completed,
                title: None,
                updated_at: "2026-01-01T00:00:00Z".into(),
                message_id: "m1".into(),
                text: "see attached".into(),
                attachments,
            },
        };
        let plain = make(vec![]);
        let with_att = make(vec![ChatAttachment {
            kind: AttachmentType::Image,
            id: "att-1".into(),
            name: "shot.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 1024,
        }]);
        assert_ne!(
            row_signature(&plain, false, 0),
            row_signature(&with_att, false, 0)
        );
        assert_ne!(
            row_signature(&with_att, false, 1),
            row_signature(&with_att, false, 2)
        );
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate_chars("日本語テキスト", 3), "日本語…");
        assert_eq!(truncate_chars("short", 10), "short");
    }
}
