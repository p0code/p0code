//! Keybindings settings (`/settings/keybindings`): reads resolved keybindings from
//! `server.getConfig` and writes changes via `server.upsertKeybinding` / `server.removeKeybinding`.

use std::collections::BTreeMap;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription,
    Window, div, px,
};
use p0_protocol::{
    KeybindingReplaceTarget, ResolvedKeybindingRule, ServerRemoveKeybindingInput,
    ServerUpsertKeybindingInput,
};

use crate::app::P0App;
use crate::theme::AppPalette;

#[derive(Default)]
pub struct KeybindingsUiState {
    search_input: Option<(Entity<InputState>, Subscription)>,
    editing: Option<EditingBinding>,
    adding: Option<NewBindingForm>,
}

struct EditingBinding {
    row_id: String,
    command: String,
    original_key: String,
    original_when: String,
    key_input: Entity<InputState>,
    when_input: Entity<InputState>,
}

struct NewBindingForm {
    command_input: Entity<InputState>,
    key_input: Entity<InputState>,
    when_input: Entity<InputState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeybindingRow {
    pub id: String,
    pub command: String,
    pub label: String,
    pub wire_key: String,
    pub display_key: String,
    pub when: String,
    pub is_unassigned: bool,
    pub is_project_script: bool,
    pub group: &'static str,
}

const GROUP_ORDER: [&str; 8] = [
    "Navigation",
    "Threads",
    "Composer",
    "Terminal",
    "Preview & diff",
    "Appearance",
    "Project scripts",
    "Other",
];

pub fn command_group(command: &str) -> &'static str {
    let prefix = command.split('.').next().unwrap_or("");
    match prefix {
        "navigation" | "sidebar" | "rightPanel" | "commandPalette" | "filePicker"
        | "projectSearch" | "editor" | "workspace" | "view" => "Navigation",
        "thread" | "chat" | "pullRequest" => "Threads",
        "composer" | "modelPicker" => "Composer",
        "terminal" => "Terminal",
        "preview" | "diff" => "Preview & diff",
        "theme" | "appearance" | "themeEditor" | "accountProfile" => "Appearance",
        "script" => "Project scripts",
        _ => "Other",
    }
}

