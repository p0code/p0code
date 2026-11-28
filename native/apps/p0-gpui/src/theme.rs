//! The web app's design tokens (`p0-theme`, generated from `apps/web`) applied to the app's own
//! palette and to gpui-component's theme.

use std::borrow::Cow;

use gpui_kit::component::Theme;
use gpui_kit::{App, Hsla, SharedString, WindowAppearance, px, rgba};
use p0_theme::{Palette, ThemeVariant};

/// The colors the app paints with, named after the web's Tailwind tokens they come from.
#[derive(Debug, Clone, Copy)]
pub struct AppPalette {
    pub background: Hsla,
    pub card: Hsla,
    /// `bg-message`: the user turn bubble.
    pub message_user: Hsla,
    /// `bg-code`.
    pub code_bg: Hsla,
    pub foreground: Hsla,
    pub muted_foreground: Hsla,
    pub icon_muted: Hsla,
    pub border: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    /// `hover:bg-accent` on rows outside the sidebar.
    pub row_hover: Hsla,
    pub row_selected: Hsla,
    pub success: Hsla,
    pub warning: Hsla,
    pub warning_surface: Hsla,
    pub error: Hsla,
    pub error_surface: Hsla,
    pub info: Hsla,
    pub backdrop: Hsla,
    pub sidebar: Hsla,
    pub sidebar_foreground: Hsla,
    pub sidebar_muted_foreground: Hsla,
    pub sidebar_secondary_label: Hsla,
    pub sidebar_row_hover: Hsla,
    pub sidebar_row_active: Hsla,
    /// The sidebar's outer border.
    pub sidebar_edge: Hsla,
    pub sidebar_border: Hsla,
    /// `--sidebar-icon-color`: muted sidebar text at 85% over the sidebar.
    pub sidebar_icon: Hsla,
    /// The theme's accent role (`--ring`), which tints focus and the sidebar art.
    pub primary_accent: Hsla,
    pub dark: bool,
}

/// Color scheme setting (Appearance). `System` follows the window's appearance.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemePreference {
    pub fn is_dark(self, appearance: WindowAppearance) -> bool {
        match self {
            Self::System => matches!(
                appearance,
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            ),
            Self::Light => false,
            Self::Dark => true,
        }
    }
}

fn c(v: u32) -> Hsla {
    rgba(v).into()
}

fn variant(dark: bool) -> &'static ThemeVariant {
    p0_theme::default_theme().variant(dark)
}

impl AppPalette {
    pub fn for_preference(pref: ThemePreference, appearance: WindowAppearance) -> Self {
        Self::from_variant(variant(pref.is_dark(appearance)), pref.is_dark(appearance))
    }

    fn from_variant(v: &ThemeVariant, dark: bool) -> Self {
        let a = &v.app;
        let s = &v.sidebar;
        Self {
            background: c(a.background),
            card: c(a.card),
            message_user: c(a.message),
            code_bg: c(a.code),
            foreground: c(a.foreground),
            muted_foreground: c(a.muted_foreground),
            icon_muted: c(a.icon_muted),
            border: c(a.border),
            primary: c(a.primary),
            primary_foreground: c(a.primary_foreground),
            row_hover: c(a.accent),
            row_selected: c(a.accent),
            success: c(a.success_foreground),
            warning: c(a.warning_foreground),
            warning_surface: c(a.warning_surface),
            error: c(a.error_foreground),
            error_surface: c(a.error_surface),
            info: c(a.info_foreground),
            // Dialog backdrop: `bg-black/32`, a little deeper on dark canvases.
            backdrop: Hsla::black().opacity(if dark { 0.48 } else { 0.32 }),
            sidebar: c(s.sidebar),
            sidebar_foreground: c(s.sidebar_foreground),
            sidebar_muted_foreground: c(s.sidebar_muted_foreground),
            sidebar_secondary_label: c(s.secondary_label),
            sidebar_row_hover: c(s.sidebar_row_hover),
            sidebar_row_active: c(s.sidebar_row_active),
            sidebar_edge: c(v.sidebar_edge),
            sidebar_border: c(s.sidebar_border),
            sidebar_icon: c(s.sidebar_muted_foreground).opacity(0.85),
            primary_accent: c(a.ring),
            dark,
        }
    }
}

const INTER: [&[u8]; 4] = [
    include_bytes!("../assets/fonts/Inter-Regular.ttf"),
    include_bytes!("../assets/fonts/Inter-Medium.ttf"),
    include_bytes!("../assets/fonts/Inter-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Inter-Bold.ttf"),
];

/// Registers the web app's interface font. Its stack (`p0_theme::FONT_SANS`) puts the platform
/// UI font first only on Apple systems, so elsewhere the web app renders in Inter.
pub fn register_fonts(cx: &mut App) {
    let fonts = INTER.iter().map(|b| Cow::Borrowed(*b)).collect();
    if let Err(err) = cx.text_system().add_fonts(fonts) {
        tracing::warn!("bundled fonts failed to load: {err}");
    }
}

fn ui_font_family() -> SharedString {
    if cfg!(target_os = "macos") {
        ".SystemUIFont".into()
    } else {
        "Inter".into()
    }
}

/// The first family in the web's mono stack that the platform has, like the browser picks it.
fn mono_font_family(cx: &App) -> Option<SharedString> {
    let installed = cx.text_system().all_font_names();
    p0_theme::FONT_MONO
        .iter()
        .find(|name| installed.iter().any(|f| f == *name))
        .map(|name| SharedString::from(*name))
}

