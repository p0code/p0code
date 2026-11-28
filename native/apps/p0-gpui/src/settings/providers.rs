//! Providers & models settings (`/settings/providers`): reads live provider state from
//! `server.getConfig` and instance/model preferences from `server.getSettings`, writing updates
//! through `server.updateSettings` and `server.refreshProviders`.

use std::collections::{HashMap, HashSet};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::switch::Switch;
use gpui_kit::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    px,
};
use p0_protocol::{ServerProvider, ServerProviderState};
use serde_json::{Map, Value, json};

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::setting_row;
use crate::theme::AppPalette;

#[derive(Default)]
pub struct ProvidersUiState {
    expanded: HashSet<String>,
    display_name_inputs: HashMap<String, Entity<InputState>>,
    binary_path_inputs: HashMap<String, Entity<InputState>>,
    custom_model_inputs: HashMap<String, Entity<InputState>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderModelPrefs {
    pub favorites: HashSet<(String, String)>,
    pub hidden: HashMap<String, HashSet<String>>,
    pub default_model: Option<(String, String)>,
    pub idle_compaction: String,
    pub usage_limit_sources: Vec<(String, String, String, bool)>,
}

impl ProviderModelPrefs {
    pub fn from_settings(settings: &Value) -> Self {
        let mut favorites = HashSet::new();
        if let Some(arr) = settings.get("favorites").and_then(Value::as_array) {
            for item in arr {
                if let (Some(p), Some(m)) = (
                    item.get("provider").and_then(Value::as_str),
                    item.get("model").and_then(Value::as_str),
                ) {
                    favorites.insert((p.to_owned(), m.to_owned()));
                }
            }
        }
        let mut hidden: HashMap<String, HashSet<String>> = HashMap::new();
        if let Some(map) = settings
            .get("providerModelPreferences")
            .and_then(Value::as_object)
        {
            for (provider_id, entry) in map {
                if let Some(arr) = entry.get("hiddenModels").and_then(Value::as_array) {
                    let set: HashSet<String> = arr
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect();
                    if !set.is_empty() {
                        hidden.insert(provider_id.clone(), set);
                    }
                }
            }
        }
        let default_model = settings
            .get("defaultModelSelection")
            .and_then(Value::as_object)
            .and_then(|obj| {
                Some((
                    obj.get("instanceId")?.as_str()?.to_owned(),
                    obj.get("model")?.as_str()?.to_owned(),
                ))
            });
        let idle_compaction = settings
            .get("idleCompaction")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                if settings
                    .get("compactIdleThreads")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    "onReturn".to_owned()
                } else {
                    "off".to_owned()
                }
            });
        let mut usage_limit_sources = Vec::new();
        if let Some(sources) = settings.get("usageLimitSources").and_then(Value::as_object) {
            for (id, entry) in sources {
                let url = entry
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let label = entry
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(url.as_str())
                    .to_owned();
                let enabled = entry
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                usage_limit_sources.push((id.clone(), label, url, enabled));
            }
            usage_limit_sources.sort_by(|a, b| a.0.cmp(&b.0));
        }
        Self {
            favorites,
            hidden,
            default_model,
            idle_compaction,
            usage_limit_sources,
        }
    }

    pub fn is_favorite(&self, instance_id: &str, slug: &str) -> bool {
        self.favorites
            .contains(&(instance_id.to_owned(), slug.to_owned()))
    }

    pub fn is_hidden(&self, instance_id: &str, slug: &str) -> bool {
        self.hidden
            .get(instance_id)
            .is_some_and(|set| set.contains(slug))
    }

    pub fn is_default(&self, instance_id: &str, slug: &str) -> bool {
        self.default_model
            .as_ref()
            .is_some_and(|(p, m)| p == instance_id && m == slug)
    }
}

/// Builds a full `providerInstances` map patch updating one provider instance while preserving all
/// existing sibling instances and config keys.
pub fn build_provider_instance_patch(
    settings: &Value,
    provider: &ServerProvider,
    mutate: impl FnOnce(&mut Map<String, Value>),
) -> Value {
    let mut instances = settings
        .get("providerInstances")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut entry = instances
        .get(&provider.instance_id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| {
            let mut m = Map::new();
            m.insert("driver".to_owned(), Value::String(provider.driver.clone()));
            m.insert("enabled".to_owned(), Value::Bool(provider.enabled));
            m
        });
    entry
        .entry("driver".to_owned())
        .or_insert_with(|| Value::String(provider.driver.clone()));
    mutate(&mut entry);
    instances.insert(provider.instance_id.clone(), Value::Object(entry));
    json!({ "providerInstances": Value::Object(instances) })
}

