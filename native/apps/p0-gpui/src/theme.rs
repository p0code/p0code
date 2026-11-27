//! Dark and light color tokens mirroring `apps/web/src/index.css`.

use gpui_kit::{Hsla, WindowAppearance, rgba};

#[derive(Debug, Clone, Copy)]
pub struct AppPalette {
    pub is_dark: bool,
    pub background: Hsla,
    pub sidebar: Hsla,
    pub card: Hsla,
    pub message_user: Hsla,
    pub code_bg: Hsla,
    pub foreground: Hsla,
    pub muted_foreground: Hsla,
    pub border: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    pub row_hover: Hsla,
    pub row_selected: Hsla,
    pub success: Hsla,
    pub warning: Hsla,
    pub warning_surface: Hsla,
    pub error: Hsla,
    pub error_surface: Hsla,
    pub info: Hsla,
    pub badge_approval: Hsla,
}

impl AppPalette {
    pub fn for_appearance(appearance: WindowAppearance) -> Self {
        match appearance {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::dark(),
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::light(),
        }
    }

    pub fn light() -> Self {
        Self {
            is_dark: false,
            // --color-zinc-25
            background: rgba(0xfcfcfcff).into(),
            // --color-zinc-50
            sidebar: rgba(0xfafafaff).into(),
            // --color-white
            card: rgba(0xffffffff).into(),
            // --message-surface
            message_user: rgba(0xededf0ff).into(),
            // --code-background
            code_bg: rgba(0xf4f4f6ff).into(),
            // --color-zinc-900
            foreground: rgba(0x18181bff).into(),
            // --color-zinc-500
            muted_foreground: rgba(0x71717aff).into(),
            // --color-zinc-200
            border: rgba(0xe4e4e7ff).into(),
            // --primary oklch(0.488 0.217 264)
            primary: rgba(0x2f54ebff).into(),
            primary_foreground: rgba(0xffffffff).into(),
            row_hover: rgba(0xf4f4f5ff).into(),
            row_selected: rgba(0xffffffff).into(),
            // --success emerald-500
            success: rgba(0x10b981ff).into(),
            // --warning amber-500
            warning: rgba(0xf59e0bff).into(),
            warning_surface: rgba(0xf59e0b18).into(),
            // --error red-500
            error: rgba(0xef4444ff).into(),
            error_surface: rgba(0xef444418).into(),
            // --info blue-500
            info: rgba(0x3b82f6ff).into(),
            // --guest / approval fuchsia-500
            badge_approval: rgba(0xd946efff).into(),
        }
    }

    pub fn dark() -> Self {
        Self {
            is_dark: true,
            // --background: #000
            background: rgba(0x000000ff).into(),
            // --sidebar: color-mix(neutral-950 97%, white)
            sidebar: rgba(0x0a0a0bff).into(),
            // --card
            card: rgba(0x0e0e10ff).into(),
            // --message-surface
            message_user: rgba(0x19191dff).into(),
            // --code-background
            code_bg: rgba(0x121216ff).into(),
            // --foreground: #f1f3f7
            foreground: rgba(0xf1f3f7ff).into(),
            // --muted-foreground: #a3a3a3
            muted_foreground: rgba(0xa3a3a3ff).into(),
            // --border: rgba(255,255,255,0.08)
            border: rgba(0xffffff16).into(),
            // --primary oklch(0.571 0.21 264)
            primary: rgba(0x4c6ef5ff).into(),
            primary_foreground: rgba(0xffffffff).into(),
            row_hover: rgba(0xffffff12).into(),
            row_selected: rgba(0xffffff1a).into(),
            // --success-foreground emerald-400
            success: rgba(0x34d399ff).into(),
            // --warning-foreground amber-400
            warning: rgba(0xfbbf24ff).into(),
            warning_surface: rgba(0xf59e0b26).into(),
            // --error-foreground red-400
            error: rgba(0xf87171ff).into(),
            error_surface: rgba(0xef444426).into(),
            // --info-foreground blue-400
            info: rgba(0x60a5faff).into(),
            // --guest-foreground fuchsia-300
            badge_approval: rgba(0xf0abfcff).into(),
        }
    }
}