pub fn command_label(command: &str) -> String {
    let known = match command {
        "workspace.focusNext" => Some("Focus Next Workspace Area"),
        "workspace.focusPrevious" => Some("Focus Previous Workspace Area"),
        "sidebar.toggle" => Some("Sidebar: Toggle"),
        "navigation.back" => Some("Navigation: Back"),
        "navigation.forward" => Some("Navigation: Forward"),
        "terminal.toggle" => Some("Terminal: Toggle"),
        "terminal.split" => Some("Terminal: Split"),
        "terminal.splitVertical" => Some("Terminal: Split Vertical"),
        "terminal.new" => Some("Terminal: New"),
        "terminal.close" => Some("Terminal: Close"),
        "terminal.previous" => Some("Terminal: Previous"),
        "terminal.next" => Some("Terminal: Next"),
        "rightPanel.toggle" => Some("Right Panel: Toggle"),
        "rightPanel.new" => Some("Right Panel: New"),
        "threadPanel.toggle" => Some("Thread Panel: Toggle"),
        "rightPanel.toggleMaximized" => Some("Right Panel: Toggle Maximized"),
        "rightPanel.close" => Some("Right Panel: Close"),
        "view.reopenClosed" => Some("Reopen Closed Tab"),
        "pullRequest.copyNumber" => Some("Pull Request: Copy Number"),
        "diff.toggle" => Some("Diff: Toggle"),
        "preview.toggle" => Some("Preview: Toggle"),
        "preview.refresh" => Some("Preview: Refresh"),
        "preview.focusUrl" => Some("Preview: Focus URL"),
        "preview.zoomIn" => Some("Preview: Zoom In"),
        "preview.zoomOut" => Some("Preview: Zoom Out"),
        "preview.resetZoom" => Some("Preview: Reset Zoom"),
        "preview.find" => Some("Preview: Find on Page"),
        "commandPalette.toggle" => Some("Command Palette: Toggle"),
        "filePicker.toggle" => Some("File Picker: Toggle"),
        "projectSearch.toggle" => Some("Project Search: Toggle"),
        "usage.open" => Some("Usage: Toggle"),
        "usage.cost" => Some("Usage: Cost"),
        "usage.tokens" => Some("Usage: Tokens"),
        "usage.limits" => Some("Usage: Limits"),
        "usage.period.day" => Some("Usage: Period: Past 24h"),
        "usage.period.week" => Some("Usage: Period: 7 days"),
        "usage.period.month" => Some("Usage: Period: 30 days"),
        "usage.period.quarter" => Some("Usage: Period: 90 days"),
        "theme.select" => Some("Theme: Select"),
        "appearance.cycle" => Some("Appearance: Cycle"),
        "accountProfile.cycle" => Some("Account Profile: Cycle"),
        "themeEditor.toggle" => Some("Theme Editor: Toggle"),
        "composer.stash" => Some("Composer: Stash"),
        "composer.sendAlternate" => Some("Composer: Opposite Queue or Steer Action"),
        "composer.sendBackground" => Some("Composer: Start in Background"),
        "composer.sendAndNewThread" => Some("Composer: Send and Start New Thread"),
        "composer.dictation" => Some("Composer: Start or Finish Dictation"),
        "composer.host" => Some("Composer: Host"),
        "composer.cycleHost" => Some("Composer: Cycle Host"),
        "composer.effort" => Some("Composer: Effort"),
        "composer.increaseEffort" => Some("Composer: Increase Effort"),
        "composer.decreaseEffort" => Some("Composer: Decrease Effort"),
        "composer.mode" => Some("Composer: Mode"),
        "composer.workspace" => Some("Composer: Workspace"),
        "composer.previousWorktree" => Some("Composer: Previous Worktree"),
        "composer.branch" => Some("Composer: Branch"),
        "chat.new" => Some("Chat: New"),
        "chat.newLocal" => Some("Chat: New Local"),
        "chat.newWithoutProject" => Some("Chat: New Without Project"),
        "chat.find" => Some("Chat: Find"),
        "editor.openFavorite" => Some("Editor: Open Favorite"),
        "modelPicker.toggle" => Some("Model Picker: Toggle"),
        "modelPicker.previousProvider" => Some("Model Picker: Previous Provider"),
        "modelPicker.nextProvider" => Some("Model Picker: Next Provider"),
        "thread.stop" => Some("Thread: Stop"),
        "thread.steerQueuedMessage" => Some("Queue: Send First Queued Message"),
        "thread.editQueuedMessage" => Some("Queue: Edit Last Queued Message"),
        "thread.previous" => Some("Thread: Previous"),
        "thread.next" => Some("Thread: Next"),
        "thread.copyReference" => Some("Pull Request: Copy Link or Thread"),
        "thread.settle" => Some("Thread: Settle"),
        "thread.pin" => Some("Thread: Pin"),
        "thread.hide" => Some("Thread: Hide or Bring Back"),
        "thread.regenerateTitle" => Some("Thread: Regenerate Title"),
        "thread.undo" => Some("Thread: Undo"),
        _ => None,
    };
    if let Some(label) = known {
        return label.to_owned();
    }
    if let Some(n) = command.strip_prefix("thread.jump.") {
        return format!("Thread: Jump: {n}");
    }
    if let Some(n) = command.strip_prefix("modelPicker.jump.") {
        return format!("Model Picker: Jump: {n}");
    }
    if let Some(rest) = command
        .strip_prefix("script.")
        .and_then(|s| s.strip_suffix(".run"))
    {
        return format!("Run Script: {}", title_case_segment(rest));
    }
    command
        .split('.')
        .map(title_case_segment)
        .collect::<Vec<_>>()
        .join(": ")
}

fn title_case_segment(segment: &str) -> String {
    let mut words = Vec::new();
    for part in segment.split(['-', '_', ' ']) {
        if part.is_empty() {
            continue;
        }
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            let mut word = first.to_uppercase().to_string();
            word.push_str(chars.as_str());
            words.push(word);
        }
    }
    words.join(" ")
}

