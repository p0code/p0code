//! Rows the user answers: approvals (`runtime-request.respond` with a decision), questions
//! (`runtime-request.respond` with answers) and secret requests (`secrets.answerRequest`).
//!
//! Secret values are read out of their inputs only on Save, held in `Zeroizing` buffers until the
//! request is built, and never logged. The inputs are cleared right after Save.

use std::collections::{BTreeMap, HashMap, HashSet};

use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, ParentElement as _, SharedString,
    Styled as _, Window, div, px,
};
use p0_client::ThreadState;
use p0_client::user_input::{
    DraftAnswer, build_answers, is_option_selected, option_value, set_custom, toggle_option,
};
use p0_protocol::{
    ApprovalDecision, ApprovalOption, ProjectedTurnItem, SecretRequestAnswer, SecretRequestStatus,
    TurnItem, UserInputQuestion,
};
use zeroize::Zeroizing;

use crate::app::P0App;
use crate::feed::{caption, card};
use crate::theme::AppPalette;

/// The web app's options when the provider offers none (`ComposerPendingApprovalActions.tsx`).
pub fn default_approval_options() -> Vec<ApprovalOption> {
    [
        (ApprovalDecision::Cancel, "Cancel"),
        (ApprovalDecision::Decline, "Decline"),
        (
            ApprovalDecision::AcceptForSession,
            "Always allow this session",
        ),
        (ApprovalDecision::Accept, "Approve"),
    ]
    .into_iter()
    .map(|(decision, label)| ApprovalOption {
        decision,
        label: label.to_owned(),
        warning: None,
    })
    .collect()
}

pub struct SecretForm {
    /// `(field name, input)`; a card without `fields` has one input named `""`.
    inputs: Vec<(String, Entity<InputState>)>,
}

#[derive(Default)]
pub struct CardForms {
    secret: HashMap<String, SecretForm>,
    drafts: HashMap<String, BTreeMap<String, DraftAnswer>>,
    text_inputs: HashMap<(String, String), Entity<InputState>>,
    /// Requests answered from here whose resolution has not arrived yet.
    answered: HashSet<String>,
}

fn is_pending(thread: &ThreadState, request_id: &str) -> bool {
    thread
        .pending_approvals()
        .iter()
        .any(|r| r.id == request_id)
}

