mod alacritty;
mod keys;
pub mod rpc;

pub use alacritty::AlacrittyEngine;
pub use keys::{Key, Modifiers, encode_key};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TermColor {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub fg: TermColor,
    pub bg: TermColor,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    /// The glyph spans this cell and the next; the next cell is a blank spacer.
    pub wide: bool,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            ch: ' ',
            fg: TermColor::Default,
            bg: TermColor::Default,
            bold: false,
            italic: false,
            underline: false,
            inverse: false,
            wide: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cursor {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScreenSnapshot {
    pub rows: Vec<Vec<Cell>>,
    pub cursor: Cursor,
    pub title: Option<String>,
    /// Lines scrolled back into history; 0 shows the live screen.
    pub display_offset: usize,
}

impl ScreenSnapshot {
    pub fn row_text(&self, row: usize) -> String {
        self.rows
            .get(row)
            .map(|cells| cells.iter().map(|cell| cell.ch).collect::<String>())
            .unwrap_or_default()
            .trim_end()
            .to_owned()
    }
}

pub trait TerminalEngine {
    fn feed(&mut self, bytes: &[u8]);
    fn resize(&mut self, cols: u16, rows: u16);
    fn size(&self) -> (u16, u16);
    fn snapshot(&self) -> ScreenSnapshot;
    /// Positive deltas scroll back into history, negative toward the live screen.
    fn scroll_display(&mut self, delta_lines: i32);
    fn app_cursor_mode(&self) -> bool;
    /// Replies the terminal owes the PTY (DA, DSR, ...), drained on each call.
    fn take_pty_writes(&mut self) -> Vec<u8>;
}