pub fn build_rows(rules: &[ResolvedKeybindingRule]) -> Vec<KeybindingRow> {
    let mut by_id = BTreeMap::new();
    for rule in rules {
        let wire_key = rule.shortcut.to_wire_key();
        let when = rule
            .when_ast
            .as_ref()
            .map(|n| n.to_expression())
            .unwrap_or_default();
        let id = format!("{}\0{}\0{}", rule.command, wire_key, when);
        by_id.insert(
            id.clone(),
            KeybindingRow {
                id,
                command: rule.command.clone(),
                label: command_label(&rule.command),
                display_key: rule.shortcut.display_label(),
                wire_key,
                is_unassigned: when == "false",
                when,
                is_project_script: rule.command.starts_with("script."),
                group: command_group(&rule.command),
            },
        );
    }
    let mut rows: Vec<KeybindingRow> = by_id.into_values().collect();
    rows.sort_by(|a, b| a.command.cmp(&b.command).then(a.wire_key.cmp(&b.wire_key)));
    rows
}

pub fn filter_rows(rows: Vec<KeybindingRow>, query: &str) -> Vec<KeybindingRow> {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return rows;
    }
    rows.into_iter()
        .filter(|row| {
            row.command.to_ascii_lowercase().contains(&q)
                || row.label.to_ascii_lowercase().contains(&q)
                || row.wire_key.to_ascii_lowercase().contains(&q)
                || row.display_key.to_ascii_lowercase().contains(&q)
                || row.when.to_ascii_lowercase().contains(&q)
        })
        .collect()
}

pub fn group_rows(rows: Vec<KeybindingRow>) -> Vec<(&'static str, Vec<KeybindingRow>)> {
    let mut buckets: BTreeMap<&'static str, Vec<KeybindingRow>> = BTreeMap::new();
    for row in rows {
        buckets.entry(row.group).or_default().push(row);
    }
    GROUP_ORDER
        .iter()
        .filter_map(|group| buckets.remove(group).map(|items| (*group, items)))
        .collect()
}

impl P0App {
    pub(crate) fn render_keybindings(
        &mut self,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let search_input = if let Some((input, _)) = &self.settings_ui.keybindings.search_input {
            input.clone()
        } else {
            let placeholder = self.i18n.tr("Search keybindings").to_owned();
            let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
            let sub = cx.subscribe_in(&input, window, |_, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            });
            self.settings_ui.keybindings.search_input = Some((input.clone(), sub));
            input
        };
        let query = search_input.read(cx).value().to_string();

