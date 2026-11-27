use std::sync::{Arc, Mutex, PoisonError};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor};

use crate::{Cell, Cursor, ScreenSnapshot, TermColor, TerminalEngine};

#[derive(Default)]
struct Inbox {
    pty_writes: Vec<u8>,
    title: Option<String>,
}

#[derive(Clone, Default)]
struct Listener(Arc<Mutex<Inbox>>);

impl Listener {
    fn with<R>(&self, f: impl FnOnce(&mut Inbox) -> R) -> R {
        f(&mut self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(text) => self.with(|inbox| inbox.pty_writes.extend(text.as_bytes())),
            Event::Title(title) => self.with(|inbox| inbox.title = Some(title)),
            Event::ResetTitle => self.with(|inbox| inbox.title = None),
            _ => {}
        }
    }
}

struct Size {
    cols: u16,
    rows: u16,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.cols)
    }
}

pub struct AlacrittyEngine {
    term: Term<Listener>,
    parser: Processor,
    listener: Listener,
}

impl AlacrittyEngine {
    pub fn new(cols: u16, rows: u16) -> Self {
        let listener = Listener::default();
        let size = Size {
            cols: cols.max(1),
            rows: rows.max(1),
        };
        Self {
            term: Term::new(Config::default(), &size, listener.clone()),
            parser: Processor::new(),
            listener,
        }
    }
}

impl TerminalEngine for AlacrittyEngine {
    fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(Size {
            cols: cols.max(1),
            rows: rows.max(1),
        });
    }

    fn size(&self) -> (u16, u16) {
        let clamp = |n: usize| u16::try_from(n).unwrap_or(u16::MAX);
        (clamp(self.term.columns()), clamp(self.term.screen_lines()))
    }

    fn snapshot(&self) -> ScreenSnapshot {
        let content = self.term.renderable_content();
        let offset = content.display_offset as i32;
        let (cols, lines) = (self.term.columns(), self.term.screen_lines());
        let mut rows = vec![vec![Cell::default(); cols]; lines];
        for indexed in content.display_iter {
            let (row, col) = (
                (indexed.point.line.0 + offset) as usize,
                indexed.point.column.0,
            );
            if let Some(slot) = rows.get_mut(row).and_then(|r| r.get_mut(col)) {
                *slot = convert_cell(indexed.cell);
            }
        }
        let cursor_row = content.cursor.point.line.0 + offset;
        let cursor = Cursor {
            row: cursor_row.clamp(0, i32::from(u16::MAX)) as u16,
            col: u16::try_from(content.cursor.point.column.0).unwrap_or(u16::MAX),
            visible: content.cursor.shape != CursorShape::Hidden
                && (0..lines as i32).contains(&cursor_row),
        };
        ScreenSnapshot {
            rows,
            cursor,
            title: self.listener.with(|inbox| inbox.title.clone()),
            display_offset: content.display_offset,
        }
    }

    fn scroll_display(&mut self, delta_lines: i32) {
        self.term.scroll_display(Scroll::Delta(delta_lines));
    }

    fn app_cursor_mode(&self) -> bool {
        self.term.mode().contains(TermMode::APP_CURSOR)
    }

    fn take_pty_writes(&mut self) -> Vec<u8> {
        self.listener
            .with(|inbox| std::mem::take(&mut inbox.pty_writes))
    }
}

fn convert_cell(cell: &alacritty_terminal::term::cell::Cell) -> Cell {
    let flags = cell.flags;
    let blank = flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER);
    Cell {
        ch: if blank { ' ' } else { cell.c },
        fg: convert_color(cell.fg),
        bg: convert_color(cell.bg),
        bold: flags.contains(Flags::BOLD),
        italic: flags.contains(Flags::ITALIC),
        underline: flags.intersects(Flags::ALL_UNDERLINES),
        inverse: flags.contains(Flags::INVERSE),
        wide: flags.contains(Flags::WIDE_CHAR),
    }
}

