//! `@` file mentions and `/` commands in the composer, ported from
//! `packages/shared/src/composerTrigger.ts` and `ChatComposer.tsx`: `@query` searches the
//! thread's folder (`projects.searchEntries`) and inserts a Markdown file link; `/query` lists
//! the client commands, the provider's slash commands and its skills.

use std::ops::Range;
use std::time::Duration;

use gpui_kit::{
    Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use p0_protocol::{
    EntriesResult, ProjectEntryKind, RPC_PROJECTS_SEARCH_ENTRIES, SearchEntriesInput,
};

use crate::app::P0App;
use crate::theme::AppPalette;

const SEARCH_LIMIT: u32 = 80;
const SEARCH_DEBOUNCE: Duration = Duration::from_millis(120);
const JUDGES_PROMPT: &str = "Convene the configured judges panel using convene_judges. Validate its findings, fix real issues, and run relevant tests. ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerKind {
    Path,
    SlashCommand,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trigger {
    pub kind: TriggerKind,
    pub query: String,
    /// Byte range of the trigger token, up to the cursor.
    pub range: Range<usize>,
}

/// The token before `cursor` (a byte offset) when it starts with `/`, a currency sign or `@`.
pub fn detect_trigger(text: &str, cursor: usize) -> Option<Trigger> {
    let mut cursor = cursor.min(text.len());
    while !text.is_char_boundary(cursor) {
        cursor -= 1;
    }
    let start = text[..cursor]
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map_or(0, |(i, c)| i + c.len_utf8());
    let token = &text[start..cursor];
    let mut chars = token.chars();
    let first = chars.next()?;
    let rest = chars.as_str();
    let kind = match first {
        '/' => {
            let word_end = text[cursor..]
                .find(char::is_whitespace)
                .map_or(text.len(), |i| cursor + i);
            // A second slash or backslash makes the word a path.
            if text[start + 1..word_end].contains(['/', '\\']) {
                return None;
            }
            TriggerKind::SlashCommand
        }
        '@' => TriggerKind::Path,
        c if is_currency_symbol(c) => {
            if is_currency_amount(rest) {
                return None;
            }
            TriggerKind::Skill
        }
        _ => return None,
    };
    Some(Trigger {
        kind,
        query: rest.to_owned(),
        range: start..cursor,
    })
}

fn is_currency_symbol(c: char) -> bool {
    matches!(
        c,
        '$' | '€' | '£' | '¥' | '₩' | '₹' | '₽' | '₺' | '₫' | '₪' | '¢' | '₱' | '฿'
    )
}

/// `$5`, `€9.99` and `$10k.` are money, not skills.
fn is_currency_amount(query: &str) -> bool {
    let q = query.strip_prefix('.').unwrap_or(query);
    let mut chars = q.chars().peekable();
    if !chars.peek().is_some_and(char::is_ascii_digit) {
        return false;
    }
    while chars
        .peek()
        .is_some_and(|c| c.is_ascii_digit() || matches!(c, ',' | '.' | '_'))
    {
        chars.next();
    }
    match chars.peek() {
        Some('e' | 'E') => {
            chars.next();
            if !chars.peek().is_some_and(char::is_ascii_digit) {
                return false;
            }
            while chars.peek().is_some_and(char::is_ascii_digit) {
                chars.next();
            }
        }
        Some(c) if "kKmMbBtT".contains(*c) => {
            chars.next();
        }
        _ => {}
    }
    chars.all(|c| ".,;:!?)".contains(c))
}

/// `[label](destination)` as the web composer writes a mentioned file.
pub fn serialize_file_link(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let mut label = String::new();
    for c in name.chars() {
        match c {
            '[' => label.push_str("&#91;"),
            ']' => label.push_str("&#93;"),
            '\\' | '*' | '_' | '~' | '&' => {
                label.push('\\');
                label.push(c);
            }
            c => label.push(c),
        }
    }
    let destination = encode_destination(path);
    let prefix = if needs_dot_slash(path) { "./" } else { "" };
    format!("[{label}]({prefix}{destination})")
}

/// `encodeURI`, then the characters a Markdown destination cannot hold.
fn encode_destination(path: &str) -> String {
    const KEEP: &str = ";,/?:@&=+$-_.!~*'()#";
    let mut out = String::new();
    for c in path.chars() {
        let mut buf = [0u8; 4];
        let encoded = match c {
            '(' => "%28".to_owned(),
            ')' => "%29".to_owned(),
            '&' => "%26".to_owned(),
            '#' => "%23".to_owned(),
            '?' => "%3F".to_owned(),
            '\\' => "%5C".to_owned(),
            c if c.is_ascii_alphanumeric() || KEEP.contains(c) => c.to_string(),
            c => c
                .encode_utf8(&mut buf)
                .bytes()
                .map(|b| format!("%{b:02X}"))
                .collect(),
        };
        out.push_str(&encoded);
    }
    out
}

/// Relative names the web app's link parser would not read as a file (`LICENSE`) or would read
/// as a URI scheme (`a:b`) get `./`.
fn needs_dot_slash(path: &str) -> bool {
    let rooted = path.starts_with(['/', '\\'])
        || (path.len() > 2
            && path.as_bytes()[0].is_ascii_alphabetic()
            && path.as_bytes()[1] == b':'
            && matches!(path.as_bytes()[2], b'/' | b'\\'));
    if path.is_empty() || rooted {
        return false;
    }
    let scheme_like = path.split_once(':').is_some_and(|(head, _)| {
        head.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && head
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let name = path.rsplit('/').next().unwrap_or(path);
    let has_extension = name.rfind('.').is_some_and(|i| i > 0);
    scheme_like || (!path.contains('/') && !has_extension)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Action {
    Insert(String),
    OpenModelPicker,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Item {
    label: String,
    detail: String,
    action: Action,
}

#[derive(Default)]
pub struct Completion {
    trigger: Option<Trigger>,
    items: Vec<Item>,
    highlighted: usize,
    /// Escape hides the menu until the trigger token starts somewhere else.
    dismissed_at: Option<usize>,
    search_generation: u64,
}

impl Completion {
    pub fn is_open(&self) -> bool {
        self.trigger.is_some() && !self.items.is_empty()
    }
}

fn matches(query: &str, name: &str) -> Option<u8> {
    let (q, n) = (query.to_lowercase(), name.to_lowercase());
    if n.starts_with(&q) {
        Some(0)
    } else if n.contains(&q) {
        Some(1)
    } else {
        None
    }
}

impl P0App {
    /// The provider instance the composer sends to.
    fn composer_instance_id(&self) -> Option<String> {
        self.selected_model()
            .map(|m| m.instance_id.clone())
            .or_else(|| {
                self.thread
                    .projection
                    .as_ref()
                    .map(|p| p.thread.model_selection.instance_id.clone())
            })
            .or_else(|| {
                let id = self.selected_thread_id()?;
                Some(
                    self.shell
                        .thread_by_id(id)?
                        .model_selection
                        .instance_id
                        .clone(),
                )
            })
    }

    fn command_items(&self, trigger: &Trigger) -> Vec<Item> {
        let mut ranked: Vec<(u8, Item)> = Vec::new();
        let mut push = |name: &str, label: String, detail: String, action: Action| {
            if let Some(rank) = matches(&trigger.query, name) {
                ranked.push((
                    rank,
                    Item {
                        label,
                        detail,
                        action,
                    },
                ));
            }
        };
        let config = self.bridge.server_config();
        let provider = self.composer_instance_id().and_then(|id| {
            config
                .as_ref()?
                .providers
                .iter()
                .find(|p| p.instance_id == id)
                .cloned()
        });
        if trigger.kind == TriggerKind::SlashCommand {
            let t = |s: &str| self.i18n.tr(s).to_owned();
            push(
                "model",
                "/model".into(),
                t("Model"),
                Action::OpenModelPicker,
            );
            push(
                "judges",
                "/judges".into(),
                t("Convene the judges panel"),
                Action::Insert(JUDGES_PROMPT.to_owned()),
            );
            push(
                "side",
                "/side".into(),
                t("Side chat"),
                Action::Insert("/side ".into()),
            );
            push(
                "btw",
                "/btw".into(),
                t("Side chat"),
                Action::Insert("/btw ".into()),
            );
            for command in provider.iter().flat_map(|p| &p.slash_commands) {
                if matches!(command.name.as_str(), "model" | "side" | "btw" | "judges") {
                    continue;
                }
                push(
                    &command.name,
                    format!("/{}", command.name),
                    command.description.clone().unwrap_or_default(),
                    Action::Insert(format!("/{} ", command.name)),
                );
            }
        }
        for skill in provider
            .iter()
            .flat_map(|p| &p.skills)
            .filter(|s| s.enabled && s.user_invocable != Some(false))
        {
            let label = match trigger.kind {
                TriggerKind::SlashCommand => format!("/skill:{}", skill.name),
                _ => format!("${}", skill.name),
            };
            push(
                &skill.name,
                label,
                skill
                    .short_description
                    .clone()
                    .or_else(|| skill.description.clone())
                    .unwrap_or_default(),
                Action::Insert(format!("${} ", skill.name)),
            );
        }
        ranked.sort_by_key(|(rank, _)| *rank);
        ranked.into_iter().map(|(_, item)| item).collect()
    }

    /// Re-reads the trigger at the cursor after every edit.
    pub(crate) fn update_completion(&mut self, cx: &mut Context<Self>) {
        let (text, cursor) = {
            let input = self.composer_input().read(cx);
            (input.value().to_string(), input.cursor())
        };
        let trigger = detect_trigger(&text, cursor);
        let completion = &mut self.completion;
        if completion.dismissed_at.is_some()
            && completion.dismissed_at != trigger.as_ref().map(|t| t.range.start)
        {
            completion.dismissed_at = None;
        }
        let Some(trigger) = trigger.filter(|t| Some(t.range.start) != completion.dismissed_at)
        else {
            if completion.trigger.take().is_some() {
                cx.notify();
            }
            return;
        };
        if completion.trigger.as_ref() == Some(&trigger) {
            return;
        }
        completion.highlighted = 0;
        match trigger.kind {
            TriggerKind::Path => {
                completion.trigger = Some(trigger.clone());
                self.search_mentions(trigger.query, cx);
            }
            TriggerKind::SlashCommand | TriggerKind::Skill => {
                self.completion.items = self.command_items(&trigger);
                self.completion.trigger = Some(trigger);
            }
        }
        cx.notify();
    }

    fn search_mentions(&mut self, query: String, cx: &mut Context<Self>) {
        let Some(cwd) = self
            .selected_thread_id()
            .map(ToOwned::to_owned)
            .and_then(|id| self.thread_cwd(&id))
            .or_else(|| self.draft_project_root())
        else {
            self.completion.items.clear();
            return;
        };
        self.completion.search_generation += 1;
        let generation = self.completion.search_generation;
        let bridge = self.bridge.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SEARCH_DEBOUNCE).await;
            let stale = this
                .update(cx, |app, _| app.completion.search_generation != generation)
                .unwrap_or(true);
            if stale {
                return;
            }
            let result = bridge
                .query::<_, EntriesResult>(
                    RPC_PROJECTS_SEARCH_ENTRIES,
                    SearchEntriesInput {
                        cwd,
                        query: query.trim().to_owned(),
                        limit: SEARCH_LIMIT,
                        kind: None,
                    },
                )
                .await;
            this.update(cx, |app, cx| {
                if app.completion.search_generation != generation {
                    return;
                }
                app.completion.items = result
                    .map(|r| r.entries)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|entry| {
                        let (dir, name) = entry.path.rsplit_once('/').unwrap_or(("", &entry.path));
                        let is_dir = entry.kind == ProjectEntryKind::Directory;
                        Item {
                            label: if is_dir {
                                format!("{name}/")
                            } else {
                                name.to_owned()
                            },
                            detail: dir.to_owned(),
                            action: Action::Insert(format!(
                                "{} ",
                                serialize_file_link(&entry.path)
                            )),
                        }
                    })
                    .collect();
                app.completion.highlighted = 0;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Up/Down/Enter/Tab/Escape while the menu shows; `false` leaves the key to the composer.
    pub(crate) fn completion_key(
        &mut self,
        key: CompletionKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.completion.is_open() {
            return false;
        }
        let len = self.completion.items.len();
        match key {
            CompletionKey::Up => {
                self.completion.highlighted = (self.completion.highlighted + len - 1) % len;
            }
            CompletionKey::Down => {
                self.completion.highlighted = (self.completion.highlighted + 1) % len;
            }
            CompletionKey::Accept => {
                self.accept_completion(self.completion.highlighted, window, cx);
            }
            CompletionKey::Dismiss => {
                self.completion.dismissed_at =
                    self.completion.trigger.take().map(|t| t.range.start);
            }
        }
        cx.notify();
        true
    }

    fn accept_completion(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(trigger), Some(item)) = (
            self.completion.trigger.take(),
            self.completion.items.get(ix).cloned(),
        ) else {
            return;
        };
        let replacement = match &item.action {
            Action::Insert(text) => text.clone(),
            Action::OpenModelPicker => String::new(),
        };
        self.composer_input().update(cx, |input, cx| {
            input.set_selected_range(trigger.range.clone(), cx);
            input.replace(replacement, window, cx);
        });
        if item.action == Action::OpenModelPicker && !self.model_picker_open() {
            self.toggle_model_picker(cx);
        }
        self.completion.items.clear();
    }

    pub(crate) fn render_completion_menu(
        &self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        if !self.completion.is_open() {
            return None;
        }
        let mut menu = div()
            .id("composer-completions")
            .w_full()
            .max_h(px(240.0))
            .overflow_y_scroll()
            .p(px(4.0))
            .rounded(px(8.0))
            .bg(palette.card)
            .border_1()
            .border_color(palette.border)
            .flex()
            .flex_col();
        for (ix, item) in self.completion.items.iter().enumerate() {
            let highlighted = ix == self.completion.highlighted;
            menu = menu.child(
                div()
                    .id(("completion", ix))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_sm()
                    .when_highlighted(highlighted, palette)
                    .hover(|s| s.bg(palette.row_hover))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.accept_completion(ix, window, cx);
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex_none()
                            .text_color(palette.foreground)
                            .child(SharedString::from(item.label.clone())),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(item.detail.clone())),
                    ),
            );
        }
        Some(menu)
    }
}

#[derive(Debug, Clone, Copy)]
pub enum CompletionKey {
    Up,
    Down,
    Accept,
    Dismiss,
}

trait Highlighted {
    fn when_highlighted(self, on: bool, palette: &AppPalette) -> Self;
}

impl Highlighted for gpui_kit::Stateful<gpui_kit::Div> {
    fn when_highlighted(self, on: bool, palette: &AppPalette) -> Self {
        if on { self.bg(palette.row_hover) } else { self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(text: &str) -> Option<(TriggerKind, String)> {
        detect_trigger(text, text.len()).map(|t| (t.kind, t.query))
    }

    #[test]
    fn detects_triggers_like_the_web_composer() {
        assert_eq!(
            kind("hi @src/ma"),
            Some((TriggerKind::Path, "src/ma".into()))
        );
        assert_eq!(
            kind("/mod"),
            Some((TriggerKind::SlashCommand, "mod".into()))
        );
        assert_eq!(kind("see /src/a.ts"), None);
        assert_eq!(kind("$rev"), Some((TriggerKind::Skill, "rev".into())));
        assert_eq!(kind("costs $10k."), None);
        assert_eq!(kind("costs $5"), None);
        assert_eq!(kind("plain words"), None);
        assert_eq!(kind("trailing "), None);
        let t = detect_trigger("ab @x cd", 5).unwrap();
        assert_eq!(t.range, 3..5);
    }

    #[test]
    fn file_links_match_serialize_composer_file_link() {
        assert_eq!(serialize_file_link("src/main.rs"), "[main.rs](src/main.rs)");
        assert_eq!(
            serialize_file_link("docs/a b(1).md"),
            "[a b(1).md](docs/a%20b%281%29.md)"
        );
        assert_eq!(serialize_file_link("LICENSE"), "[LICENSE](./LICENSE)");
        assert_eq!(
            serialize_file_link("my_[x].rs"),
            "[my\\_&#91;x&#93;.rs](my_%5Bx%5D.rs)"
        );
        assert_eq!(serialize_file_link("/abs/x.rs"), "[x.rs](/abs/x.rs)");
    }
}
