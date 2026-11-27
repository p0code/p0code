//! Reassembly and splitting of oversized WebSocket text frames (`?frameParts=1`).
//!
//! Mirrors `packages/shared/src/socketFrameParts.ts` and `apps/p0d/internal/rpc/wire.go`.
//! Server frames larger than 48 KiB UTF-8 are split into consecutive text frames of at most
//! 48 KiB on UTF-8 character boundaries; every part except the last begins with `U+001E`.

/// Maximum UTF-8 byte length of one frame part on the wire (48 KiB).
pub const SOCKET_FRAME_PART_BYTES: usize = 48 * 1024;

/// Leading record-separator prefix marking a non-final frame part.
pub const PART_PREFIX: char = '\u{001e}';

/// Query parameter name enabling frame parts on `/ws`.
pub const SOCKET_FRAME_PARTS_QUERY_PARAM: &str = "frameParts";

/// Client-side reassembler for `U+001E`-prefixed WebSocket text frame parts.
#[derive(Debug, Default)]
pub struct FramePartAssembler {
    pending: String,
}

impl FramePartAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one incoming WebSocket text frame.
    ///
    /// Returns `Some(complete_json)` when a whole frame is ready, or `None` when more
    /// parts follow. Callers must count *every* frame (whether `Some` or `None`) as
    /// liveness for the 15-second `PING_TIMEOUT`.
    pub fn push(&mut self, text: &str) -> Option<String> {
        if let Some(part) = text.strip_prefix(PART_PREFIX) {
            self.pending.push_str(part);
            None
        } else if self.pending.is_empty() {
            Some(text.to_owned())
        } else {
            self.pending.push_str(text);
            Some(std::mem::take(&mut self.pending))
        }
    }

    /// Returns true if an incomplete multi-part frame is currently buffered.
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Discards any buffered partial frame (e.g. on reconnect).
    pub fn reset(&mut self) {
        self.pending.clear();
    }
}

/// Splits a UTF-8 frame into wire parts of at most `max_bytes` bytes without cutting
/// across a UTF-8 code point. Every part except the last is prefixed with `U+001E`.
pub fn split_socket_frame(frame: &str, max_bytes: usize) -> Vec<String> {
    let min_budget = PART_PREFIX.len_utf8() + 4;
    let limit = max_bytes.max(min_budget);
    if frame.len() <= limit {
        return vec![frame.to_owned()];
    }

    let prefix_len = PART_PREFIX.len_utf8();
    let mut parts = Vec::new();
    let mut remaining = frame;

    while remaining.len() > limit {
        let budget = limit - prefix_len;
        let mut cut = budget.min(remaining.len());
        while cut > 0 && !remaining.is_char_boundary(cut) {
            cut -= 1;
        }
        let mut part = String::with_capacity(prefix_len + cut);
        part.push(PART_PREFIX);
        part.push_str(&remaining[..cut]);
        parts.push(part);
        remaining = &remaining[cut..];
    }

    parts.push(remaining.to_owned());
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_frame_passes_through_without_splitting() {
        let input = r#"{"_tag":"Pong"}"#;
        let parts = split_socket_frame(input, SOCKET_FRAME_PART_BYTES);
        assert_eq!(parts, vec![input]);

        let mut asm = FramePartAssembler::new();
        assert_eq!(asm.push(&parts[0]), Some(input.to_owned()));
        assert!(!asm.has_pending());
    }

    #[test]
    fn splits_and_reassembles_large_ascii_frame() {
        let payload = "a".repeat(SOCKET_FRAME_PART_BYTES * 2 + 123);
        let parts = split_socket_frame(&payload, SOCKET_FRAME_PART_BYTES);
        assert!(parts.len() >= 3);
        for part in &parts[..parts.len() - 1] {
            assert!(part.starts_with(PART_PREFIX));
            assert!(part.len() <= SOCKET_FRAME_PART_BYTES);
        }
        assert!(!parts.last().unwrap().starts_with(PART_PREFIX));
        assert!(parts.last().unwrap().len() <= SOCKET_FRAME_PART_BYTES);

        let mut asm = FramePartAssembler::new();
        for part in &parts[..parts.len() - 1] {
            assert_eq!(asm.push(part), None);
            assert!(asm.has_pending());
        }
        let assembled = asm.push(parts.last().unwrap());
        assert_eq!(assembled.as_deref(), Some(payload.as_str()));
        assert!(!asm.has_pending());
    }

    #[test]
    fn preserves_multibyte_utf8_boundaries() {
        // 4-byte emoji repeated so boundaries fall mid-character.
        let payload = "🚀日本語test".repeat(30);
        let parts = split_socket_frame(&payload, 17);
        assert!(parts.len() > 2);
        for part in &parts {
            assert!(part.len() <= 17);
        }
        let mut asm = FramePartAssembler::new();
        let mut result = None;
        for part in &parts {
            if let Some(done) = asm.push(part) {
                result = Some(done);
            }
        }
        assert_eq!(result.as_deref(), Some(payload.as_str()));
    }
}
