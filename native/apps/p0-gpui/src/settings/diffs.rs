//! Diffs & pull requests settings (`/settings/diffs`): client-side diff layout, whitespace,
//! default file collapse, color scheme, proactive panels, and in-app PR links stored in
//! `LocalPrefs` (mirroring `ClientSettingsSchema`).

use gpui_kit::component::switch::Switch;
use gpui_kit::{
    Context, IntoElement, ParentElement as _, StatefulInteractiveElement as _, Styled as _, div, px,
};

use crate::app::P0App;
use crate::feed::choice;
use crate::settings::general::section_heading;
use crate::settings::setting_row;
use crate::theme::AppPalette;

impl P0App {
    pub(crate) fn render_diffs_settings(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut col = div().flex().flex_col().gap(px(12.0));

        // 1. Diffs
        col = col.child(section_heading(self.i18n.tr("Diffs"), palette));

        let mut layout = div().flex().gap(px(6.0));
        for (val, label) in [("stacked", "Stacked"), ("split", "Split")] {
            layout = layout.child(
                choice(
                    format!("diff-layout-{val}"),
                    self.i18n.tr(label).to_owned(),
                    self.prefs.diff_layout == val,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.diff_layout = val.to_owned();
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(self.i18n.tr("Diff layout"), layout, palette));

        col = col.child(setting_row(
            self.i18n.tr("Hide whitespace changes by default"),
            Switch::new("diff-ignore-ws")
                .checked(self.prefs.diff_ignore_whitespace)
                .on_click(cx.listener(|this, val: &bool, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.diff_ignore_whitespace = *val;
                    this.set_prefs(prefs, window, cx);
                })),
            palette,
        ));

        let mut file_state = div().flex().gap(px(6.0));
        for (collapsed, label) in [(false, "Expanded"), (true, "Collapsed")] {
            file_state = file_state.child(
                choice(
                    format!("diff-files-{collapsed}"),
                    self.i18n.tr(label).to_owned(),
                    self.prefs.diff_files_collapsed == collapsed,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.diff_files_collapsed = collapsed;
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(
            self.i18n.tr("Default diff file state"),
            file_state,
            palette,
        ));

        let mut colors = div().flex().gap(px(6.0));
        for (scheme, label) in [
            ("red-green", "Red / Green"),
            ("blue-orange", "Blue / Orange"),
        ] {
            colors = colors.child(
                choice(
                    format!("diff-colors-{scheme}"),
                    label.to_owned(),
                    self.prefs.diff_color_scheme == scheme,
                    palette,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.diff_color_scheme = scheme.to_owned();
                    this.set_prefs(prefs, window, cx);
                })),
            );
        }
        col = col.child(setting_row(self.i18n.tr("Diff colors"), colors, palette));

        // 2. Pull requests
        col = col.child(section_heading(self.i18n.tr("Pull requests"), palette));

        col = col.child(setting_row(
            self.i18n
                .tr("Open pull requests and changes panels proactively"),
            Switch::new("diff-proactive-panels")
                .checked(self.prefs.proactive_panels_enabled)
                .on_click(cx.listener(|this, val: &bool, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.proactive_panels_enabled = *val;
                    this.set_prefs(prefs, window, cx);
                })),
            palette,
        ));

        col = col.child(setting_row(
            self.i18n.tr("Open pull request links in app"),
            Switch::new("diff-pr-links-in-app")
                .checked(self.prefs.pull_request_links_open_in_app)
                .on_click(cx.listener(|this, val: &bool, window, cx| {
                    let mut prefs = this.prefs.clone();
                    prefs.pull_request_links_open_in_app = *val;
                    this.set_prefs(prefs, window, cx);
                })),
            palette,
        ));

        col
    }
}
