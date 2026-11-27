//! Markdown (`pulldown-cmark`) to blocks of styled runs, cached per turn item by content hash.
//!
//! A paragraph is one string plus style runs, so it lays out as one `StyledText` and wraps like
//! text instead of like a row of boxes. The cache key is the item id and a hash of the source:
//! streaming updates can keep `updatedAt`, so a timestamp key would serve stale text.

use std::collections::HashMap;
use std::hash::{Hash as _, Hasher as _};
use std::ops::Range;
use std::sync::Arc;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunStyle {
    pub strong: bool,
    pub emphasis: bool,
    pub strike: bool,
    pub code: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub range: Range<usize>,
    pub style: RunStyle,
    pub link: Option<String>,
}

/// Text of one block plus the runs that style parts of it (plain text has no run).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Inline {
    pub text: String,
    pub runs: Vec<Run>,
}

impl Inline {
    fn push(&mut self, text: &str, style: RunStyle, link: Option<&str>) {
        if text.is_empty() {
            return;
        }
        let start = self.text.len();
        self.text.push_str(text);
        if style != RunStyle::default() || link.is_some() {
            self.runs.push(Run {
                range: start..self.text.len(),
                style,
                link: link.map(ToOwned::to_owned),
            });
        }
    }

    fn is_blank(&self) -> bool {
        self.text.trim().is_empty()
    }

