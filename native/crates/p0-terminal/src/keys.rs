#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Enter,
    Backspace,
    Tab,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Delete,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

impl Modifiers {
    fn any(self) -> bool {
        self.shift || self.alt || self.ctrl
    }

    /// xterm's modifier parameter: 1 + shift + 2·alt + 4·ctrl.
    fn param(self) -> u8 {
        1 + u8::from(self.shift) + 2 * u8::from(self.alt) + 4 * u8::from(self.ctrl)
    }
}

pub fn encode_key(key: Key, modifiers: Modifiers, app_cursor_mode: bool) -> Vec<u8> {
    let cursor = |final_byte: char| {
        if modifiers.any() {
            format!("\x1b[1;{}{final_byte}", modifiers.param())
        } else if app_cursor_mode {
            format!("\x1bO{final_byte}")
        } else {
            format!("\x1b[{final_byte}")
        }
    };
    let tilde = |code: u8| {
        if modifiers.any() {
            format!("\x1b[{code};{}~", modifiers.param())
        } else {
            format!("\x1b[{code}~")
        }
    };
    match key {
        Key::Up => cursor('A').into_bytes(),
        Key::Down => cursor('B').into_bytes(),
        Key::Right => cursor('C').into_bytes(),
        Key::Left => cursor('D').into_bytes(),
        Key::Home => cursor('H').into_bytes(),
        Key::End => cursor('F').into_bytes(),
        Key::Delete => tilde(3).into_bytes(),
        Key::PageUp => tilde(5).into_bytes(),
        Key::PageDown => tilde(6).into_bytes(),
        Key::Tab if modifiers.shift => b"\x1b[Z".to_vec(),
        Key::Tab => with_alt(modifiers, vec![b'\t']),
        Key::Enter => with_alt(modifiers, vec![b'\r']),
        Key::Escape => with_alt(modifiers, vec![0x1b]),
        Key::Backspace => with_alt(modifiers, vec![if modifiers.ctrl { 0x08 } else { 0x7f }]),
        Key::Char(ch) => {
            let bytes = match modifiers.ctrl.then(|| control_byte(ch)).flatten() {
                Some(byte) => vec![byte],
                None => ch.to_string().into_bytes(),
            };
            with_alt(modifiers, bytes)
        }
    }
}

fn with_alt(modifiers: Modifiers, mut bytes: Vec<u8>) -> Vec<u8> {
    if modifiers.alt {
        bytes.insert(0, 0x1b);
    }
    bytes
}

fn control_byte(ch: char) -> Option<u8> {
    match ch {
        'a'..='z' | 'A'..='Z' => Some(ch.to_ascii_lowercase() as u8 & 0x1f),
        ' ' | '@' | '2' => Some(0x00),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '-' | '7' => Some(0x1f),
        '?' | '8' => Some(0x7f),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Modifiers = Modifiers {
        shift: false,
        alt: false,
        ctrl: false,
    };
    const CTRL: Modifiers = Modifiers { ctrl: true, ..NONE };
    const ALT: Modifiers = Modifiers { alt: true, ..NONE };
    const SHIFT: Modifiers = Modifiers {
        shift: true,
        ..NONE
    };

    fn enc(key: Key, modifiers: Modifiers, app: bool) -> Vec<u8> {
        encode_key(key, modifiers, app)
    }

    #[test]
    fn plain_keys() {
        let table: [(Key, &[u8]); 9] = [
            (Key::Char('a'), b"a"),
            (Key::Char('界'), "界".as_bytes()),
            (Key::Enter, b"\r"),
            (Key::Backspace, b"\x7f"),
            (Key::Tab, b"\t"),
            (Key::Escape, b"\x1b"),
            (Key::Delete, b"\x1b[3~"),
            (Key::PageUp, b"\x1b[5~"),
            (Key::PageDown, b"\x1b[6~"),
        ];
        for (key, expected) in table {
            assert_eq!(enc(key, NONE, false), expected, "{key:?}");
        }
    }

    #[test]
    fn cursor_keys_follow_app_cursor_mode() {
        let table: [(Key, &[u8], &[u8]); 6] = [
            (Key::Up, b"\x1b[A", b"\x1bOA"),
            (Key::Down, b"\x1b[B", b"\x1bOB"),
            (Key::Right, b"\x1b[C", b"\x1bOC"),
            (Key::Left, b"\x1b[D", b"\x1bOD"),
            (Key::Home, b"\x1b[H", b"\x1bOH"),
            (Key::End, b"\x1b[F", b"\x1bOF"),
        ];
        for (key, normal, app) in table {
            assert_eq!(enc(key, NONE, false), normal, "{key:?}");
            assert_eq!(enc(key, NONE, true), app, "{key:?}");
        }
    }

    #[test]
    fn modified_keys() {
        assert_eq!(enc(Key::Char('c'), CTRL, false), [0x03]);
        assert_eq!(enc(Key::Char('C'), CTRL, false), [0x03]);
        assert_eq!(enc(Key::Char('['), CTRL, false), [0x1b]);
        assert_eq!(enc(Key::Char('b'), ALT, false), b"\x1bb");
        assert_eq!(enc(Key::Backspace, CTRL, false), [0x08]);
        assert_eq!(enc(Key::Tab, SHIFT, false), b"\x1b[Z");
        assert_eq!(enc(Key::Right, CTRL, true), b"\x1b[1;5C");
        assert_eq!(enc(Key::Up, SHIFT, false), b"\x1b[1;2A");
        assert_eq!(enc(Key::Delete, ALT, false), b"\x1b[3;3~");
    }
}