fn convert_color(color: Color) -> TermColor {
    match color {
        Color::Spec(rgb) => TermColor::Rgb(rgb.r, rgb.g, rgb.b),
        Color::Indexed(index) => TermColor::Indexed(index),
        Color::Named(named) => {
            let index = named as usize;
            let dim_black = NamedColor::DimBlack as usize;
            match index {
                0..16 => TermColor::Indexed(index as u8),
                _ if (dim_black..dim_black + 8).contains(&index) => {
                    TermColor::Indexed((index - dim_black) as u8)
                }
                _ => TermColor::Default,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(bytes: &str) -> AlacrittyEngine {
        let mut engine = AlacrittyEngine::new(20, 5);
        engine.feed(bytes.as_bytes());
        engine
    }

    #[test]
    fn prints_lines() {
        let snapshot = engine("hello\r\nworld").snapshot();
        assert_eq!(snapshot.row_text(0), "hello");
        assert_eq!(snapshot.row_text(1), "world");
        assert_eq!(
            snapshot.cursor,
            Cursor {
                row: 1,
                col: 5,
                visible: true
            }
        );
    }

    #[test]
    fn sgr_attributes_land_in_cells() {
        let snapshot =
            engine("\x1b[1;31mA\x1b[0;3;4;7mB\x1b[38;2;1;2;3;48;5;200mC\x1b[0mD").snapshot();
        let row = &snapshot.rows[0];
        assert_eq!(row[0].fg, TermColor::Indexed(1));
        assert!(row[0].bold && !row[0].italic);
        assert!(row[1].italic && row[1].underline && row[1].inverse && !row[1].bold);
        assert_eq!(row[1].fg, TermColor::Default);
        assert_eq!(row[2].fg, TermColor::Rgb(1, 2, 3));
        assert_eq!(row[2].bg, TermColor::Indexed(200));
        assert_eq!(
            row[3],
            Cell {
                ch: 'D',
                ..Cell::default()
            }
        );
    }

    #[test]
    fn cup_moves_cursor() {
        let snapshot = engine("\x1b[3;7HX").snapshot();
        assert_eq!(snapshot.rows[2][6].ch, 'X');
        assert_eq!((snapshot.cursor.row, snapshot.cursor.col), (2, 7));
    }

    #[test]
    fn hidden_cursor_and_title() {
        let snapshot = engine("\x1b[?25l\x1b]0;my title\x07").snapshot();
        assert!(!snapshot.cursor.visible);
        assert_eq!(snapshot.title.as_deref(), Some("my title"));
    }

    #[test]
    fn resize_keeps_content() {
        let mut engine = engine("hello\r\nworld");
        engine.resize(40, 10);
        assert_eq!(engine.size(), (40, 10));
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.rows.len(), 10);
        assert!(snapshot.rows.iter().all(|row| row.len() == 40));
        assert_eq!(snapshot.row_text(0), "hello");
        assert_eq!(snapshot.row_text(1), "world");

        engine.resize(3, 2);
        let snapshot = engine.snapshot();
        assert_eq!(engine.size(), (3, 2));
        assert_eq!(snapshot.rows.len(), 2);
        assert!(snapshot.rows.iter().all(|row| row.len() == 3));
        assert!(snapshot.cursor.row < 2);
    }

    #[test]
    fn dsr_replies_with_cursor_position() {
        let mut engine = engine("ab\r\ncd\x1b[6n");
        assert_eq!(engine.take_pty_writes(), b"\x1b[2;3R");
        assert!(engine.take_pty_writes().is_empty());
    }

    #[test]
    fn scrolls_into_history() {
        let mut engine = engine(&(0..10).map(|n| format!("line{n}\r\n")).collect::<String>());
        assert_eq!(engine.snapshot().row_text(0), "line6");
        engine.scroll_display(2);
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.display_offset, 2);
        assert_eq!(snapshot.row_text(0), "line4");
        engine.scroll_display(-10);
        assert_eq!(engine.snapshot().display_offset, 0);
    }

    #[test]
    fn tracks_app_cursor_mode() {
        let mut engine = engine("\x1b[?1h");
        assert!(engine.app_cursor_mode());
        engine.feed(b"\x1b[?1l");
        assert!(!engine.app_cursor_mode());
    }

    #[test]
    fn wide_chars_take_two_cells() {
        let row = &engine("界x").snapshot().rows[0];
        assert!(row[0].wide && row[0].ch == '界');
        assert_eq!(row[1].ch, ' ');
        assert_eq!(row[2].ch, 'x');
    }
}
