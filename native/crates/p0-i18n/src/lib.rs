//! Minimal i18n catalog loader backed by `apps/web/src/i18n/translations/*.json`.
//!
//! Only the keys actively referenced by `p0-gpui` are retained in memory at runtime,
//! with `en` as fallback and automatic system locale resolution.

use std::collections::HashMap;

const EN_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/en.json");
const DE_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/de.json");
const ES_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/es.json");
const FR_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/fr.json");
const JA_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/ja.json");
const KO_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/ko.json");
const PT_BR_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/pt-BR.json");
const RU_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/ru.json");
const SV_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/sv.json");
const ZH_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/zh.json");
const ZH_TW_JSON: &str = include_str!("../../../../apps/web/src/i18n/translations/zh-TW.json");

macro_rules! define_keys {
    ($($variant:ident => $id:literal),* $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum Key {
            $($variant),*
        }

        impl Key {
            pub const ALL: &'static [Key] = &[$(Key::$variant),*];

            pub const fn id(self) -> &'static str {
                match self {
                    $(Key::$variant => $id),*
                }
            }
        }
    };
}

define_keys! {
    Send => "653405e4ed498d9f",
    Stop => "4bf9327818b58241",
    Accept => "94097f426322e936",
    Decline => "be5989cafc1c0759",
    Connected => "203d68963a231f07",
    Connecting => "2a918ed2e51ab64a",
    Reconnecting => "6cced6a88a19f1f2",
    NotConnected => "60434ab831897ee0",
    Offline => "a980c44b06fc7b26",
    Reconnect => "0f8bee1d8602ddf7",
    Retry => "1c79d42e902ff431",
    Projects => "cc84bfe0ee5d0174",
    Threads => "6d9bf91f0d4b7ba3",
    Thread => "23be753133ae6950",
    NewThread => "7e37b307eeb4c94e",
    NoProjectsYet => "6392f9e0f61ae70c",
    NoThreadsFound => "c1ebd6fc41cec538",
    UntitledThread => "2d7d0917e9d23b98",
    AskAnything => "3d3f30f1a1c4fc52",
    Thinking => "c392becd445ecdba",
    Reasoning => "550c120b5e4a1f23",
    Plan => "f2c5bb584187afc0",
    Model => "8257030da7a4ad4e",
    Tools => "1e6cf17ba1337cf6",
    Command => "c01f9d3f3624c903",
    ApprovalNeeded => "fd1316b1f627872b",
    ApprovalRequested => "add64ee99ad07f1d",
    WaitingForApproval => "2a08dc733f2fbfac",
    NeedsApproval => "7bfe35051f932b93",
    Supervised => "5fbeffb697c7b33c",
    AutoAcceptEdits => "cceea5cef0684b31",
    Auto => "468986e98d947cb7",
    FullAccess => "1eed3d794eed6b65",
    Pending => "9736f3763a6476c2",
    Running => "83915f0968cde2cc",
    Working => "834ca879c14c167b",
    Completed => "54002bf654ddbab1",
    Done => "1347868f2523140e",
    Failed => "d4d89c139de812a8",
    Cancelled => "b2074e9bd23049a6",
    Waiting => "7ea8cb8af281ce93",
    Idle => "86d60d42f6cb4a40",
    Queued => "7150557773b3818b",
    Error => "4ad258969e361b3c",
    Loading => "5a0125dd9241cdec",
    LoadingMessages => "0aceebf3f6d0d568",
    ShowDetails => "63790659557f315e",
    HideDetails => "189cb97125af21c1",
    You => "0c982111ac348e9f",
    System => "a03e4c1348ad9ba8",
    Permissions => "f0d4573b2e03e2a7",
    Settings => "0a75e464d833bca8",
    AskForSecret => "76ed47bc9da51cc4",
    Declined => "8cc00444f7443feb",
}

