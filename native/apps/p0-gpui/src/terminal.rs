//! Terminal drawer: `terminal.attach` output goes into a `TerminalEngine`; keys go back through
//! `terminal.write`. The drawer hides without closing the session, as in the web app.

use std::ops::Range;
use std::sync::{Arc, Mutex};

use gpui_kit::{
    Context, FocusHandle, HighlightStyle, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, StyledText,
    div, px, rgb,
};
use p0_terminal::rpc::{TerminalAttachStreamEvent, TerminalSessionStatus};
use p0_terminal::{
    AlacrittyEngine, Cell, Key, Modifiers, ScreenSnapshot, TermColor, TerminalEngine, encode_key,
};

use crate::app::P0App;
use crate::theme::AppPalette;

pub const DEFAULT_TERMINAL_ID: &str = "term-1";
pub const CELL_WIDTH: f32 = 7.2;
pub const LINE_HEIGHT: f32 = 16.0;
pub const DRAWER_ROWS: u16 = 16;

/// What the UI reads; the bridge's stream task writes it.
pub struct TerminalShared {
    pub engine: AlacrittyEngine,
    pub status: Option<String>,
}

pub type SharedTerminal = Arc<Mutex<TerminalShared>>;

pub fn new_shared(cols: u16, rows: u16) -> SharedTerminal {
    Arc::new(Mutex::new(TerminalShared {
        engine: AlacrittyEngine::new(cols, rows),
        status: None,
    }))
}

/// Applies one stream event; returns bytes the terminal answers with (cursor reports etc.).
pub fn apply_event(term: &mut TerminalShared, event: TerminalAttachStreamEvent) -> Vec<u8> {
    match event {
        TerminalAttachStreamEvent::Snapshot { snapshot }
        | TerminalAttachStreamEvent::Restarted { snapshot, .. } => {
            let (cols, rows) = term.engine.size();
            term.engine = AlacrittyEngine::new(cols, rows);
            term.engine.feed(snapshot.history.as_bytes());
            term.status = match snapshot.status {
                TerminalSessionStatus::Exited => Some("exited".to_owned()),
                TerminalSessionStatus::Error => snapshot.error.or(Some("error".to_owned())),
                _ => None,
            };
        }
        TerminalAttachStreamEvent::Output { data, .. } => term.engine.feed(data.as_bytes()),
        TerminalAttachStreamEvent::Cleared { .. } => {
            let (cols, rows) = term.engine.size();
            term.engine = AlacrittyEngine::new(cols, rows);
        }
        TerminalAttachStreamEvent::Exited { exit_code, .. } => {
            term.status = Some(match exit_code {
                Some(code) => format!("exited ({code})"),
                None => "exited".to_owned(),
            });
        }
        TerminalAttachStreamEvent::Closed { .. } => term.status = Some("closed".to_owned()),
        TerminalAttachStreamEvent::Error { message, .. } => term.status = Some(message),
        TerminalAttachStreamEvent::Activity { .. } | TerminalAttachStreamEvent::Unknown => {}
    }
    term.engine.take_pty_writes()
}

/// The bytes a key press sends, or `None` for keys the terminal ignores (bare modifiers, and
/// platform shortcuts, which stay app shortcuts).
pub fn key_bytes(event: &KeyDownEvent, app_cursor_mode: bool) -> Option<Vec<u8>> {
    let ks = &event.keystroke;
    if ks.modifiers.platform {
        return None;
    }
    let mods = Modifiers {
        shift: ks.modifiers.shift,
        alt: ks.modifiers.alt,
        ctrl: ks.modifiers.control,
    };
    let named = match ks.key.as_str() {
        "enter" => Some(Key::Enter),
        "backspace" => Some(Key::Backspace),
        "tab" => Some(Key::Tab),
        "escape" => Some(Key::Escape),
        "up" => Some(Key::Up),
        "down" => Some(Key::Down),
        "left" => Some(Key::Left),
        "right" => Some(Key::Right),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "pageup" => Some(Key::PageUp),
        "pagedown" => Some(Key::PageDown),
        "delete" => Some(Key::Delete),
        "space" => Some(Key::Char(' ')),
        _ => None,
    };
    if let Some(key) = named {
        return Some(encode_key(key, mods, app_cursor_mode));
    }
    if !mods.ctrl
        && let Some(text) = ks.key_char.as_deref().filter(|t| !t.is_empty())
    {
        let mut bytes = Vec::new();
        if mods.alt {
            bytes.push(0x1b);
        }
        bytes.extend_from_slice(text.as_bytes());
        return Some(bytes);
    }
    let mut chars = ks.key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Some(encode_key(Key::Char(c), mods, app_cursor_mode)),
        _ => None,
    }
}