    #[cfg(test)]
    pub fn link_at(&self, ix: usize) -> Option<&str> {
        self.runs
            .iter()
            .find(|r| r.range.contains(&ix))
            .and_then(|r| r.link.as_deref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListMarker {
    Bullet,
    Number(u64),
    /// A later paragraph of the same item: indented, no marker.
    Continuation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MdBlock {
    Heading {
        level: u8,
        inline: Inline,
    },
    Paragraph(Inline),
    ListItem {
        depth: usize,
        marker: ListMarker,
        inline: Inline,
    },
    Quote(Inline),
    Code {
        language: Option<String>,
        code: String,
    },
    Rule,
}

struct ItemFrame {
    marker: ListMarker,
    emitted: bool,
}

#[derive(Default)]
struct Builder {
    blocks: Vec<MdBlock>,
    inline: Inline,
    style: (u32, u32, u32),
    links: Vec<String>,
    lists: Vec<Option<u64>>,
    items: Vec<ItemFrame>,
    quote_depth: u32,
    heading: Option<u8>,
    code: Option<(Option<String>, String)>,
}

impl Builder {
    fn run_style(&self) -> RunStyle {
        RunStyle {
            strong: self.style.0 > 0,
            emphasis: self.style.1 > 0,
            strike: self.style.2 > 0,
            code: false,
        }
    }

    fn text(&mut self, text: &str) {
        if let Some((_, code)) = self.code.as_mut() {
            code.push_str(text);
            return;
        }
        let style = self.run_style();
        let link = self.links.last().cloned();
        self.inline.push(text, style, link.as_deref());
    }

    fn inline_code(&mut self, text: &str) {
        let style = RunStyle {
            code: true,
            ..self.run_style()
        };
        let link = self.links.last().cloned();
        self.inline.push(text, style, link.as_deref());
    }

    fn flush(&mut self) {
        if self.inline.is_blank() {
            self.inline = Inline::default();
            return;
        }
        let inline = std::mem::take(&mut self.inline);
        let block = if let Some(level) = self.heading {
            MdBlock::Heading { level, inline }
        } else if let Some(item) = self.items.last_mut() {
            let marker = if item.emitted {
                ListMarker::Continuation
            } else {
                item.marker
            };
            item.emitted = true;
            MdBlock::ListItem {
                depth: self.items.len() - 1,
                marker,
                inline,
            }
        } else if self.quote_depth > 0 {
            MdBlock::Quote(inline)
        } else {
            MdBlock::Paragraph(inline)
        };
        self.blocks.push(block);
    }
}

pub fn parse_markdown(input: &str) -> Vec<MdBlock> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_TABLES);

    let mut b = Builder::default();
    for event in Parser::new_ext(input, opts) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                b.flush();
                b.heading = Some(heading_level_num(level));
            }
            Event::End(TagEnd::Heading(_)) => {
                b.flush();
                b.heading = None;
            }
            Event::End(TagEnd::Paragraph) => b.flush(),
            Event::Start(Tag::BlockQuote(_)) => {
                b.flush();
                b.quote_depth += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                b.flush();
                b.quote_depth = b.quote_depth.saturating_sub(1);
            }
            Event::Start(Tag::List(start)) => {
                // Text of a tight outer item ends where its nested list starts.
                b.flush();
                b.lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                b.flush();
                b.lists.pop();
            }
            Event::Start(Tag::Item) => {
                b.flush();
                let marker = match b.lists.last_mut() {
                    Some(Some(n)) => {
                        let current = *n;
                        *n += 1;
                        ListMarker::Number(current)
                    }
                    _ => ListMarker::Bullet,
                };
                b.items.push(ItemFrame {
                    marker,
                    emitted: false,
                });
            }
            Event::End(TagEnd::Item) => {
                b.flush();
                b.items.pop();
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                b.flush();
                let lang = match kind {
                    CodeBlockKind::Fenced(l) => {
                        let first = l.split_whitespace().next().unwrap_or("");
                        (!first.is_empty()).then(|| first.to_owned())
                    }
                    CodeBlockKind::Indented => None,
                };
                b.code = Some((lang, String::new()));
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((language, code)) = b.code.take() {
                    b.blocks.push(MdBlock::Code {
                        language,
                        code: code.trim_end_matches('\n').to_owned(),
                    });
                }
            }
            Event::Start(Tag::Strong) => b.style.0 += 1,
            Event::End(TagEnd::Strong) => b.style.0 = b.style.0.saturating_sub(1),
            Event::Start(Tag::Emphasis) => b.style.1 += 1,
            Event::End(TagEnd::Emphasis) => b.style.1 = b.style.1.saturating_sub(1),
            Event::Start(Tag::Strikethrough) => b.style.2 += 1,
            Event::End(TagEnd::Strikethrough) => b.style.2 = b.style.2.saturating_sub(1),
            Event::Start(Tag::Link { dest_url, .. }) => b.links.push(dest_url.into_string()),
            Event::End(TagEnd::Link) => {
                b.links.pop();
            }
            // Tables render as their rows' text; cells are separated so they stay readable.
            Event::End(TagEnd::TableCell) => b.text("  "),
            Event::End(TagEnd::TableRow | TagEnd::TableHead) => b.flush(),
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => b.text(&text),
            Event::Code(code) => b.inline_code(&code),
            Event::SoftBreak => b.text(if b.code.is_some() { "\n" } else { " " }),
            Event::HardBreak => b.text("\n"),
            Event::Rule => {
                b.flush();
                b.blocks.push(MdBlock::Rule);
            }
            Event::TaskListMarker(checked) => b.text(if checked { "☑ " } else { "☐ " }),
            _ => {}
        }
    }
    if let Some((language, code)) = b.code.take() {
        // An unterminated fence while the message is still streaming.
        b.blocks.push(MdBlock::Code { language, code });
    }
    b.flush();
    b.blocks
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

fn content_hash(source: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut h);
    h.finish()
}

/// Parsed blocks per turn item. One entry per item: a changed source replaces it, so the cache
/// holds at most the open thread's items.
#[derive(Debug, Default)]
pub struct MarkdownCache {
    entries: HashMap<String, (u64, Arc<Vec<MdBlock>>)>,
}