/// Locales the web catalogs ship, with their own names for the Language setting.
pub const SUPPORTED_LOCALES: &[(&str, &str)] = &[
    ("en", "English"),
    ("de", "Deutsch"),
    ("es", "Español"),
    ("fr", "Français"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("pt-BR", "Português (Brasil)"),
    ("ru", "Русский"),
    ("sv", "Svenska"),
    ("zh", "简体中文"),
    ("zh-TW", "繁體中文"),
];

#[derive(Debug)]
struct Inner {
    /// Catalog id -> text in the active locale (English where it has no translation).
    by_id: HashMap<String, String>,
    /// English text -> catalog id, so native code can look strings up by their English.
    id_by_english: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct Catalog {
    locale: String,
    inner: std::sync::Arc<Inner>,
}

impl Catalog {
    /// Load translations for the active system locale, falling back to `en`.
    pub fn for_system() -> Self {
        let locale = sys_locale::get_locale().unwrap_or_else(|| "en".to_owned());
        Self::for_locale(&locale)
    }

    /// Load translations for a BCP-47 locale tag (e.g. `"en-US"`, `"zh-TW"`, `"ja"`).
    pub fn for_locale(locale: &str) -> Self {
        let normalized = resolve_supported_locale(locale);
        let mut by_id = parse_catalog(EN_JSON);
        let mut id_by_english = HashMap::with_capacity(by_id.len());
        for (id, text) in &by_id {
            // Several ids can share English text (different `$context`); keep a stable one.
            id_by_english
                .entry(text.clone())
                .and_modify(|existing: &mut String| {
                    if id < existing {
                        existing.clone_from(id);
                    }
                })
                .or_insert_with(|| id.clone());
        }
        if let Some(raw) = locale_json(normalized) {
            by_id.extend(parse_catalog(raw));
        }
        Self {
            locale: normalized.to_owned(),
            inner: std::sync::Arc::new(Inner {
                by_id,
                id_by_english,
            }),
        }
    }

    pub fn locale(&self) -> &str {
        &self.locale
    }

    pub fn get(&self, key: Key) -> &str {
        self.inner
            .by_id
            .get(key.id())
            .map(String::as_str)
            .unwrap_or_else(|| key.id())
    }

    /// The translation of a string the web app also shows, by its English text; the English
    /// itself when the catalogs do not have it.
    pub fn tr<'a>(&'a self, english: &'a str) -> &'a str {
        self.inner
            .id_by_english
            .get(english)
            .and_then(|id| self.inner.by_id.get(id))
            .map_or(english, String::as_str)
    }

    /// Like [`Self::tr`], then substitutes `{name}` placeholders.
    pub fn tr_format(&self, english: &str, vars: &[(&str, &str)]) -> String {
        substitute(self.tr(english), vars)
    }

    pub fn format(&self, key: Key, vars: &[(&str, &str)]) -> String {
        substitute(self.get(key), vars)
    }
}

fn substitute(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.to_owned();
    for (name, value) in vars {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

pub fn resolve_supported_locale(raw: &str) -> &'static str {
    let lower = raw.trim().replace('_', "-").to_ascii_lowercase();
    if lower.starts_with("zh-tw") || lower.starts_with("zh-hk") || lower.starts_with("zh-hant") {
        return "zh-TW";
    }
    if lower.starts_with("zh") {
        return "zh";
    }
    if lower.starts_with("pt") {
        return "pt-BR";
    }
    if lower.starts_with("de") {
        return "de";
    }
    if lower.starts_with("es") {
        return "es";
    }
    if lower.starts_with("fr") {
        return "fr";
    }
    if lower.starts_with("ja") {
        return "ja";
    }
    if lower.starts_with("ko") {
        return "ko";
    }
    if lower.starts_with("ru") {
        return "ru";
    }
    if lower.starts_with("sv") {
        return "sv";
    }
    "en"
}

fn locale_json(locale: &str) -> Option<&'static str> {
    match locale {
        "en" => None,
        "de" => Some(DE_JSON),
        "es" => Some(ES_JSON),
        "fr" => Some(FR_JSON),
        "ja" => Some(JA_JSON),
        "ko" => Some(KO_JSON),
        "pt-BR" => Some(PT_BR_JSON),
        "ru" => Some(RU_JSON),
        "sv" => Some(SV_JSON),
        "zh" => Some(ZH_JSON),
        "zh-TW" => Some(ZH_TW_JSON),
        _ => None,
    }
}

fn parse_catalog(raw: &str) -> HashMap<String, String> {
    let parsed: HashMap<String, serde_json::Value> = serde_json::from_str(raw).unwrap_or_default();
    parsed
        .into_iter()
        .filter_map(|(id, value)| Some((id, value.as_str()?.to_owned())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_used_key_exists_in_en_json() {
        let en: HashMap<String, serde_json::Value> =
            serde_json::from_str(EN_JSON).expect("en.json must parse as JSON object");
        let missing: Vec<_> = Key::ALL
            .iter()
            .filter(|k| en.get(k.id()).and_then(serde_json::Value::as_str).is_none())
            .map(|k| format!("{k:?} ({})", k.id()))
            .collect();
        assert!(
            missing.is_empty(),
            "keys missing from apps/web/src/i18n/translations/en.json: {missing:?}"
        );
    }

    #[test]
    fn resolves_english_and_non_english_locales() {
        let en = Catalog::for_locale("en-US");
        assert_eq!(en.locale(), "en");
        assert_eq!(en.get(Key::Send), "Send");
        assert_eq!(en.get(Key::Accept), "Accept");

        let ja = Catalog::for_locale("ja_JP.UTF-8");
        assert_eq!(ja.locale(), "ja");
        assert!(!ja.get(Key::Send).is_empty());

        let zh_tw = Catalog::for_locale("zh-Hant-TW");
        assert_eq!(zh_tw.locale(), "zh-TW");
        assert!(!zh_tw.get(Key::Projects).is_empty());
    }

    #[test]
    fn looks_up_by_english_text() {
        let zh_tw = Catalog::for_locale("zh-TW");
        assert_ne!(zh_tw.tr("Settings"), "Settings");
        assert_eq!(zh_tw.tr("Settings"), zh_tw.get(Key::Settings));
        assert_eq!(
            zh_tw.tr("A string the web app never shows"),
            "A string the web app never shows"
        );
        assert_eq!(Catalog::for_locale("en").tr("Appearance"), "Appearance");
    }
}