/// xterm's 256-color palette.
pub fn indexed_color(ix: u8) -> u32 {
    const BASE: [u32; 16] = [
        0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666,
        0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
    ];
    match ix {
        0..=15 => BASE[ix as usize],
        16..=231 => {
            let i = ix - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + u32::from(v) * 40 };
            (level(i / 36) << 16) | (level((i / 6) % 6) << 8) | level(i % 6)
        }
        _ => {
            let v = 8 + u32::from(ix - 232) * 10;
            (v << 16) | (v << 8) | v
        }
    }
}

fn color(c: TermColor, default: Hsla) -> Hsla {
    match c {
        TermColor::Default => default,
        TermColor::Indexed(ix) => rgb(indexed_color(ix)).into(),
        TermColor::Rgb(r, g, b) => {
            rgb((u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b)).into()
        }
    }
}

/// One row as text plus style runs; runs of equally styled cells are merged.
fn row_runs(
    cells: &[Cell],
    cursor_col: Option<u16>,
    palette: &AppPalette,
) -> (String, Vec<(Range<usize>, HighlightStyle)>) {
    let mut text = String::new();
    let mut runs: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    for (col, cell) in cells.iter().enumerate() {
        let mut fg = color(cell.fg, palette.foreground);
        let mut bg = match cell.bg {
            TermColor::Default => None,
            other => Some(color(other, palette.code_bg)),
        };
        if cell.inverse || cursor_col == Some(col as u16) {
            let swapped_bg = Some(fg);
            fg = bg.unwrap_or(palette.code_bg);
            bg = swapped_bg;
        }
        let style = HighlightStyle {
            color: Some(fg),
            background_color: bg,
            font_weight: cell.bold.then_some(gpui_kit::FontWeight::BOLD),
            font_style: cell.italic.then_some(gpui_kit::FontStyle::Italic),
            underline: cell.underline.then(|| gpui_kit::UnderlineStyle {
                thickness: px(1.0),
                ..Default::default()
            }),
            ..Default::default()
        };
        let start = text.len();
        text.push(cell.ch);
        match runs.last_mut() {
            Some((range, last)) if *last == style && range.end == start => range.end = text.len(),
            _ => runs.push((start..text.len(), style)),
        }
    }
    (text, runs)
}

