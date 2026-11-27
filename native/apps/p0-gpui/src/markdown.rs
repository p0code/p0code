//! Markdown parser (`pulldown-cmark`) and `(item_id, revision)` render cache.

use std::collections::HashMap;
use std::sync::Arc;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InlineSpan {
    Text(String),
    Strong(String),
    Emphasis(String),
    Code(String),
    Link { label: String, url: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MdBlock {
    Heading {
        level: u8,
        spans: Vec<InlineSpan>,
    },
    Paragraph(Vec<InlineSpan>),
    ListItem {
        ordered_index: Option<u64>,
        spans: Vec<InlineSpan>,
    },
    BlockQuote(Vec<InlineSpan>),
    CodeBlock {
        language: Option<String>,
        code: String,
    },
    ThematicBreak,
}

pub fn parse_markdown(input: &str) -> Vec<MdBlock> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(input, opts);
    let mut blocks = Vec::new();
    let mut current_spans: Vec<InlineSpan> = Vec::new();
    let mut in_heading: Option<u8> = None;
    let mut in_blockquote = false;
    let mut list_stack: Vec<Option<u64>> = Vec::new();
    let mut in_list_item: Option<Option<u64>> = None;
    let mut in_code_block: Option<(Option<String>, String)> = None;
    let mut in_strong = false;
    let mut in_emphasis = false;
    let mut in_link: Option<(String, String)> = None;

    let flush_inline = |blocks: &mut Vec<MdBlock>,
                        spans: &mut Vec<InlineSpan>,
                        in_heading: Option<u8>,
                        in_list_item: Option<Option<u64>>,
                        in_blockquote: bool| {
        if spans.is_empty() {
            return;
        }
        let taken = std::mem::take(spans);
        if let Some(level) = in_heading {
            blocks.push(MdBlock::Heading { level, spans: taken });
        } else if let Some(ord) = in_list_item {
            blocks.push(MdBlock::ListItem {
                ordered_index: ord,
                spans: taken,
            });
        } else if in_blockquote {
            blocks.push(MdBlock::BlockQuote(taken));
        } else {
            blocks.push(MdBlock::Paragraph(taken));
        }
    };

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush_inline(&mut blocks, &mut current_spans, None, in_list_item, in_blockquote);
                in_heading = Some(heading_level_num(level));
            }
            Event::End(TagEnd::Heading(_)) => {
                flush_inline(
                    &mut blocks,
                    &mut current_spans,
                    in_heading.take(),
                    None,
                    false,
                );
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                flush_inline(
                    &mut blocks,
                    &mut current_spans,
                    in_heading,
                    in_list_item,
                    in_blockquote,
                );
            }
            Event::Start(Tag::BlockQuote(_)) => {
                in_blockquote = true;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush_inline(&mut blocks, &mut current_spans, None, None, true);
                in_blockquote = false;
            }
            Event::Start(Tag::List(start)) => {
                list_stack.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                list_stack.pop();
            }
            Event::Start(Tag::Item) => {
                let ord = list_stack.last_mut().and_then(|slot| {
                    let current = *slot;
                    if let Some(n) = slot.as_mut() {
                        *n += 1;
                    }
                    current
                });
                in_list_item = Some(ord);
            }
            Event::End(TagEnd::Item) => {
                flush_inline(
                    &mut blocks,
                    &mut current_spans,
                    None,
                    in_list_item.take(),
                    false,
                );
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                flush_inline(&mut blocks, &mut current_spans, None, in_list_item, in_blockquote);
                let lang = match kind {
                    CodeBlockKind::Fenced(l) => {
                        let trimmed = l.trim();
                        (!trimmed.is_empty()).then(|| trimmed.to_owned())
                    }
                    CodeBlockKind::Indented => None,
                };
                in_code_block = Some((lang, String::new()));
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((language, code)) = in_code_block.take() {
                    blocks.push(MdBlock::CodeBlock {
                        language,
                        code: code.trim_end_matches('\n').to_owned(),
                    });
                }
            }
            Event::Start(Tag::Strong) => in_strong = true,
            Event::End(TagEnd::Strong) => in_strong = false,
            Event::Start(Tag::Emphasis) => in_emphasis = true,
            Event::End(TagEnd::Emphasis) => in_emphasis = false,
            Event::Start(Tag::Link { dest_url, .. }) => {
                in_link = Some((dest_url.into_string(), String::new()));
            }
            Event::End(TagEnd::Link) => {
                if let Some((url, label)) = in_link.take() {
                    let label = if label.is_empty() { url.clone() } else { label };
                    current_spans.push(InlineSpan::Link { label, url });
                }
            }
            Event::Text(text) => {
                if let Some((_, code)) = in_code_block.as_mut() {
                    code.push_str(&text);
                } else if let Some((_, label)) = in_link.as_mut() {
                    label.push_str(&text);
                } else if in_strong {
                    current_spans.push(InlineSpan::Strong(text.into_string()));
                } else if in_emphasis {
                    current_spans.push(InlineSpan::Emphasis(text.into_string()));
                } else {
                    current_spans.push(InlineSpan::Text(text.into_string()));
                }
            }
            Event::Code(code) => {
                if let Some((_, label)) = in_link.as_mut() {
                    label.push_str(&code);
                } else {
                    current_spans.push(InlineSpan::Code(code.into_string()));
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some((_, code)) = in_code_block.as_mut() {
                    code.push('\n');
                } else {
                    current_spans.push(InlineSpan::Text(" ".to_owned()));
                }
            }
            Event::Rule => {
                flush_inline(&mut blocks, &mut current_spans, None, in_list_item, in_blockquote);
                blocks.push(MdBlock::ThematicBreak);
            }
            Event::TaskListMarker(checked) => {
                current_spans.push(InlineSpan::Text(if checked { "[x] " } else { "[ ] " }.to_owned()));
            }
            _ => {}
        }
    }

    flush_inline(
        &mut blocks,
        &mut current_spans,
        in_heading,
        in_list_item,
        in_blockquote,
    );

    blocks
}