impl CardForms {
    /// Drops form state for requests that are no longer open.
    pub fn retain_pending(&mut self, thread: &ThreadState) {
        let pending: HashSet<&str> = thread
            .pending_approvals()
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        let open_secrets: HashSet<&str> = thread
            .projection
            .iter()
            .flat_map(|p| &p.visible_turn_items)
            .filter_map(|row| match &row.item {
                TurnItem::SecretRequest {
                    id,
                    secret_status: SecretRequestStatus::Pending,
                    ..
                } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        self.drafts.retain(|rid, _| pending.contains(rid.as_str()));
        self.text_inputs
            .retain(|(rid, _), _| pending.contains(rid.as_str()));
        self.secret
            .retain(|id, _| open_secrets.contains(id.as_str()));
        self.answered
            .retain(|id| pending.contains(id.as_str()) || open_secrets.contains(id.as_str()));
    }

    /// Part of a card's row signature: what changes its height besides the item itself.
    pub fn signature(&self, item: &TurnItem, thread: &ThreadState) -> u64 {
        match item {
            TurnItem::ApprovalRequest { request_id, .. }
            | TurnItem::UserInputRequest { request_id, .. } => {
                u64::from(is_pending(thread, request_id))
                    | (u64::from(self.answered.contains(request_id)) << 1)
            }
            TurnItem::SecretRequest { id, .. } => u64::from(self.answered.contains(id)) << 1,
            _ => 0,
        }
    }
}

impl P0App {
    pub(crate) fn render_card(
        &mut self,
        row: &ProjectedTurnItem,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let thread_id = self.thread.thread_id.clone().unwrap_or_default();
        match &row.item {
            TurnItem::ApprovalRequest {
                request_id,
                title,
                prompt,
                reason,
                options,
                ..
            } => {
                let pending = is_pending(&self.thread, request_id)
                    && !self.cards.answered.contains(request_id);
                let mut c = card(palette)
                    .border_color(if pending {
                        palette.warning
                    } else {
                        palette.border
                    })
                    .child(caption(
                        title
                            .as_deref()
                            .unwrap_or(self.i18n.get(p0_i18n::Key::ApprovalRequested)),
                        palette.foreground,
                    ));
                if let Some(p) = prompt {
                    c = c.child(div().text_sm().child(SharedString::from(p.clone())));
                }
                if let Some(r) = reason {
                    c = c.child(
                        div()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(r.clone())),
                    );
                }
                if !pending {
                    return c.into_any_element();
                }
                // Provider labels are server text; only the built-in defaults are translated.
                let (opts, translate) = match options {
                    Some(list) if !list.is_empty() => (list.clone(), false),
                    _ => (default_approval_options(), true),
                };
                let mut buttons = div().flex().flex_wrap().gap(px(8.0)).pt(px(4.0));
                for (ix, opt) in opts.into_iter().enumerate() {
                    let label = if translate {
                        self.i18n.tr(&opt.label).to_owned()
                    } else {
                        opt.label.clone()
                    };
                    let (tid, rid, decision) =
                        (thread_id.clone(), request_id.clone(), opt.decision);
                    let mut button =
                        Button::new(SharedString::from(format!("approve-{request_id}-{ix}")))
                            .label(label)
                            .compact()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.cards.answered.insert(rid.clone());
                                this.bridge
                                    .respond_approval(tid.clone(), rid.clone(), decision);
                                this.sync_feed(cx);
                                cx.notify();
                            }));
                    button = match decision {
                        ApprovalDecision::Accept => button.primary(),
                        ApprovalDecision::Decline => button.danger(),
                        _ => button.outline(),
                    };
                    buttons = buttons.child(button);
                    if let Some(warning) = opt.warning.as_deref() {
                        buttons = buttons.child(
                            div()
                                .text_xs()
                                .text_color(palette.warning)
                                .child(SharedString::from(warning.to_owned())),
                        );
                    }
                }
                c.child(buttons).into_any_element()
            }
            TurnItem::UserInputRequest {
                request_id,
                questions,
                ..
            } => self.render_questions(&thread_id, request_id, questions, palette, window, cx),
            TurnItem::SecretRequest {
                id,
                label,
                reason,
                url,
                placeholder,
                fields,
                secret_status,
                ..
            } => {
                let mut c = card(palette).child(caption(label, palette.foreground));
                if !reason.is_empty() {
                    c = c.child(
                        div()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .child(SharedString::from(reason.clone())),
                    );
                }
                if let Some(url) = url.clone() {
                    c = c.child(
                        Button::new(SharedString::from(format!("secret-url-{id}")))
                            .label(self.i18n.tr("Open in browser").to_owned())
                            .compact()
                            .outline()
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    );
                }
                let open = *secret_status == SecretRequestStatus::Pending
                    && !self.cards.answered.contains(id);
                if !open {
                    let status = match secret_status {
                        SecretRequestStatus::Saved => self.i18n.tr("Saved"),
                        SecretRequestStatus::Declined => self.i18n.get(p0_i18n::Key::Declined),
                        SecretRequestStatus::Cancelled => self.i18n.get(p0_i18n::Key::Cancelled),
                        _ => self.i18n.get(p0_i18n::Key::Pending),
                    };
                    return c
                        .child(
                            div()
                                .text_xs()
                                .text_color(palette.muted_foreground)
                                .child(SharedString::from(status.to_owned())),
                        )
                        .into_any_element();
                }
                let form = self.cards.secret.entry(id.clone()).or_insert_with(|| {
                    let specs: Vec<(String, String, bool)> = match fields {
                        Some(fields) if !fields.is_empty() => fields
                            .iter()
                            .map(|f| {
                                (
                                    f.name.clone(),
                                    f.placeholder.clone().unwrap_or_else(|| f.label.clone()),
                                    f.secret != Some(false),
                                )
                            })
                            .collect(),
                        _ => vec![(String::new(), placeholder.clone().unwrap_or_default(), true)],
                    };
                    SecretForm {
                        inputs: specs
                            .into_iter()
                            .map(|(name, hint, masked)| {
                                (
                                    name,
                                    cx.new(|cx| {
                                        InputState::new(window, cx).masked(masked).placeholder(hint)
                                    }),
                                )
                            })
                            .collect(),
                    }
                });
                let mut inputs = div().flex().flex_col().gap(px(6.0));
                for (name, input) in &form.inputs {
                    if let Some(field) = fields.iter().flatten().find(|f| &f.name == name) {
                        inputs = inputs.child(
                            div()
                                .text_xs()
                                .text_color(palette.muted_foreground)
                                .child(SharedString::from(field.label.clone())),
                        );
                    }
                    inputs = inputs.child(Input::new(input).mask_toggle());
                }
                let (tid_save, item_save) = (thread_id.clone(), id.clone());
                let (tid_decline, item_decline) = (thread_id, id.clone());
                c.child(inputs)
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .pt(px(4.0))
                            .child(
                                Button::new(SharedString::from(format!("secret-save-{id}")))
                                    .label(self.i18n.tr("Save").to_owned())
                                    .primary()
                                    .compact()
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.submit_secret(
                                            tid_save.clone(),
                                            item_save.clone(),
                                            window,
                                            cx,
                                        );
                                    })),
                            )
                            .child(
                                Button::new(SharedString::from(format!("secret-decline-{id}")))
                                    .label(self.i18n.tr("Decline").to_owned())
                                    .outline()
                                    .compact()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.cards.answered.insert(item_decline.clone());
                                        this.bridge.answer_secret_request(
                                            tid_decline.clone(),
                                            item_decline.clone(),
                                            SecretRequestAnswer::Decline,
                                        );
                                        this.sync_feed(cx);
                                        cx.notify();
                                    })),
                            ),
                    )
                    .into_any_element()
            }
            _ => div().into_any_element(),
        }
    }

    fn submit_secret(
        &mut self,
        thread_id: String,
        item_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(form) = self.cards.secret.get(&item_id) else {
            return;
        };
        let values: Vec<(String, Zeroizing<String>)> = form
            .inputs
            .iter()
            .map(|(name, input)| {
                (
                    name.clone(),
                    Zeroizing::new(input.read(cx).value().trim().to_owned()),
                )
            })
            .collect();
        if values.iter().any(|(_, v)| v.is_empty()) {
            return;
        }
        for (_, input) in &form.inputs {
            input.update(cx, |state, cx| state.set_value("", window, cx));
        }
        let answer = match values.as_slice() {
            [(name, value)] if name.is_empty() => SecretRequestAnswer::Save {
                secret: value.to_string(),
            },
            _ => SecretRequestAnswer::SaveValues {
                values: values
                    .iter()
                    .map(|(n, v)| (n.clone(), v.to_string()))
                    .collect(),
            },
        };
        self.cards.answered.insert(item_id.clone());
        self.bridge
            .answer_secret_request(thread_id, item_id, answer);
        self.sync_feed(cx);
        cx.notify();
    }

    fn render_questions(
        &mut self,
        thread_id: &str,
        request_id: &str,
        questions: &[UserInputQuestion],
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let pending =
            is_pending(&self.thread, request_id) && !self.cards.answered.contains(request_id);
        let mut c = card(palette).border_color(if pending {
            palette.info
        } else {
            palette.border
        });
        for (qx, q) in questions.iter().enumerate() {
            let mut block = div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(caption(&q.header, palette.info))
                .child(
                    div()
                        .text_sm()
                        .child(SharedString::from(q.question.clone())),
                );
            if !pending {
                c = c.child(block);
                continue;
            }
            let key = (request_id.to_owned(), q.id.clone());
            let draft = self.drafts_for(request_id).get(&q.id).cloned();
            let mut chips = div().flex().flex_wrap().gap(px(6.0)).pt(px(2.0));
            for (ox, opt) in q.options.iter().enumerate() {
                let value = option_value(opt);
                let selected = is_option_selected(q, draft.as_ref(), &value);
                let (rid, question) = (request_id.to_owned(), q.clone());
                let mut chip = Button::new(SharedString::from(format!("q-{request_id}-{qx}-{ox}")))
                    .label(opt.label.clone())
                    .compact()
                    .toggled(selected)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let drafts = this.cards.drafts.entry(rid.clone()).or_default();
                        let current = drafts.get(&question.id).cloned().unwrap_or_default();
                        drafts.insert(
                            question.id.clone(),
                            toggle_option(&question, &current, &value),
                        );
                        if let Some(input) = this
                            .cards
                            .text_inputs
                            .get(&(rid.clone(), question.id.clone()))
                        {
                            input.update(cx, |s, cx| s.set_value("", window, cx));
                        }
                        cx.notify();
                    }));
                if !opt.description.is_empty() {
                    chip = chip.tooltip(opt.description.clone());
                }
                chips = chips.child(chip);
            }
            if !q.options.is_empty() {
                block = block.child(chips);
            }
            if q.allow_custom_answer != Some(false) {
                let initial = q.initial_answer.clone().unwrap_or_default();
                let placeholder = self.i18n.tr("Other").to_owned();
                let input = self
                    .cards
                    .text_inputs
                    .entry(key)
                    .or_insert_with(|| {
                        cx.new(|cx| {
                            let mut state = InputState::new(window, cx).placeholder(placeholder);
                            state.set_value(initial, window, cx);
                            state
                        })
                    })
                    .clone();
                block = block.child(Input::new(&input));
            }
            c = c.child(block);
        }
        if !pending {
            return c.into_any_element();
        }
        let drafts = self.current_drafts(request_id, questions, cx);
        let answers = build_answers(questions, &drafts);
        let (tid, rid) = (thread_id.to_owned(), request_id.to_owned());
        let qs = questions.to_vec();
        c.child(
            div().pt(px(4.0)).child(
                Button::new(SharedString::from(format!("q-submit-{request_id}")))
                    .label(self.i18n.tr("Submit").to_owned())
                    .primary()
                    .compact()
                    .disabled(answers.is_none())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let drafts = this.current_drafts(&rid, &qs, cx);
                        let Some(answers) = build_answers(&qs, &drafts) else {
                            return;
                        };
                        this.cards.answered.insert(rid.clone());
                        this.bridge
                            .answer_user_input(tid.clone(), rid.clone(), answers);
                        this.sync_feed(cx);
                        cx.notify();
                    })),
            ),
        )
        .into_any_element()
    }

    fn drafts_for(&self, request_id: &str) -> BTreeMap<String, DraftAnswer> {
        self.cards
            .drafts
            .get(request_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Selections plus whatever is typed in each question's text field right now.
    fn current_drafts(
        &self,
        request_id: &str,
        questions: &[UserInputQuestion],
        cx: &Context<Self>,
    ) -> BTreeMap<String, DraftAnswer> {
        let mut drafts = self.drafts_for(request_id);
        for q in questions {
            let Some(input) = self
                .cards
                .text_inputs
                .get(&(request_id.to_owned(), q.id.clone()))
            else {
                continue;
            };
            let text = input.read(cx).value().to_string();
            let current = drafts.get(&q.id).cloned().unwrap_or_default();
            if !text.is_empty() || q.initial_answer.is_some() {
                drafts.insert(q.id.clone(), set_custom(q, &current, &text));
            }
        }
        drafts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_options_follow_the_web_order() {
        let decisions: Vec<_> = default_approval_options()
            .into_iter()
            .map(|o| o.decision)
            .collect();
        assert_eq!(
            decisions,
            [
                ApprovalDecision::Cancel,
                ApprovalDecision::Decline,
                ApprovalDecision::AcceptForSession,
                ApprovalDecision::Accept
            ]
        );
    }

    #[test]
    fn approval_fixture_parses_options_and_answers_encode() {
        let fixture = include_str!(
            "../../../crates/p0-protocol/fixtures/command_runtime_request_respond.json"
        );
        let value: serde_json::Value = serde_json::from_str(fixture).unwrap();
        assert_eq!(value["type"], "runtime-request.respond");

        let item: TurnItem = serde_json::from_value(serde_json::json!({
            "type": "approval_request", "id": "i", "threadId": "t", "ordinal": 3, "status": "running",
            "updatedAt": "2026-01-01T00:00:00.000Z", "requestId": "r", "requestKind": "command",
            "prompt": "Run tests?",
            "options": [{"decision": "acceptForSession", "label": "Allow for session"},
                        {"decision": "decline", "label": "No", "warning": "The agent stops"}]
        }))
        .unwrap();
        let TurnItem::ApprovalRequest {
            options: Some(options),
            ..
        } = item
        else {
            panic!("{item:?}");
        };
        assert_eq!(options[0].decision, ApprovalDecision::AcceptForSession);
        assert_eq!(options[1].warning.as_deref(), Some("The agent stops"));
    }

    #[test]
    fn secret_answers_encode_like_the_contract_and_never_debug_print() {
        let single = serde_json::to_value(SecretRequestAnswer::Save {
            secret: "hunter2".to_owned(),
        })
        .unwrap();
        assert_eq!(
            single,
            serde_json::json!({"type": "save", "secret": "hunter2"})
        );
        let multi = SecretRequestAnswer::SaveValues {
            values: [
                ("email".to_owned(), "a@b.c".to_owned()),
                ("password".to_owned(), "pw".to_owned()),
            ]
            .into(),
        };
        assert_eq!(
            serde_json::to_value(&multi).unwrap(),
            serde_json::json!({"type": "save", "values": {"email": "a@b.c", "password": "pw"}})
        );
        assert_eq!(
            serde_json::to_value(SecretRequestAnswer::Decline).unwrap(),
            serde_json::json!({"type": "decline"})
        );
        let debug = format!(
            "{multi:?} {:?}",
            SecretRequestAnswer::Save {
                secret: "hunter2".to_owned()
            }
        );
        assert!(
            !debug.contains("hunter2") && !debug.contains("pw\""),
            "{debug}"
        );
    }

    #[test]
    fn secret_request_fixture_with_fields_parses() {
        let item: TurnItem = serde_json::from_value(serde_json::json!({
            "type": "secret_request", "id": "s", "threadId": "t", "ordinal": 4, "status": "running",
            "updatedAt": "2026-01-01T00:00:00.000Z", "label": "Sign in", "reason": "Deploy needs it",
            "fields": [{"name": "email", "label": "Email", "secret": false}, {"name": "password", "label": "Password"}],
            "secretStatus": "pending"
        }))
        .unwrap();
        let TurnItem::SecretRequest {
            fields: Some(fields),
            secret_status,
            ..
        } = item
        else {
            panic!("{item:?}");
        };
        assert_eq!(secret_status, SecretRequestStatus::Pending);
        assert_eq!(fields[0].secret, Some(false));
        assert_eq!(fields[1].secret, None);
    }
}