fn read_instance_config_str(settings: &Value, instance_id: &str, key: &str) -> String {
    settings
        .get("providerInstances")
        .and_then(|m| m.get(instance_id))
        .and_then(|inst| inst.get("config"))
        .and_then(|cfg| cfg.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn read_instance_display_name(settings: &Value, provider: &ServerProvider) -> String {
    settings
        .get("providerInstances")
        .and_then(|m| m.get(&provider.instance_id))
        .and_then(|inst| inst.get("displayName"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| provider.display_name.clone())
        .unwrap_or_default()
}

fn read_custom_models(settings: &Value, instance_id: &str) -> Vec<String> {
    settings
        .get("providerInstances")
        .and_then(|m| m.get(instance_id))
        .and_then(|inst| inst.get("config"))
        .and_then(|cfg| cfg.get("customModels"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.as_str()
                        .or_else(|| item.get("slug").and_then(Value::as_str))
                        .map(ToOwned::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

impl P0App {
    pub(crate) fn render_providers(
        &mut self,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut col = div().flex().flex_col().gap(px(12.0)).child(
            div().flex().items_center().gap(px(8.0)).child(
                Button::new("providers-refresh")
                    .label(self.i18n.tr("Refresh").to_owned())
                    .compact()
                    .outline()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.bridge.refresh_providers();
                        cx.notify();
                    })),
            ),
        );

        let Some(config) = self.bridge.server_config() else {
            return col.child(div().text_sm().text_color(palette.muted_foreground).child(
                SharedString::from(self.i18n.get(p0_i18n::Key::Loading).to_owned()),
            ));
        };
        let settings = self.bridge.server_settings().unwrap_or_else(|| json!({}));
        let prefs = ProviderModelPrefs::from_settings(&settings);

        // Idle compaction setting (applies to Claude providers)
        let mut compaction_choices = div().flex().flex_wrap().gap(px(6.0));
        for (value, label) in [
            ("onReturn", "When you return"),
            ("beforeCacheExpires", "Before the cache expires (beta)"),
            ("off", "Never"),
        ] {
            compaction_choices = compaction_choices.child(
                choice(
                    format!("idle-compaction-{value}"),
                    self.i18n.tr(label).to_owned(),
                    prefs.idle_compaction == value,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bridge
                        .update_settings(json!({ "idleCompaction": value }));
                    cx.notify();
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Compact idle threads"),
            compaction_choices,
            palette,
        ));

        for provider in &config.providers {
            col = col
                .child(self.render_provider_card(provider, &settings, &prefs, palette, window, cx));
        }

        if !prefs.usage_limit_sources.is_empty() {
            let mut sources_box = div().flex().flex_col().gap(px(6.0)).pt(px(8.0)).child(
                div()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(
                        self.i18n.tr("Usage providers").to_owned(),
                    )),
            );
            for (id, label, url, enabled) in prefs.usage_limit_sources {
                let remove_id = id.clone();
                sources_box = sources_box.child(
                    crate::feed::card(palette).child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(SharedString::from(label)),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(palette.muted_foreground)
                                            .truncate()
                                            .child(SharedString::from(format!(
                                                "{url}{}",
                                                if enabled { "" } else { " · Disabled" }
                                            ))),
                                    ),
                            )
                            .child(
                                Button::new(SharedString::from(format!("usage-src-rm-{id}")))
                                    .label(self.i18n.tr("Remove").to_owned())
                                    .compact()
                                    .outline()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.bridge.update_settings(
                                            json!({ "usageLimitSources": { remove_id.clone(): Value::Null } }),
                                        );
                                        cx.notify();
                                    })),
                            ),
                    ),
                );
            }
            col = col.child(sources_box);
        }

        col
    }

    fn render_provider_card(
        &mut self,
        provider: &ServerProvider,
        settings: &Value,
        prefs: &ProviderModelPrefs,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (dot, status) = match provider.status {
            ServerProviderState::Ready => (palette.success, self.i18n.tr("Ready")),
            ServerProviderState::Warning => (palette.warning, self.i18n.tr("Warning")),
            ServerProviderState::Error => (palette.error, self.i18n.get(p0_i18n::Key::Error)),
            ServerProviderState::Disabled => (palette.muted_foreground, self.i18n.tr("Disabled")),
            ServerProviderState::Unknown => (palette.muted_foreground, ""),
        };
        let instance_id = provider.instance_id.clone();
        let is_expanded = self.settings_ui.providers.expanded.contains(&instance_id);
        let toggle_id = instance_id.clone();
        let enable_provider = provider.clone();
        let enable_settings = settings.clone();

        let status_meta = [
            Some(status.to_owned()),
            provider.version.clone(),
            provider.auth.as_ref().and_then(|a| {
                a.label
                    .clone()
                    .or_else(|| (a.status != "unknown").then(|| a.status.clone()))
            }),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");

        let mut c = crate::feed::card(palette).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(
                    div()
                        .id(SharedString::from(format!("prov-expand-{instance_id}")))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .min_w_0()
                        .flex_1()
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.settings_ui.providers.expanded.remove(&toggle_id) {
                                this.settings_ui
                                    .providers
                                    .expanded
                                    .insert(toggle_id.clone());
                            }
                            cx.notify();
                        }))
                        .child(
                            div()
                                .text_xs()
                                .text_color(palette.muted_foreground)
                                .child(if is_expanded { "▾" } else { "▸" }),
                        )
                        .child(
                            div()
                                .flex_none()
                                .w(px(8.0))
                                .h(px(8.0))
                                .rounded_full()
                                .bg(dot),
                        )
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .truncate()
                                .child(SharedString::from(provider.label().to_owned())),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(palette.muted_foreground)
                                .child(SharedString::from(provider.driver.clone())),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .flex_none()
                        .child(
                            div()
                                .text_xs()
                                .text_color(palette.muted_foreground)
                                .child(SharedString::from(status_meta)),
                        )
                        .child(
                            Switch::new(SharedString::from(format!("prov-enable-{instance_id}")))
                                .checked(provider.enabled)
                                .on_click(cx.listener(move |this, checked: &bool, _, cx| {
                                    let patch = build_provider_instance_patch(
                                        &enable_settings,
                                        &enable_provider,
                                        |entry| {
                                            entry.insert(
                                                "enabled".to_owned(),
                                                Value::Bool(*checked),
                                            );
                                        },
                                    );
                                    this.bridge.update_settings_and_refresh_config(patch);
                                    cx.notify();
                                })),
                        ),
                ),
        );

        if let Some(message) = provider.message.as_deref().filter(|m| !m.is_empty()) {
            c = c.child(
                div()
                    .text_xs()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(message.to_owned())),
            );
        }

        if !is_expanded {
            let model_count = provider.models.len();
            if model_count > 0 {
                let preview = provider
                    .models
                    .iter()
                    .take(5)
                    .map(|m| m.short_name.clone().unwrap_or_else(|| m.name.clone()))
                    .collect::<Vec<_>>()
                    .join(", ");
                let suffix = if model_count > 5 {
                    format!(" (+{})", model_count - 5)
                } else {
                    String::new()
                };
                c = c.child(
                    div()
                        .text_xs()
                        .text_color(palette.muted_foreground)
                        .child(SharedString::from(format!("{preview}{suffix}"))),
                );
            }
            return c;
        }

        // Expanded: instance display name + binary path + interactive models list + custom models
        let init_name = read_instance_display_name(settings, provider);
        let name_placeholder = self.i18n.tr("Display name").to_owned();
        let name_input = self
            .settings_ui
            .providers
            .display_name_inputs
            .entry(instance_id.clone())
            .or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder(name_placeholder);
                    st.set_value(init_name, window, cx);
                    st
                })
            })
            .clone();

        let init_bin = read_instance_config_str(settings, &instance_id, "binaryPath");
        let bin_placeholder = self.i18n.tr("Binary path (optional)").to_owned();
        let bin_input = self
            .settings_ui
            .providers
            .binary_path_inputs
            .entry(instance_id.clone())
            .or_insert_with(|| {
                cx.new(|cx| {
                    let mut st = InputState::new(window, cx).placeholder(bin_placeholder);
                    st.set_value(init_bin, window, cx);
                    st
                })
            })
            .clone();

        let save_provider = provider.clone();
        let save_settings = settings.clone();
        let save_name_in = name_input.clone();
        let save_bin_in = bin_input.clone();

        c = c.child(
            div()
                .pt(px(8.0))
                .border_t_1()
                .border_color(palette.border)
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .flex()
                        .items_end()
                        .gap(px(8.0))
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .flex()
                                .flex_col()
                                .gap(px(3.0))
                                .child(div().text_xs().text_color(palette.muted_foreground).child(
                                    SharedString::from(self.i18n.tr("Display name").to_owned()),
                                ))
                                .child(Input::new(&name_input)),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .flex()
                                .flex_col()
                                .gap(px(3.0))
                                .child(div().text_xs().text_color(palette.muted_foreground).child(
                                    SharedString::from(self.i18n.tr("Binary path").to_owned()),
                                ))
                                .child(Input::new(&bin_input)),
                        )
                        .child(
                            div().flex_none().child(
                                Button::new(SharedString::from(format!("prov-save-{instance_id}")))
                                    .label(self.i18n.tr("Save").to_owned())
                                    .compact()
                                    .primary()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        let display_name =
                                            save_name_in.read(cx).value().trim().to_owned();
                                        let binary_path =
                                            save_bin_in.read(cx).value().trim().to_owned();
                                        let patch = build_provider_instance_patch(
                                            &save_settings,
                                            &save_provider,
                                            |entry| {
                                                if display_name.is_empty() {
                                                    entry.remove("displayName");
                                                } else {
                                                    entry.insert(
                                                        "displayName".to_owned(),
                                                        Value::String(display_name),
                                                    );
                                                }
                                                let mut cfg = entry
                                                    .get("config")
                                                    .and_then(Value::as_object)
                                                    .cloned()
                                                    .unwrap_or_default();
                                                if binary_path.is_empty() {
                                                    cfg.remove("binaryPath");
                                                } else {
                                                    cfg.insert(
                                                        "binaryPath".to_owned(),
                                                        Value::String(binary_path),
                                                    );
                                                }
                                                entry.insert(
                                                    "config".to_owned(),
                                                    Value::Object(cfg),
                                                );
                                            },
                                        );
                                        this.bridge.update_settings_and_refresh_config(patch);
                                        cx.notify();
                                    })),
                            ),
                        ),
                ),
        );

        // Models section
        let mut models_col = div()
            .pt(px(8.0))
            .border_t_1()
            .border_color(palette.border)
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(
                div()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(self.i18n.tr("Models").to_owned())),
            );

        for (mx, model) in provider.models.iter().enumerate() {
            let fav = prefs.is_favorite(&instance_id, &model.slug);
            let hidden = prefs.is_hidden(&instance_id, &model.slug);
            let is_default = prefs.is_default(&instance_id, &model.slug);
            let fav_inst = instance_id.clone();
            let fav_slug = model.slug.clone();
            let hide_inst = instance_id.clone();
            let hide_slug = model.slug.clone();
            let def_inst = instance_id.clone();
            let def_slug = model.slug.clone();
            let label = model.short_name.as_deref().unwrap_or(&model.name);

            let mut row = div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .py(px(4.0))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(if hidden {
                                    palette.muted_foreground
                                } else {
                                    palette.foreground
                                })
                                .truncate()
                                .child(SharedString::from(label.to_owned())),
                        )
                        .child(
                            div()
                                .text_xs()
                                .font_family("monospace")
                                .text_color(palette.muted_foreground)
                                .truncate()
                                .child(SharedString::from(model.slug.clone())),
                        ),
                );

            let mut controls = div().flex().items_center().gap(px(4.0)).flex_none();
            controls = controls.child(
                choice(
                    format!("model-fav-{instance_id}-{mx}"),
                    if fav { "★" } else { "☆" },
                    fav,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.bridge.update_settings(json!({
                        "setModelFavorites": [{
                            "provider": fav_inst.clone(),
                            "model": fav_slug.clone(),
                            "favorite": !fav,
                        }]
                    }));
                    cx.notify();
                })),
            );
            controls = controls.child(
                choice(
                    format!("model-def-{instance_id}-{mx}"),
                    if is_default {
                        self.i18n.tr("Default").to_owned()
                    } else {
                        self.i18n.tr("Set default").to_owned()
                    },
                    is_default,
                    palette,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    let next = if is_default {
                        Value::Null
                    } else {
                        json!({ "instanceId": def_inst.clone(), "model": def_slug.clone() })
                    };
                    this.bridge
                        .update_settings(json!({ "defaultModelSelection": next }));
                    cx.notify();
                })),
            );
            if !model.is_custom {
                controls = controls.child(
                    choice(
                        format!("model-hide-{instance_id}-{mx}"),
                        if hidden {
                            self.i18n.tr("Hidden").to_owned()
                        } else {
                            self.i18n.tr("Visible").to_owned()
                        },
                        !hidden,
                        palette,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.bridge.update_settings(json!({
                            "setModelsHidden": [{
                                "provider": hide_inst.clone(),
                                "model": hide_slug.clone(),
                                "hidden": !hidden,
                            }]
                        }));
                        cx.notify();
                    })),
                );
            } else {
                let rm_provider = provider.clone();
                let rm_settings = settings.clone();
                let rm_slug = model.slug.clone();
                controls = controls.child(
                    Button::new(SharedString::from(format!("model-rm-{instance_id}-{mx}")))
                        .label(self.i18n.tr("Remove").to_owned())
                        .compact()
                        .outline()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let existing =
                                read_custom_models(&rm_settings, &rm_provider.instance_id);
                            let kept: Vec<Value> = existing
                                .into_iter()
                                .filter(|s| s != &rm_slug)
                                .map(|s| json!({ "slug": s, "name": s }))
                                .collect();
                            let patch = build_provider_instance_patch(
                                &rm_settings,
                                &rm_provider,
                                |entry| {
                                    let mut cfg = entry
                                        .get("config")
                                        .and_then(Value::as_object)
                                        .cloned()
                                        .unwrap_or_default();
                                    cfg.insert("customModels".to_owned(), Value::Array(kept));
                                    entry.insert("config".to_owned(), Value::Object(cfg));
                                },
                            );
                            this.bridge.update_settings_and_refresh_config(patch);
                            cx.notify();
                        })),
                );
            }
            row = row.child(controls);
            models_col = models_col.child(row);
        }

        // Add custom model input
        if provider.driver != "antigravity" {
            let custom_placeholder = self.i18n.tr("Add custom model").to_owned();
            let custom_input = self
                .settings_ui
                .providers
                .custom_model_inputs
                .entry(instance_id.clone())
                .or_insert_with(|| {
                    cx.new(|cx| InputState::new(window, cx).placeholder(custom_placeholder))
                })
                .clone();
            let add_in = custom_input.clone();
            let add_provider = provider.clone();
            let add_settings = settings.clone();
            models_col = models_col.child(
                div()
                    .pt(px(6.0))
                    .flex()
                    .gap(px(6.0))
                    .child(div().flex_1().child(Input::new(&custom_input)))
                    .child(
                        Button::new(SharedString::from(format!("prov-add-model-{instance_id}")))
                            .label(self.i18n.tr("Add").to_owned())
                            .compact()
                            .outline()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let slug = add_in.read(cx).value().trim().to_owned();
                                if slug.is_empty() {
                                    return;
                                }
                                let mut existing =
                                    read_custom_models(&add_settings, &add_provider.instance_id);
                                if !existing.iter().any(|s| s == &slug) {
                                    existing.push(slug);
                                }
                                let next_models: Vec<Value> = existing
                                    .into_iter()
                                    .map(|s| json!({ "slug": s, "name": s }))
                                    .collect();
                                add_in.update(cx, |s, cx| s.set_value("", window, cx));
                                let patch = build_provider_instance_patch(
                                    &add_settings,
                                    &add_provider,
                                    |entry| {
                                        let mut cfg = entry
                                            .get("config")
                                            .and_then(Value::as_object)
                                            .cloned()
                                            .unwrap_or_default();
                                        cfg.insert(
                                            "customModels".to_owned(),
                                            Value::Array(next_models),
                                        );
                                        entry.insert("config".to_owned(), Value::Object(cfg));
                                    },
                                );
                                this.bridge.update_settings_and_refresh_config(patch);
                                cx.notify();
                            })),
                    ),
            );
        }

        c.child(models_col)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_provider() -> ServerProvider {
        serde_json::from_value(json!({
            "instanceId": "codex",
            "driver": "codex",
            "displayName": "Codex",
            "enabled": true,
            "installed": true,
            "status": "ready",
            "models": []
        }))
        .unwrap()
    }

    #[test]
    fn parses_model_preferences_favorites_and_hidden() {
        let settings = json!({
            "favorites": [{"provider": "codex", "model": "gpt-5"}],
            "providerModelPreferences": {
                "codex": {"hiddenModels": ["gpt-4"], "modelOrder": []}
            },
            "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "idleCompaction": "beforeCacheExpires"
        });
        let prefs = ProviderModelPrefs::from_settings(&settings);
        assert!(prefs.is_favorite("codex", "gpt-5"));
        assert!(!prefs.is_favorite("codex", "gpt-4"));
        assert!(prefs.is_hidden("codex", "gpt-4"));
        assert!(prefs.is_default("codex", "gpt-5"));
        assert_eq!(prefs.idle_compaction, "beforeCacheExpires");
    }

    #[test]
    fn provider_instance_patch_preserves_siblings() {
        let settings = json!({
            "providerInstances": {
                "claudeAgent": {"driver": "claudeAgent", "enabled": true}
            }
        });
        let patch = build_provider_instance_patch(&settings, &sample_provider(), |entry| {
            entry.insert("enabled".to_owned(), Value::Bool(false));
        });
        assert_eq!(patch["providerInstances"]["claudeAgent"]["enabled"], true);
        assert_eq!(patch["providerInstances"]["codex"]["enabled"], false);
        assert_eq!(patch["providerInstances"]["codex"]["driver"], "codex");
    }
}