fn heading_level_num(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// Estimates vertical pixel height of parsed Markdown blocks for `v_virtual_list`.
pub fn estimate_markdown_height(blocks: &[MdBlock], chars_per_line: usize) -> f32 {
    let cols = chars_per_line.max(32);
    let mut total = 0.0f32;
    for block in blocks {
        total += match block {
            MdBlock::Heading { level, spans } => {
                let chars = spans_char_len(spans);
                let lines = (chars / cols.saturating_sub(8).max(20)) + 1;
                let line_h = if *level <= 2 { 26.0 } else { 22.0 };
                (lines as f32) * line_h + 10.0
            }
            MdBlock::Paragraph(spans) | MdBlock::BlockQuote(spans) => {
                let chars = spans_char_len(spans);
                let lines = (chars / cols) + 1;
                (lines as f32) * 20.0 + 8.0
            }
            MdBlock::ListItem { spans, .. } => {
                let chars = spans_char_len(spans) + 4;
                let lines = (chars / cols) + 1;
                (lines as f32) * 20.0 + 4.0
            }
            MdBlock::CodeBlock { code, .. } => {
                let line_count = code.lines().count().max(1);
                (line_count as f32) * 18.0 + 36.0
            }
            MdBlock::ThematicBreak => 16.0,
        };
    }
    total.max(24.0)
}

fn spans_char_len(spans: &[InlineSpan]) -> usize {
    spans
        .iter()
        .map(|s| match s {
            InlineSpan::Text(t)
            | InlineSpan::Strong(t)
            | InlineSpan::Emphasis(t)
            | InlineSpan::Code(t) => t.chars().count(),
            InlineSpan::Link { label, .. } => label.chars().count(),
        })
        .sum()
}

/// Caches parsed Markdown AST per `(item_id, revision)` to avoid re-parsing on scroll or
/// unrelated streaming ticks.
#[derive(Debug, Default)]
pub struct MarkdownCache {
    entries: HashMap<(String, String), Arc<Vec<MdBlock>>>,
}

impl MarkdownCache {
    const MAX_ENTRIES: usize = 512;

    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_or_parse(
        &mut self,
        item_id: &str,
        revision: &str,
        source: &str,
    ) -> Arc<Vec<MdBlock>> {
        let key = (item_id.to_owned(), revision.to_owned());
        if let Some(existing) = self.entries.get(&key) {
            return existing.clone();
        }
        if self.entries.len() >= Self::MAX_ENTRIES {
            self.entries.clear();
        }
        let parsed = Arc::new(parse_markdown(source));
        self.entries.insert(key, parsed.clone());
        parsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headings_lists_emphasis_code_links() {
        let md = "# Title\n\nHello **bold** *italic* `code` [docs](https://example.com).\n\n- one\n- two\n\n```rust\nfn main() {}\n```\n";
        let blocks = parse_markdown(md);
        assert!(matches!(blocks[0], MdBlock::Heading { level: 1, .. }));
        assert!(matches!(blocks[1], MdBlock::Paragraph(_)));
        if let MdBlock::Paragraph(spans) = &blocks[1] {
            assert!(spans.iter().any(|s| matches!(s, InlineSpan::Strong(t) if t == "bold")));
            assert!(spans.iter().any(|s| matches!(s, InlineSpan::Emphasis(t) if t == "italic")));
            assert!(spans.iter().any(|s| matches!(s, InlineSpan::Code(t) if t == "code")));
            assert!(spans.iter().any(|s| matches!(s, InlineSpan::Link { label, url } if label == "docs" && url == "https://example.com")));
        }
        assert!(matches!(blocks[2], MdBlock::ListItem { ordered_index: None, .. }));
        assert!(matches!(blocks[3], MdBlock::ListItem { ordered_index: None, .. }));
        assert!(matches!(
            &blocks[4],
            MdBlock::CodeBlock { language: Some(l), code } if l == "rust" && code == "fn main() {}"
        ));
    }

    #[test]
    fn cache_reuses_same_revision_and_invalidates_on_new_revision() {
        let mut cache = MarkdownCache::new();
        let a = cache.get_or_parse("item-1", "rev-1", "Hello");
        let b = cache.get_or_parse("item-1", "rev-1", "Different text ignored on cache hit");
        assert!(Arc::ptr_eq(&a, &b));

        let c = cache.get_or_parse("item-1", "rev-2", "Updated");
        assert!(!Arc::ptr_eq(&a, &c));
        assert_eq!(
            *c,
            vec![MdBlock::Paragraph(vec![InlineSpan::Text("Updated".to_owned())])]
        );
    }
}