impl P0App {
    pub(crate) fn render_terminal(
        &self,
        focus: &FocusHandle,
        shared: &SharedTerminal,
        palette: &AppPalette,
        window: &gpui_kit::Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (screen, status): (ScreenSnapshot, Option<String>) = {
            let term = shared.lock().unwrap();
            (term.engine.snapshot(), term.status.clone())
        };
        let mut grid = div()
            .flex()
            .flex_col()
            .font_family("monospace")
            .text_xs()
            .line_height(px(LINE_HEIGHT));
        for (ix, cells) in screen.rows.iter().enumerate() {
            let cursor = (screen.cursor.visible
                && screen.cursor.row as usize == ix
                && focus.is_focused(window))
            .then_some(screen.cursor.col);
            let (text, runs) = row_runs(cells, cursor, palette);
            grid = grid.child(
                div()
                    .h(px(LINE_HEIGHT))
                    .child(StyledText::new(SharedString::from(text)).with_highlights(runs)),
            );
        }
        let mut drawer = div()
            .id("terminal-drawer")
            .key_context("Terminal")
            .track_focus(focus)
            .flex_none()
            .w_full()
            .h(px(LINE_HEIGHT * f32::from(DRAWER_ROWS) + 28.0))
            .border_t_1()
            .border_color(palette.border)
            .bg(palette.code_bg)
            .px(px(10.0))
            .py(px(6.0))
            .overflow_hidden()
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if this.terminal_key(event) {
                    cx.stop_propagation();
                }
            }))
            .on_click(cx.listener(|this, _, window, cx| this.focus_terminal(window, cx)));
        if let Some(status) = status {
            drawer = drawer.child(
                div()
                    .text_xs()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(status)),
            );
        }
        drawer.child(grid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::Keystroke;

    fn key(spec: &'static str, key_char: Option<&str>) -> KeyDownEvent {
        let mut keystroke = Keystroke::parse(spec).unwrap();
        keystroke.key_char = key_char.map(str::to_owned);
        KeyDownEvent {
            keystroke,
            is_held: false,
            prefer_character_input: false,
        }
    }

    #[test]
    fn keys_map_to_terminal_bytes() {
        assert_eq!(key_bytes(&key("a", Some("a")), false), Some(b"a".to_vec()));
        assert_eq!(
            key_bytes(&key("shift-a", Some("A")), false),
            Some(b"A".to_vec())
        );
        assert_eq!(key_bytes(&key("ctrl-c", None), false), Some(vec![0x03]));
        assert_eq!(key_bytes(&key("enter", None), false), Some(b"\r".to_vec()));
        assert_eq!(key_bytes(&key("up", None), true), Some(b"\x1bOA".to_vec()));
        assert_eq!(
            key_bytes(&key("alt-b", Some("b")), false),
            Some(b"\x1bb".to_vec())
        );
        assert_eq!(key_bytes(&key("cmd-k", None), false), None);
    }

    #[test]
    fn stream_events_drive_the_engine() {
        let shared = new_shared(20, 4);
        let mut term = shared.lock().unwrap();
        let snapshot: TerminalAttachStreamEvent = serde_json::from_value(serde_json::json!({
            "type": "snapshot",
            "snapshot": {"threadId": "t", "terminalId": DEFAULT_TERMINAL_ID, "cwd": "/w", "worktreePath": null,
                "status": "running", "pid": 1, "history": "$ ls\r\n", "exitCode": null, "exitSignal": null,
                "label": "bash", "updatedAt": "2026-01-01T00:00:00.000Z"}
        }))
        .unwrap();
        assert!(apply_event(&mut term, snapshot).is_empty());
        let output: TerminalAttachStreamEvent = serde_json::from_value(serde_json::json!({
            "type": "output", "threadId": "t", "terminalId": DEFAULT_TERMINAL_ID, "data": "a.txt\x1b[6n"
        }))
        .unwrap();
        let reply = apply_event(&mut term, output);
        assert_eq!(term.engine.snapshot().row_text(0), "$ ls");
        assert_eq!(term.engine.snapshot().row_text(1), "a.txt");
        assert_eq!(reply, b"\x1b[2;6R".to_vec());
        let exited: TerminalAttachStreamEvent = serde_json::from_value(serde_json::json!({
            "type": "exited", "threadId": "t", "terminalId": DEFAULT_TERMINAL_ID, "exitCode": 0, "exitSignal": null
        }))
        .unwrap();
        apply_event(&mut term, exited);
        assert_eq!(term.status.as_deref(), Some("exited (0)"));
    }

    #[test]
    fn xterm_palette() {
        assert_eq!(indexed_color(1), 0xcd3131);
        assert_eq!(indexed_color(16), 0x000000);
        assert_eq!(indexed_color(231), 0xffffff);
        assert_eq!(indexed_color(232), 0x080808);
    }
}
