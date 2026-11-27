//! Answers to an agent's `user_input_request`, ported from
//! `packages/client-runtime/src/state/pendingUserInput.ts` (attachments aside: the native client
//! has none). The map built here is the `answers` of a `runtime-request.respond` command.

use std::collections::BTreeMap;

use p0_protocol::UserInputQuestion;
use serde_json::Value;

/// What the user has picked or typed for one question so far.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DraftAnswer {
    pub selected: Vec<String>,
    pub custom: Option<String>,
}

fn trimmed(value: Option<&str>) -> Option<String> {
    let t = value?.trim();
    (!t.is_empty()).then(|| t.to_owned())
}

// Provider option values stay exact, including whitespace. Only options without a value match by label.
fn resolve_option_value(question: &UserInputQuestion, value: &str) -> Option<String> {
    if question
        .options
        .iter()
        .any(|o| o.value.as_deref() == Some(value))
    {
        return Some(value.to_owned());
    }
    let label = value.trim();
    (!label.is_empty()
        && question
            .options
            .iter()
            .any(|o| o.value.is_none() && o.label.trim() == label))
    .then(|| label.to_owned())
}

/// The value an option submits: its `value`, or its trimmed label when it has none.
pub fn option_value(option: &p0_protocol::UserInputOption) -> String {
    option
        .value
        .clone()
        .unwrap_or_else(|| option.label.trim().to_owned())
}

fn normalize_selected(question: &UserInputQuestion, selected: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in selected {
        if let Some(v) = resolve_option_value(question, value)
            && !out.contains(&v)
        {
            out.push(v);
        }
    }
    out
}

fn custom_allowed(question: &UserInputQuestion) -> bool {
    question.allow_custom_answer != Some(false)
}

/// The answer to submit for one question, or `None` while it is unanswered.
pub fn resolve_answer(question: &UserInputQuestion, draft: Option<&DraftAnswer>) -> Option<Value> {
    let custom = if !custom_allowed(question) {
        None
    } else if question.initial_answer.is_some() {
        draft.and_then(|d| d.custom.clone())
    } else {
        trimmed(draft.and_then(|d| d.custom.as_deref()))
    };
    if let Some(text) = custom.as_ref().filter(|c| !c.is_empty()) {
        return Some(Value::String(text.clone()));
    }
    if question.required == Some(false) && question.options.is_empty() {
        return Some(Value::String(String::new()));
    }
    let selected = normalize_selected(question, draft.map_or(&[][..], |d| &d.selected));
    let fallback = custom.map(Value::String);
    if question.multi_select == Some(true) {
        return if !selected.is_empty() {
            Some(Value::Array(
                selected.into_iter().map(Value::String).collect(),
            ))
        } else if fallback.is_some() {
            fallback
        } else if question.required == Some(true) {
            None
        } else {
            Some(Value::Array(Vec::new()))
        };
    }
    selected.into_iter().next().map(Value::String).or(fallback)
}

/// The answers keyed by question id, or `None` while a question still needs one. An optional
/// single choice left unselected gets no entry.
pub fn build_answers(
    questions: &[UserInputQuestion],
    drafts: &BTreeMap<String, DraftAnswer>,
) -> Option<serde_json::Map<String, Value>> {
    let mut out = serde_json::Map::new();
    for question in questions {
        match resolve_answer(question, drafts.get(&question.id)) {
            Some(answer) => {
                out.insert(question.id.clone(), answer);
            }
            None if question.required == Some(false) => {}
            None => return None,
        }
    }
    Some(out)
}

/// Toggles an offered option; an unknown option leaves the draft as it was.
pub fn toggle_option(
    question: &UserInputQuestion,
    draft: &DraftAnswer,
    value: &str,
) -> DraftAnswer {
    let Some(resolved) = resolve_option_value(question, value) else {
        return draft.clone();
    };
    if question.multi_select == Some(true) {
        let mut selected = normalize_selected(question, &draft.selected);
        if let Some(pos) = selected.iter().position(|v| *v == resolved) {
            selected.remove(pos);
        } else {
            selected.push(resolved);
        }
        return DraftAnswer {
            selected,
            custom: Some(String::new()),
        };
    }
    DraftAnswer {
        selected: vec![resolved],
        custom: Some(String::new()),
    }
}

pub fn is_option_selected(
    question: &UserInputQuestion,
    draft: Option<&DraftAnswer>,
    value: &str,
) -> bool {
    let Some(draft) = draft else {
        return false;
    };
    if custom_allowed(question) && trimmed(draft.custom.as_deref()).is_some() {
        return false;
    }
    resolve_option_value(question, value)
        .is_some_and(|v| normalize_selected(question, &draft.selected).contains(&v))
}

