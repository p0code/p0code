//! Command palette (Cmd/Ctrl+K): fuzzy search over threads, projects and actions.

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use p0_protocol::ModelSelection;

#[derive(Debug, Clone, PartialEq)]
pub enum PaletteAction {
    OpenThread(String),
    NewThreadIn(String),
    NewThread,
    SwitchModel(ModelSelection),
    OpenSettings(&'static str),
    ToggleSidebar,
    FocusComposer,
    ToggleTerminal,
    Reconnect,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PaletteItem {
    pub label: String,
    /// Shown dimmed after the label and matched too (project of a thread, group of an action).
    pub detail: String,
    pub action: PaletteAction,
}

/// Indices of `items` matching `query`, best first. An empty query keeps the given order.
pub fn rank(query: &str, items: &[PaletteItem]) -> Vec<usize> {
    let query = query.trim();
    if query.is_empty() {
        return (0..items.len()).collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut buf = Vec::new();
    let mut scored: Vec<(usize, u32)> = items
        .iter()
        .enumerate()
        .filter_map(|(ix, item)| {
            let haystack = format!("{} {}", item.label, item.detail);
            pattern
                .score(Utf32Str::new(&haystack, &mut buf), &mut matcher)
                .map(|score| (ix, score))
        })
        .collect();
    // Stable on ties, so equally good matches keep their recency order.
    scored.sort_by_key(|&(_, score)| std::cmp::Reverse(score));
    scored.into_iter().map(|(ix, _)| ix).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(label: &str, detail: &str) -> PaletteItem {
        PaletteItem {
            label: label.to_owned(),
            detail: detail.to_owned(),
            action: PaletteAction::NewThread,
        }
    }

    #[test]
    fn fuzzy_ranks_best_match_first() {
        let items = [
            item("Fix login redirect", "web"),
            item("Open settings: Appearance", "Settings"),
            item("Refactor settings store", "p0code"),
        ];
        let ranked = rank("setap", &items);
        assert_eq!(ranked.first(), Some(&1));
        assert!(!ranked.contains(&0));
        assert_eq!(rank("p0code", &items), vec![2]);
        assert_eq!(rank("  ", &items), vec![0, 1, 2]);
        assert!(rank("zzzz", &items).is_empty());
    }
}
