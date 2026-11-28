//! Worktrees settings (`/settings/worktrees`): worktree directory, start-from-remote, submodules,
//! branch naming (mode/prefix/instructions), and automatic worktree cleanup rules via
//! `server.updateSettings`.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use serde_json::{Value, json};

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::general::section_heading;
use crate::settings::setting_row;
use crate::theme::AppPalette;

const MAX_RETENTION_DAYS: u64 = 3650;
const DEFAULT_RETENTION_DAYS: u64 = 8;

#[derive(Default)]
pub struct WorktreesUiState {
    dir_input: Option<Entity<InputState>>,
    branch_prefix_input: Option<Entity<InputState>>,
    branch_instructions_input: Option<Entity<InputState>>,
    inactive_days_input: Option<Entity<InputState>>,
    settled_days_input: Option<Entity<InputState>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreesServerSettings {
    pub worktrees_directory: String,
    pub new_worktrees_start_from_origin: bool,
    pub worktree_submodules: Option<String>,
    pub branch_naming_mode: String,
    pub branch_name_prefix: String,
    pub branch_name_instructions: String,
    pub worktree_on_delete: bool,
    pub worktree_on_merge: bool,
    pub worktree_after_days: Option<u64>,
    pub worktree_settled_after_days: Option<u64>,
    pub worktree_unchanged: bool,
    pub worktree_keep_when: String,
}

impl WorktreesServerSettings {
    pub fn from_json(settings: &Value) -> Self {
        let bool_or = |key: &str, default: bool| {
            settings
                .get(key)
                .and_then(Value::as_bool)
                .unwrap_or(default)
        };
        let str_or = |key: &str, default: &str| {
            settings
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or(default)
                .to_owned()
        };
        let sc = settings.get("storageCleanup");
        let sc_bool = |key: &str| {
            sc.and_then(|v| v.get(key))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        Self {
            worktrees_directory: str_or("worktreesDirectory", ""),
            new_worktrees_start_from_origin: bool_or("newWorktreesStartFromOrigin", true),
            worktree_submodules: settings
                .get("worktreeSubmodules")
                .and_then(Value::as_str)
                .map(str::to_owned),
            branch_naming_mode: str_or("branchNamingMode", "static"),
            branch_name_prefix: str_or("branchNamePrefix", "t3"),
            branch_name_instructions: str_or("branchNameInstructions", ""),
            worktree_on_delete: sc_bool("worktreeOnDelete"),
            worktree_on_merge: sc_bool("worktreeOnMerge"),
            worktree_after_days: sc
                .and_then(|v| v.get("worktreeAfterDays"))
                .and_then(Value::as_u64),
            worktree_settled_after_days: sc
                .and_then(|v| v.get("worktreeSettledAfterDays"))
                .and_then(Value::as_u64),
            worktree_unchanged: sc_bool("worktreeUnchanged"),
            worktree_keep_when: sc
                .and_then(|v| v.get("worktreeKeepWhen"))
                .and_then(Value::as_str)
                .unwrap_or("uncommitted-changes")
                .to_owned(),
        }
    }
}

pub fn parse_worktree_days(raw: &str, min: u64) -> Option<u64> {
    let val = raw.trim().parse::<u64>().ok()?;
    (min..=MAX_RETENTION_DAYS).contains(&val).then_some(val)
}

impl P0App {
    pub(crate) fn render_worktrees_settings(
        &mut self,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let Some(settings) = self.bridge.server_settings() else {
            return div()
                .text_sm()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(
                    self.i18n.get(p0_i18n::Key::Loading).to_owned(),
                ));
        };
        let wt = WorktreesServerSettings::from_json(&settings);
        let mut col = div().flex().flex_col().gap(px(12.0));