/// Typing replaces the selection, as in the web composer; refused when only options are accepted.
pub fn set_custom(question: &UserInputQuestion, draft: &DraftAnswer, text: &str) -> DraftAnswer {
    if !custom_allowed(question) {
        return draft.clone();
    }
    DraftAnswer {
        selected: Vec::new(),
        custom: Some(text.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn question(v: Value) -> UserInputQuestion {
        let mut v = v;
        let obj = v.as_object_mut().unwrap();
        obj.entry("header").or_insert(json!("H"));
        obj.entry("question").or_insert(json!("Q?"));
        serde_json::from_value(v).unwrap()
    }

    fn single() -> UserInputQuestion {
        question(json!({"id": "scope", "options": [
            {"label": "Orchestration-first", "description": "a"},
            {"label": "Node.js", "description": "b"}], "multiSelect": false}))
    }

    fn native_choice() -> UserInputQuestion {
        question(json!({"id": "result", "options": [
            {"value": " first\t", "label": "Result", "description": "First"},
            {"value": "second", "label": "Result", "description": "Second"}],
            "allowCustomAnswer": false, "multiSelect": false}))
    }

    fn draft(selected: &[&str], custom: Option<&str>) -> DraftAnswer {
        DraftAnswer {
            selected: selected.iter().map(|s| (*s).to_owned()).collect(),
            custom: custom.map(str::to_owned),
        }
    }

    #[test]
    fn preserves_exact_text_when_initial_answer_given() {
        let mut q = single();
        q.initial_answer = Some("  Proposed\n".to_owned());
        assert_eq!(
            resolve_answer(&q, Some(&draft(&[], Some("  Edited\n\n")))),
            Some(json!("  Edited\n\n"))
        );
        assert_eq!(
            resolve_answer(&q, Some(&draft(&[], Some(" \n")))),
            Some(json!(" \n"))
        );
    }

    #[test]
    fn custom_answer_beats_selection_unless_only_options_allowed() {
        assert_eq!(
            resolve_answer(
                &single(),
                Some(&draft(&["Orchestration-first"], Some("Keep it")))
            ),
            Some(json!("Keep it"))
        );
        assert_eq!(
            resolve_answer(&native_choice(), Some(&draft(&["second"], Some("other")))),
            Some(json!("second"))
        );
        assert_eq!(
            resolve_answer(&native_choice(), Some(&draft(&["Result", "unknown"], None))),
            None
        );
        assert_eq!(
            resolve_answer(&single(), Some(&draft(&[" Node.js "], None))),
            Some(json!("Node.js"))
        );
    }

    #[test]
    fn optional_text_question_may_stay_blank() {
        let mut q = question(json!({"id": "notes", "options": []}));
        assert_eq!(resolve_answer(&q, Some(&draft(&[], Some(" ")))), None);
        q.required = Some(false);
        assert_eq!(resolve_answer(&q, None), Some(json!("")));
    }

    #[test]
    fn toggles_options_with_equal_labels_independently() {
        let mut q = native_choice();
        q.multi_select = Some(true);
        let first = toggle_option(&q, &DraftAnswer::default(), " first\t");
        let both = toggle_option(&q, &first, "second");
        let mut drafts = BTreeMap::new();
        drafts.insert("result".to_owned(), both.clone());
        assert_eq!(
            build_answers(std::slice::from_ref(&q), &drafts).unwrap()["result"],
            json!([" first\t", "second"])
        );
        let only_second = toggle_option(&q, &both, " first\t");
        drafts.insert("result".to_owned(), only_second);
        assert_eq!(
            build_answers(std::slice::from_ref(&q), &drafts).unwrap()["result"],
            json!(["second"])
        );
        assert_eq!(toggle_option(&native_choice(), &first, "Result"), first);
        assert!(is_option_selected(
            &native_choice(),
            Some(&first),
            " first\t"
        ));
        assert!(!is_option_selected(
            &native_choice(),
            Some(&first),
            "second"
        ));
    }

    #[test]
    fn rejects_free_text_when_only_options_allowed() {
        let q = native_choice();
        assert_eq!(
            set_custom(&q, &DraftAnswer::default(), "Other"),
            DraftAnswer::default()
        );
        let mut drafts = BTreeMap::new();
        drafts.insert("result".to_owned(), draft(&[], Some("Other")));
        assert_eq!(build_answers(std::slice::from_ref(&q), &drafts), None);
    }

    #[test]
    fn multi_select_with_nothing_checked_answers_empty_list() {
        let extras = question(json!({"id": "extras", "options": [
            {"label": "Lint", "description": ""}, {"label": "Tests", "description": ""}], "multiSelect": true}));
        let mut drafts = BTreeMap::new();
        drafts.insert("scope".to_owned(), draft(&["Node.js"], None));
        let answers = build_answers(&[single(), extras.clone()], &drafts).unwrap();
        assert_eq!(
            Value::Object(answers),
            json!({"scope": "Node.js", "extras": []})
        );
        assert_eq!(
            build_answers(&[single(), extras.clone()], &BTreeMap::new()),
            None
        );
        let mut required = extras;
        required.required = Some(true);
        assert_eq!(build_answers(&[single(), required], &drafts), None);
    }

    #[test]
    fn omits_unselected_optional_single_choice() {
        let extras = question(json!({"id": "extras", "options": [
            {"label": "true", "value": "true", "description": ""},
            {"label": "false", "value": "false", "description": ""}],
            "allowCustomAnswer": false, "required": false}));
        let mode = question(json!({"id": "mode", "options": [
            {"label": "\"\"", "value": "", "description": ""},
            {"label": "fast", "value": "fast", "description": ""}],
            "allowCustomAnswer": false, "required": false}));
        assert_eq!(
            build_answers(&[extras.clone(), mode.clone()], &BTreeMap::new()),
            Some(serde_json::Map::new())
        );
        let mut drafts = BTreeMap::new();
        drafts.insert("extras".to_owned(), draft(&["false"], None));
        drafts.insert("mode".to_owned(), draft(&[""], None));
        assert_eq!(
            Value::Object(build_answers(&[extras.clone(), mode.clone()], &drafts).unwrap()),
            json!({"extras": "false", "mode": ""})
        );
        let mut not_optional = extras;
        not_optional.required = None;
        assert_eq!(build_answers(&[not_optional, mode], &BTreeMap::new()), None);
    }
}