impl MarkdownCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_or_parse(&mut self, item_id: &str, source: &str) -> Arc<Vec<MdBlock>> {
        let hash = content_hash(source);
        if let Some((cached, blocks)) = self.entries.get(item_id)
            && *cached == hash
        {
            return blocks.clone();
        }
        let parsed = Arc::new(parse_markdown(source));
        self.entries
            .insert(item_id.to_owned(), (hash, parsed.clone()));
        parsed
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inline_text(block: &MdBlock) -> &str {
        match block {
            MdBlock::Heading { inline, .. }
            | MdBlock::Paragraph(inline)
            | MdBlock::ListItem { inline, .. }
            | MdBlock::Quote(inline) => &inline.text,
            MdBlock::Code { code, .. } => code,
            MdBlock::Rule => "",
        }
    }

    #[test]
    fn paragraph_is_one_string_with_style_runs() {
        let blocks = parse_markdown("Hello **bold *both*** and `code` [docs](https://x.dev).");
        let [MdBlock::Paragraph(p)] = blocks.as_slice() else {
            panic!("{blocks:?}");
        };
        assert_eq!(p.text, "Hello bold both and code docs.");
        let both = p
            .runs
            .iter()
            .find(|r| &p.text[r.range.clone()] == "both")
            .unwrap();
        assert!(both.style.strong && both.style.emphasis);
        let code = p.runs.iter().find(|r| r.style.code).unwrap();
        assert_eq!(&p.text[code.range.clone()], "code");
        let docs_at = p.text.find("docs").unwrap();
        assert_eq!(p.link_at(docs_at), Some("https://x.dev"));
        assert_eq!(p.link_at(0), None);
    }

    #[test]
    fn nested_tight_lists_keep_their_own_items() {
        let blocks = parse_markdown("- a\n  - b\n  - c\n- d\n\n1. one\n2. two\n");
        let items: Vec<_> = blocks
            .iter()
            .map(|b| match b {
                MdBlock::ListItem {
                    depth,
                    marker,
                    inline,
                } => (*depth, *marker, inline.text.as_str()),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            items,
            [
                (0, ListMarker::Bullet, "a"),
                (1, ListMarker::Bullet, "b"),
                (1, ListMarker::Bullet, "c"),
                (0, ListMarker::Bullet, "d"),
                (0, ListMarker::Number(1), "one"),
                (0, ListMarker::Number(2), "two"),
            ]
        );
    }

    #[test]
    fn loose_item_paragraphs_continue_the_item() {
        let blocks = parse_markdown("- first\n\n  second\n");
        assert!(matches!(
            &blocks[..],
            [
                MdBlock::ListItem {
                    marker: ListMarker::Bullet,
                    ..
                },
                MdBlock::ListItem {
                    marker: ListMarker::Continuation,
                    ..
                }
            ]
        ));
    }

    #[test]
    fn headings_code_quotes_and_unterminated_fences() {
        let blocks = parse_markdown(
            "# Title\n\n> quoted\n\n```rust\nfn main() {}\n```\n\n---\n\n```py\nprint(1)",
        );
        assert!(matches!(&blocks[0], MdBlock::Heading { level: 1, .. }));
        assert!(matches!(&blocks[1], MdBlock::Quote(_)));
        assert!(
            matches!(&blocks[2], MdBlock::Code { language: Some(l), code } if l == "rust" && code == "fn main() {}")
        );
        assert!(matches!(&blocks[3], MdBlock::Rule));
        assert!(matches!(&blocks[4], MdBlock::Code { language: Some(l), .. } if l == "py"));
        assert_eq!(inline_text(&blocks[4]), "print(1)");
    }

    #[test]
    fn cache_follows_content_not_timestamps() {
        let mut cache = MarkdownCache::new();
        let a = cache.get_or_parse("item-1", "Hello");
        let b = cache.get_or_parse("item-1", "Hello");
        assert!(Arc::ptr_eq(&a, &b));
        // A streaming delta with the same updatedAt still shows the new text.
        let c = cache.get_or_parse("item-1", "Hello world");
        assert_eq!(inline_text(&c[0]), "Hello world");
        assert_eq!(cache.entries.len(), 1);
    }
}