/// Paints gpui-component's widgets with the web tokens. Call after `Theme::change`.
pub fn apply_component_theme(dark: bool, cx: &mut App) {
    let v = variant(dark);
    let mono = mono_font_family(cx);
    Theme::update(cx, |theme| {
        let a: &Palette = &v.app;
        let s: &Palette = &v.sidebar;
        let t = &mut theme.colors;
        t.background = c(a.background);
        t.foreground = c(a.foreground);
        t.border = c(a.border);
        t.input = c(a.input);
        t.ring = c(a.ring);
        t.caret = c(a.foreground);
        t.accent = c(a.accent);
        t.accent_foreground = c(a.accent_foreground);
        t.muted = c(a.muted);
        t.muted_foreground = c(a.muted_foreground);
        t.popover = c(a.popover);
        t.popover_foreground = c(a.popover_foreground);
        t.primary = c(a.primary);
        t.primary_hover = c(a.primary).opacity(0.9);
        t.primary_active = c(a.primary).opacity(0.8);
        t.primary_foreground = c(a.primary_foreground);
        t.secondary = c(a.secondary);
        t.secondary_hover = c(a.secondary).opacity(0.9);
        t.secondary_active = c(a.secondary).opacity(0.8);
        t.secondary_foreground = c(a.secondary_foreground);
        t.danger = c(a.destructive);
        t.danger_hover = c(a.destructive).opacity(0.9);
        t.danger_active = c(a.destructive).opacity(0.8);
        t.danger_foreground = Hsla::white();
        t.success = c(a.success);
        t.success_hover = c(a.success).opacity(0.9);
        t.success_active = c(a.success).opacity(0.8);
        t.success_foreground = Hsla::white();
        t.warning = c(a.warning);
        t.warning_hover = c(a.warning).opacity(0.9);
        t.warning_active = c(a.warning).opacity(0.8);
        t.warning_foreground = Hsla::white();
        t.info = c(a.info);
        t.info_hover = c(a.info).opacity(0.9);
        t.info_active = c(a.info).opacity(0.8);
        t.info_foreground = Hsla::white();
        // Outline button: `bg-popover`, hover `bg-accent/50` (`bg-input/64` on dark).
        t.button = c(a.popover);
        t.button_hover = if dark {
            c(a.input).opacity(0.64)
        } else {
            c(a.accent).opacity(0.5)
        };
        t.button_active = c(a.accent);
        t.button_foreground = c(a.foreground);
        t.button_primary = t.primary;
        t.button_primary_hover = t.primary_hover;
        t.button_primary_active = t.primary_active;
        t.button_primary_foreground = t.primary_foreground;
        t.button_secondary = t.secondary;
        t.button_secondary_hover = t.secondary_hover;
        t.button_secondary_active = t.secondary_active;
        t.button_secondary_foreground = t.secondary_foreground;
        t.button_danger = t.danger;
        t.button_danger_hover = t.danger_hover;
        t.button_danger_active = t.danger_active;
        t.button_danger_foreground = t.danger_foreground;
        t.link = c(a.primary);
        t.link_hover = c(a.primary);
        t.link_active = c(a.primary);
        t.list = Hsla::transparent_black();
        t.list_even = Hsla::transparent_black();
        t.list_head = c(a.background);
        t.list_hover = c(a.accent);
        t.list_active = c(a.accent);
        t.list_active_border = Hsla::transparent_black();
        t.table = c(a.card);
        t.table_head = c(a.muted);
        t.table_hover = c(a.accent);
        t.table_active = c(a.accent);
        t.table_row_border = c(a.border);
        t.tab_bar = c(a.muted);
        t.tab = Hsla::transparent_black();
        t.tab_active = c(a.background);
        t.tab_foreground = c(a.muted_foreground);
        t.tab_active_foreground = c(a.foreground);
        t.title_bar = c(a.background);
        t.title_bar_border = c(a.border);
        t.window_border = c(a.border);
        t.sidebar = c(s.sidebar);
        t.sidebar_foreground = c(s.sidebar_foreground);
        t.sidebar_border = c(v.sidebar_edge);
        t.sidebar_accent = c(s.sidebar_row_selected);
        t.sidebar_accent_foreground = c(s.sidebar_foreground);
        t.sidebar_primary = c(a.primary);
        t.sidebar_primary_foreground = c(a.primary_foreground);
        t.switch = c(a.input);
        t.switch_thumb = c(a.background);
        t.slider_bar = c(a.primary);
        t.slider_thumb = c(a.background);
        t.progress_bar = c(a.primary);
        t.selection = c(a.ring).opacity(0.25);
        t.skeleton = c(a.muted);
        t.overlay = Hsla::black().opacity(if dark { 0.48 } else { 0.32 });
        t.drop_target = c(a.primary).opacity(0.12);
        t.drag_border = c(a.ring);
        t.group_box = c(a.card);
        t.group_box_foreground = c(a.card_foreground);
        t.description_list_label = c(a.muted);
        t.description_list_label_foreground = c(a.muted_foreground);
        t.accordion = c(a.card);
        theme.font_family = ui_font_family();
        if let Some(mono) = mono.clone() {
            theme.mono_font_family = mono;
        }
        theme.font_size = px(p0_theme::DEFAULT_INTERFACE_FONT_SIZE);
        theme.mono_font_size = px(p0_theme::DEFAULT_CODE_FONT_SIZE);
        theme.radius = px(p0_theme::CONTROL_RADIUS);
        theme.radius_lg = px(p0_theme::RADIUS_XL);
    });
}