        // 1. Creation
        col = col.child(section_heading(self.i18n.tr("Creation"), palette));
        let dir_val = wt.worktrees_directory.clone();
        let dir_placeholder = self.i18n.tr("Default (T3 home)").to_owned();
        let dir_in = self
            .settings_ui
            .worktrees
            .dir_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder(dir_placeholder);
                    st.set_value(dir_val, window, cx);
                    st
                })
            })
            .clone();
        let save_dir = dir_in.clone();
        col = col.child(setting_row(
            self.i18n.tr("Worktree location"),
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().w(px(240.0)).child(Input::new(&dir_in)))
                .child(
                    Button::new("wt-dir-save")
                        .label(self.i18n.tr("Save").to_owned())
                        .compact()
                        .primary()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let val = save_dir.read(cx).value().trim().to_owned();
                            this.bridge
                                .update_settings(json!({ "worktreesDirectory": val }));
                            cx.notify();
                        })),
                ),
            palette,
        ));
        col = col.child(setting_row(
            self.i18n.tr("Start new worktrees from remote by default"),
            Switch::new("wt-start-from-origin")
                .checked(wt.new_worktrees_start_from_origin)
                .on_click(cx.listener(|this, val: &bool, _, cx| {
                    this.bridge
                        .update_settings(json!({ "newWorktreesStartFromOrigin": *val }));
                    cx.notify();
                })),
            palette,
        ));
        let mut sub_row = div().flex().flex_wrap().gap(px(6.0));
        for (val, label) in [
            (None, "Default"),
            (Some("recursive"), "Recursive"),
            (Some("top-level"), "Top-level"),
            (Some("none"), "None"),
        ] {
            let selected = wt.worktree_submodules.as_deref() == val;
            sub_row = sub_row.child(
                choice(
                    format!("wt-sub-{}", val.unwrap_or("default")),
                    self.i18n.tr(label).to_owned(),
                    selected,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    let patch = match val {
                        Some(v) => json!(v),
                        None => Value::Null,
                    };
                    this.bridge
                        .update_settings(json!({ "worktreeSubmodules": patch }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Worktree submodules"),
            sub_row,
            palette,
        ));

        // 2. Branches
        col = col.child(section_heading(self.i18n.tr("Branches"), palette));
        let mut naming_row = div().flex().flex_wrap().gap(px(6.0));
        for (mode, label) in [
            ("static", "Static prefix"),
            ("semantic", "Semantic prefix"),
            ("custom", "Custom instructions"),
        ] {
            naming_row = naming_row.child(
                choice(
                    format!("wt-branch-mode-{mode}"),
                    self.i18n.tr(label).to_owned(),
                    wt.branch_naming_mode == mode,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bridge
                        .update_settings(json!({ "branchNamingMode": mode }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Worktree branch naming"),
            naming_row,
            palette,
        ));

        if wt.branch_naming_mode == "static" {
            let prefix_val = wt.branch_name_prefix.clone();
            let prefix_placeholder = self.i18n.tr("No prefix").to_owned();
            let prefix_in = self
                .settings_ui
                .worktrees
                .branch_prefix_input
                .get_or_insert_with(|| {
                    cx.new(|cx| {
                        let mut st = InputState::new(window, cx).placeholder(prefix_placeholder);
                        st.set_value(prefix_val, window, cx);
                        st
                    })
                })
                .clone();
            let save_prefix = prefix_in.clone();
            col = col.child(setting_row(
                self.i18n.tr("Branch prefix"),
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().w(px(180.0)).child(Input::new(&prefix_in)))
                    .child(
                        Button::new("wt-prefix-save")
                            .label(self.i18n.tr("Save").to_owned())
                            .compact()
                            .primary()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let val = save_prefix.read(cx).value().trim().to_owned();
                                this.bridge
                                    .update_settings(json!({ "branchNamePrefix": val }));
                                cx.notify();
                            })),
                    ),
                palette,
            ));
        } else if wt.branch_naming_mode == "custom" {
            let instr_val = wt.branch_name_instructions.clone();
            let instr_placeholder = self.i18n.tr("Instructions for branch naming").to_owned();
            let instr_in = self
                .settings_ui
                .worktrees
                .branch_instructions_input
                .get_or_insert_with(|| {
                    cx.new(|cx| {
                        let mut st = InputState::new(window, cx).placeholder(instr_placeholder);
                        st.set_value(instr_val, window, cx);
                        st
                    })
                })
                .clone();
            let save_instr = instr_in.clone();
            col = col.child(setting_row(
                self.i18n.tr("Branch naming instructions"),
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().w(px(260.0)).child(Input::new(&instr_in)))
                    .child(
                        Button::new("wt-instr-save")
                            .label(self.i18n.tr("Save").to_owned())
                            .compact()
                            .primary()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let val = save_instr.read(cx).value().trim().to_owned();
                                this.bridge
                                    .update_settings(json!({ "branchNameInstructions": val }));
                                cx.notify();
                            })),
                    ),
                palette,
            ));
        }

        // 3. Cleanup
        col = col.child(section_heading(self.i18n.tr("Cleanup"), palette));
        for (key, label, checked) in [
            (
                "worktreeOnDelete",
                "Delete worktrees with deleted threads",
                wt.worktree_on_delete,
            ),
            (
                "worktreeOnMerge",
                "Delete merged worktrees",
                wt.worktree_on_merge,
            ),
            (
                "worktreeUnchanged",
                "Delete unchanged worktrees",
                wt.worktree_unchanged,
            ),
        ] {
            col = col.child(setting_row(
                self.i18n.tr(label),
                Switch::new(SharedString::from(format!("wt-cleanup-{key}")))
                    .checked(checked)
                    .on_click(cx.listener(move |this, val: &bool, _, cx| {
                        this.bridge
                            .update_settings(json!({ "storageCleanup": { key: *val } }));
                        cx.notify();
                    })),
                palette,
            ));
        }

        let inactive_str = wt
            .worktree_after_days
            .unwrap_or(DEFAULT_RETENTION_DAYS)
            .to_string();
        let inactive_in = self
            .settings_ui
            .worktrees
            .inactive_days_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder("8");
                    st.set_value(inactive_str, window, cx);
                    st
                })
            })
            .clone();
        col = col.child(self.render_wt_days_row(
            "worktreeAfterDays",
            "Delete inactive worktrees",
            wt.worktree_after_days,
            1,
            inactive_in,
            palette,
            cx,
        ));

        let settled_str = wt
            .worktree_settled_after_days
            .unwrap_or(DEFAULT_RETENTION_DAYS)
            .to_string();
        let settled_in = self
            .settings_ui
            .worktrees
            .settled_days_input
            .get_or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder("8");
                    st.set_value(settled_str, window, cx);
                    st
                })
            })
            .clone();
        col = col.child(self.render_wt_days_row(
            "worktreeSettledAfterDays",
            "Delete settled worktrees",
            wt.worktree_settled_after_days,
            0,
            settled_in,
            palette,
            cx,
        ));

        let mut keep_row = div().flex().flex_wrap().gap(px(6.0));
        for (val, label) in [
            ("any-local-files", "Any local files"),
            ("uncommitted-changes", "Uncommitted changes"),
            ("tracked-changes", "Edited tracked files"),
        ] {
            keep_row = keep_row.child(
                choice(
                    format!("wt-keep-{val}"),
                    self.i18n.tr(label).to_owned(),
                    wt.worktree_keep_when == val,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bridge
                        .update_settings(json!({ "storageCleanup": { "worktreeKeepWhen": val } }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Keep worktrees with local changes"),
            keep_row,
            palette,
        ));

        col
    }

    #[allow(clippy::too_many_arguments)]
    fn render_wt_days_row(
        &self,
        key: &'static str,
        label: &'static str,
        value: Option<u64>,
        min_days: u64,
        input: Entity<InputState>,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let enabled = value.is_some();
        let save_in = input.clone();
        let toggle_in = input.clone();
        let mut controls = div().flex().items_center().gap(px(8.0));
        if enabled {
            controls = controls
                .child(div().w(px(68.0)).child(Input::new(&input)))
                .child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(self.i18n.tr("days").to_owned())),
                )
                .child(
                    Button::new(SharedString::from(format!("wt-save-{key}")))
                        .label(self.i18n.tr("Save").to_owned())
                        .compact()
                        .primary()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let raw = save_in.read(cx).value().to_string();
                            if let Some(days) = parse_worktree_days(&raw, min_days) {
                                this.bridge
                                    .update_settings(json!({ "storageCleanup": { key: days } }));
                                cx.notify();
                            }
                        })),
                );
        } else {
            controls = controls.child(
                div()
                    .text_xs()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(self.i18n.tr("Off").to_owned())),
            );
        }
        controls = controls.child(
            Switch::new(SharedString::from(format!("wt-toggle-{key}")))
                .checked(enabled)
                .on_click(cx.listener(move |this, on: &bool, _, cx| {
                    let next = if *on {
                        let raw = toggle_in.read(cx).value().to_string();
                        json!(parse_worktree_days(&raw, min_days).unwrap_or(DEFAULT_RETENTION_DAYS))
                    } else {
                        Value::Null
                    };
                    this.bridge
                        .update_settings(json!({ "storageCleanup": { key: next } }));
                    cx.notify();
                })),
        );
        setting_row(self.i18n.tr(label), controls, palette)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_settings_and_cleanup_days() {
        let defaults = WorktreesServerSettings::from_json(&json!({}));
        assert!(defaults.new_worktrees_start_from_origin);
        assert_eq!(defaults.branch_naming_mode, "static");
        assert_eq!(defaults.branch_name_prefix, "t3");
        assert_eq!(defaults.worktree_keep_when, "uncommitted-changes");

        let custom = WorktreesServerSettings::from_json(&json!({
            "worktreesDirectory": "/tmp/wt",
            "newWorktreesStartFromOrigin": false,
            "worktreeSubmodules": "recursive",
            "branchNamingMode": "semantic",
            "storageCleanup": {
                "worktreeOnDelete": true,
                "worktreeOnMerge": true,
                "worktreeAfterDays": 14,
                "worktreeSettledAfterDays": 0,
                "worktreeUnchanged": true,
                "worktreeKeepWhen": "tracked-changes"
            }
        }));
        assert_eq!(custom.worktrees_directory, "/tmp/wt");
        assert!(!custom.new_worktrees_start_from_origin);
        assert_eq!(custom.worktree_submodules.as_deref(), Some("recursive"));
        assert_eq!(custom.branch_naming_mode, "semantic");
        assert!(custom.worktree_on_delete);
        assert!(custom.worktree_on_merge);
        assert_eq!(custom.worktree_after_days, Some(14));
        assert_eq!(custom.worktree_settled_after_days, Some(0));
        assert!(custom.worktree_unchanged);
        assert_eq!(custom.worktree_keep_when, "tracked-changes");

        assert_eq!(parse_worktree_days("0", 1), None);
        assert_eq!(parse_worktree_days("0", 0), Some(0));
        assert_eq!(parse_worktree_days("3650", 1), Some(3650));
        assert_eq!(parse_worktree_days("3651", 1), None);
    }
}