        let Some(config) = self.bridge.server_config() else {
            return div()
                .text_sm()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(
                    self.i18n.get(p0_i18n::Key::Loading).to_owned(),
                ));
        };

        let mut col = div().flex().flex_col().gap(px(14.0));

        // Toolbar: search input + Add keybinding button
        let is_adding = self.settings_ui.keybindings.adding.is_some();
        col = col.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().flex_1().min_w_0().child(Input::new(&search_input)))
                .child(
                    Button::new("kb-add-toggle")
                        .label(self.i18n.tr("Add keybinding").to_owned())
                        .compact()
                        .outline()
                        .on_click(cx.listener(|this, _, window, cx| {
                            if this.settings_ui.keybindings.adding.is_some() {
                                this.settings_ui.keybindings.adding = None;
                            } else {
                                this.settings_ui.keybindings.editing = None;
                                let command_input = cx.new(|cx| {
                                    InputState::new(window, cx).placeholder("commandPalette.toggle")
                                });
                                command_input.update(cx, |s, cx| s.focus(window, cx));
                                this.settings_ui.keybindings.adding = Some(NewBindingForm {
                                    command_input,
                                    key_input: cx
                                        .new(|cx| InputState::new(window, cx).placeholder("mod+k")),
                                    when_input: cx.new(|cx| {
                                        InputState::new(window, cx).placeholder(
                                            "Optional when clause (e.g. !terminalFocus)",
                                        )
                                    }),
                                });
                            }
                            cx.notify();
                        })),
                ),
        );

        if let Some(path) = config.keybindings_config_path.as_deref() {
            col = col.child(
                div()
                    .text_xs()
                    .font_family("monospace")
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(path.to_owned())),
            );
        }

        if !config.issues.is_empty() {
            let mut issues_box = crate::feed::card(palette)
                .border_color(palette.warning)
                .bg(palette.warning_surface);
            for issue in &config.issues {
                let msg = issue
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Invalid keybindings configuration entry");
                issues_box = issues_box.child(
                    div()
                        .text_xs()
                        .text_color(palette.warning)
                        .child(SharedString::from(msg.to_owned())),
                );
            }
            col = col.child(issues_box);
        }

        if is_adding && let Some(form) = &self.settings_ui.keybindings.adding {
            let cmd_in = form.command_input.clone();
            let key_in = form.key_input.clone();
            let when_in = form.when_input.clone();
            col = col.child(
                crate::feed::card(palette)
                    .border_color(palette.primary)
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(
                        SharedString::from(self.i18n.tr("New keybinding").to_owned()),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(palette.muted_foreground)
                                    .child(SharedString::from(self.i18n.tr("Command").to_owned())),
                            )
                            .child(Input::new(&cmd_in))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(palette.muted_foreground)
                                    .child("Shortcut (e.g. mod+k, ctrl+shift+p)"),
                            )
                            .child(Input::new(&key_in))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(palette.muted_foreground)
                                    .child(SharedString::from(self.i18n.tr("When").to_owned())),
                            )
                            .child(Input::new(&when_in)),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .pt(px(4.0))
                            .child(
                                Button::new("kb-new-save")
                                    .label(self.i18n.tr("Save").to_owned())
                                    .compact()
                                    .primary()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.save_new_keybinding(cx);
                                    })),
                            )
                            .child(
                                Button::new("kb-new-cancel")
                                    .label(self.i18n.tr("Cancel").to_owned())
                                    .compact()
                                    .outline()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.settings_ui.keybindings.adding = None;
                                        cx.notify();
                                    })),
                            ),
                    ),
            );
        }

        let rows = filter_rows(build_rows(&config.keybindings), &query);
        let groups = group_rows(rows);
        if groups.is_empty() {
            return col.child(
                div()
                    .py(px(16.0))
                    .text_sm()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(
                        self.i18n.tr("No keybindings match your search.").to_owned(),
                    )),
            );
        }

        for (group_name, items) in groups {
            let mut section_box = div().flex().flex_col().gap(px(4.0)).child(
                div()
                    .pt(px(8.0))
                    .pb(px(4.0))
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(self.i18n.tr(group_name).to_owned())),
            );
            for (ix, row) in items.into_iter().enumerate() {
                section_box =
                    section_box.child(self.render_keybinding_row(group_name, ix, row, palette, cx));
            }
            col = col.child(section_box);
        }
        col
    }

    fn render_keybinding_row(
        &self,
        group_name: &'static str,
        ix: usize,
        row: KeybindingRow,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let is_editing = self
            .settings_ui
            .keybindings
            .editing
            .as_ref()
            .is_some_and(|e| e.row_id == row.id);

        let mut card = div()
            .px(px(12.0))
            .py(px(8.0))
            .rounded(px(6.0))
            .bg(palette.card)
            .border_1()
            .border_color(if is_editing {
                palette.primary
            } else {
                palette.border
            })
            .flex()
            .flex_col()
            .gap(px(6.0));

        let mut header_left = div()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .min_w_0()
            .flex_1()
            .child(
                div()
                    .flex()
                    .items_center()
                    .min_w_0()
                    .gap(px(6.0))
                    .child(
                        div()
                            .min_w_0()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.foreground)
                            .truncate()
                            .child(SharedString::from(row.label.clone())),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_shrink(1.0)
                            .text_xs()
                            .font_family("monospace")
                            .text_color(palette.muted_foreground)
                            .truncate()
                            .child(SharedString::from(row.command.clone())),
                    ),
            );
        if row.is_unassigned {
            header_left = header_left.child(
                div()
                    .text_xs()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(self.i18n.tr("Unassigned").to_owned())),
            );
        } else if !row.when.is_empty() {
            header_left = header_left.child(
                div()
                    .text_xs()
                    .font_family("monospace")
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(format!("when: {}", row.when))),
            );
        }

        let row_for_edit = row.clone();
        let row_for_unassign = row.clone();
        let row_for_remove = row.clone();
        let mut actions = div().flex().items_center().gap(px(6.0)).flex_none();

        if !is_editing {
            let pill_text = if row.is_unassigned {
                self.i18n.tr("Unassigned").to_owned()
            } else {
                row.display_key.clone()
            };
            actions = actions
                .child(
                    div()
                        .id(SharedString::from(format!("kb-pill-{group_name}-{ix}")))
                        .px(px(8.0))
                        .py(px(3.0))
                        .rounded(px(4.0))
                        .bg(palette.code_bg)
                        .border_1()
                        .border_color(palette.border)
                        .font_family("monospace")
                        .text_xs()
                        .text_color(if row.is_unassigned {
                            palette.muted_foreground
                        } else {
                            palette.foreground
                        })
                        .cursor_pointer()
                        .hover(|s| s.border_color(palette.primary))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.start_editing_keybinding(&row_for_edit, window, cx);
                        }))
                        .child(SharedString::from(pill_text)),
                )
                .child(
                    Button::new(SharedString::from(format!("kb-remove-{group_name}-{ix}")))
                        .label(if row.is_unassigned {
                            self.i18n.tr("Remove").to_owned()
                        } else {
                            self.i18n.tr("Unassign").to_owned()
                        })
                        .compact()
                        .outline()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if row_for_unassign.is_unassigned || row_for_unassign.is_project_script
                            {
                                this.bridge.remove_keybinding(ServerRemoveKeybindingInput {
                                    key: row_for_remove.wire_key.clone(),
                                    command: row_for_remove.command.clone(),
                                    when: (!row_for_remove.when.is_empty())
                                        .then(|| row_for_remove.when.clone()),
                                });
                            } else {
                                this.bridge.upsert_keybinding(ServerUpsertKeybindingInput {
                                    key: row_for_unassign.wire_key.clone(),
                                    command: row_for_unassign.command.clone(),
                                    when: Some("false".to_owned()),
                                    replace: Some(KeybindingReplaceTarget {
                                        key: row_for_unassign.wire_key.clone(),
                                        command: row_for_unassign.command.clone(),
                                        when: (!row_for_unassign.when.is_empty())
                                            .then(|| row_for_unassign.when.clone()),
                                    }),
                                });
                            }
                            cx.notify();
                        })),
                );
        }

        card = card.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(header_left)
                .child(actions),
        );

        if is_editing && let Some(edit) = &self.settings_ui.keybindings.editing {
            let key_in = edit.key_input.clone();
            let when_in = edit.when_input.clone();
            let row_remove = row.clone();
            card =
                card.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .pt(px(4.0))
                        .border_t_1()
                        .border_color(palette.border)
                        .child(
                            div()
                                .flex()
                                .gap(px(8.0))
                                .child(div().flex_1().child(Input::new(&key_in)))
                                .child(div().flex_1().child(Input::new(&when_in))),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(6.0))
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "kb-save-{group_name}-{ix}"
                                    )))
                                    .label(self.i18n.tr("Save").to_owned())
                                    .compact()
                                    .primary()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.save_edited_keybinding(cx);
                                    })),
                                )
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "kb-cancel-{group_name}-{ix}"
                                    )))
                                    .label(self.i18n.tr("Cancel").to_owned())
                                    .compact()
                                    .outline()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.settings_ui.keybindings.editing = None;
                                        cx.notify();
                                    })),
                                )
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "kb-del-{group_name}-{ix}"
                                    )))
                                    .label(self.i18n.tr("Remove").to_owned())
                                    .compact()
                                    .danger()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.settings_ui.keybindings.editing = None;
                                        this.bridge.remove_keybinding(
                                            ServerRemoveKeybindingInput {
                                                key: row_remove.wire_key.clone(),
                                                command: row_remove.command.clone(),
                                                when: (!row_remove.when.is_empty())
                                                    .then(|| row_remove.when.clone()),
                                            },
                                        );
                                        cx.notify();
                                    })),
                                ),
                        ),
                );
        }

        card
    }

    fn start_editing_keybinding(
        &mut self,
        row: &KeybindingRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.settings_ui.keybindings.adding = None;
        let initial_key = row.wire_key.clone();
        let initial_when = if row.is_unassigned {
            String::new()
        } else {
            row.when.clone()
        };
        let key_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("mod+k");
            state.set_value(initial_key, window, cx);
            state
        });
        key_input.update(cx, |s, cx| s.focus(window, cx));
        let when_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("When (optional)");
            state.set_value(initial_when, window, cx);
            state
        });
        self.settings_ui.keybindings.editing = Some(EditingBinding {
            row_id: row.id.clone(),
            command: row.command.clone(),
            original_key: row.wire_key.clone(),
            original_when: row.when.clone(),
            key_input,
            when_input,
        });
        cx.notify();
    }

    fn save_edited_keybinding(&mut self, cx: &mut Context<Self>) {
        let Some(edit) = self.settings_ui.keybindings.editing.take() else {
            return;
        };
        let key = edit.key_input.read(cx).value().trim().to_owned();
        if key.is_empty() {
            self.settings_ui.keybindings.editing = Some(edit);
            return;
        }
        let when_raw = edit.when_input.read(cx).value().trim().to_owned();
        self.bridge.upsert_keybinding(ServerUpsertKeybindingInput {
            key,
            command: edit.command.clone(),
            when: (!when_raw.is_empty()).then_some(when_raw),
            replace: Some(KeybindingReplaceTarget {
                key: edit.original_key,
                command: edit.command,
                when: (!edit.original_when.is_empty()).then_some(edit.original_when),
            }),
        });
        cx.notify();
    }

    fn save_new_keybinding(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.settings_ui.keybindings.adding.as_ref() else {
            return;
        };
        let command = form.command_input.read(cx).value().trim().to_owned();
        let key = form.key_input.read(cx).value().trim().to_owned();
        let when_raw = form.when_input.read(cx).value().trim().to_owned();
        if command.is_empty() || key.is_empty() {
            return;
        }
        self.settings_ui.keybindings.adding = None;
        self.bridge.upsert_keybinding(ServerUpsertKeybindingInput {
            key,
            command,
            when: (!when_raw.is_empty()).then_some(when_raw),
            replace: None,
        });
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p0_protocol::{KeybindingShortcut, KeybindingWhenNode};

    fn sample_rule(
        command: &str,
        key: &str,
        when: Option<KeybindingWhenNode>,
    ) -> ResolvedKeybindingRule {
        ResolvedKeybindingRule {
            command: command.to_owned(),
            shortcut: KeybindingShortcut {
                key: key.to_owned(),
                meta_key: false,
                ctrl_key: false,
                shift_key: false,
                alt_key: false,
                mod_key: true,
            },
            when_ast: when,
        }
    }

    #[test]
    fn groups_and_filters_keybindings() {
        let rules = vec![
            sample_rule(
                "commandPalette.toggle",
                "k",
                Some(KeybindingWhenNode::Not {
                    node: Box::new(KeybindingWhenNode::Identifier {
                        name: "terminalFocus".to_owned(),
                    }),
                }),
            ),
            sample_rule("terminal.toggle", "j", None),
            sample_rule("script.run-tests.run", "r", None),
            sample_rule(
                "sidebar.toggle",
                "b",
                Some(KeybindingWhenNode::Identifier {
                    name: "false".to_owned(),
                }),
            ),
        ];

        let rows = build_rows(&rules);
        assert_eq!(rows.len(), 4);
        assert!(
            rows.iter()
                .any(|r| r.command == "sidebar.toggle" && r.is_unassigned)
        );
        assert!(
            rows.iter()
                .any(|r| r.command == "commandPalette.toggle" && r.when == "!terminalFocus")
        );
        assert!(
            rows.iter()
                .any(|r| r.command == "script.run-tests.run" && r.label == "Run Script: Run Tests")
        );

        let filtered = filter_rows(rows.clone(), "palette");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].command, "commandPalette.toggle");

        let grouped = group_rows(rows);
        let group_names: Vec<&str> = grouped.iter().map(|(g, _)| *g).collect();
        assert_eq!(
            group_names,
            vec!["Navigation", "Terminal", "Project scripts"]
        );
    }

    #[test]
    fn shortcut_wire_key_and_when_expression_round_trip() {
        let shortcut = KeybindingShortcut {
            key: " ".to_owned(),
            meta_key: false,
            ctrl_key: false,
            shift_key: true,
            alt_key: true,
            mod_key: true,
        };
        assert_eq!(shortcut.to_wire_key(), "mod+alt+shift+space");

        let ast = KeybindingWhenNode::And {
            left: Box::new(KeybindingWhenNode::Not {
                node: Box::new(KeybindingWhenNode::Identifier {
                    name: "terminalFocus".to_owned(),
                }),
            }),
            right: Box::new(KeybindingWhenNode::Or {
                left: Box::new(KeybindingWhenNode::Identifier {
                    name: "isDesktop".to_owned(),
                }),
                right: Box::new(KeybindingWhenNode::Identifier {
                    name: "isWeb".to_owned(),
                }),
            }),
        };
        assert_eq!(
            ast.to_expression(),
            "!terminalFocus && (isDesktop || isWeb)"
        );
    }
}
