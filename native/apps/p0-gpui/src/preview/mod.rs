//! The Preview tab: a dev server or other allowed URL, and PDFs from the file explorer or chat
//! attachments, in the OS webview where this build embeds one. Elsewhere it shows the address
//! and opens it in the system browser.

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native;
pub mod policy;
mod slot;

use gpui_kit::component::Disableable as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::{
    App, AppContext as _, Context, Entity, Global, IntoElement, ParentElement as _, SharedString,
    Styled as _, Subscription, WeakEntity, Window, div, px,
};
use p0_protocol::{
    AssetResource, ChatAttachment, CreateAssetUrlInput, CreateAssetUrlResult, RPC_ASSETS_CREATE_URL,
};
use url::Url;

use crate::app::P0App;
use crate::right_panel::PanelTab;
use crate::theme::AppPalette;
use policy::{Origin, UrlError};
pub use slot::{EMBEDDED, WebSlot};

/// A file the server signs a short-lived, credential-free URL for (`assets.createUrl`).
#[derive(Debug, Clone, PartialEq)]
pub enum DocSource {
    WorkspaceFile { thread_id: String, path: String },
    Attachment(ChatAttachment),
}

impl DocSource {
    pub fn name(&self) -> &str {
        match self {
            Self::WorkspaceFile { path, .. } => path.rsplit('/').next().unwrap_or(path),
            Self::Attachment(att) => &att.name,
        }
    }

    fn resource(&self) -> AssetResource {
        match self {
            Self::WorkspaceFile { thread_id, path } => AssetResource::WorkspaceFile {
                thread_id: thread_id.clone(),
                path: path.clone(),
            },
            Self::Attachment(att) => AssetResource::Attachment {
                attachment_id: att.id.clone(),
                file_name: (!att.name.is_empty()).then(|| att.name.clone()),
                mime_type: Some(if att.mime_type.is_empty() {
                    "application/pdf".to_owned()
                } else {
                    att.mime_type.clone()
                }),
                disposition: Some("inline".to_owned()),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    Empty,
    Page(Url),
    Document {
        source: DocSource,
        /// `None` while the signed URL is being minted.
        url: Option<Url>,
        error: Option<String>,
    },
}

pub struct PreviewPanel {
    pub content: Content,
    pub error: Option<UrlError>,
    pub web: WebSlot,
    address: Option<(Entity<InputState>, Subscription)>,
    /// Text for the address bar, applied on the next render (it needs the window).
    pending_address: Option<String>,
}

impl PreviewPanel {
    pub fn new() -> Self {
        Self {
            content: Content::Empty,
            error: None,
            web: WebSlot::default(),
            address: None,
            pending_address: None,
        }
    }

    /// Whether the webview should be on screen when the Preview tab is.
    pub fn wants_webview(&self) -> bool {
        EMBEDDED
            && self.web.error().is_none()
            && match &self.content {
                Content::Page(_) => true,
                Content::Document { url, error, .. } => url.is_some() && error.is_none(),
                Content::Empty => false,
            }
    }

    /// Shows `url` (already allowed by [`policy::resolve`]).
    fn show_page(&mut self, url: Url) {
        self.pending_address = Some(url.to_string());
        if EMBEDDED {
            self.web.navigate(url.as_str());
        }
        self.content = Content::Page(url);
        self.error = None;
    }
}

/// Lets chat links, rendered by free functions with only `&mut App`, reach the Preview tab.
pub struct LinkTarget {
    pub app: WeakEntity<P0App>,
    pub server_base: String,
}

impl Global for LinkTarget {}

/// Opens a chat link: local addresses in the Preview tab where it embeds a webview, everything
/// else (and everything on builds without one) in the system browser.
pub fn open_link(url: &str, cx: &mut App) {
    let target = cx
        .try_global::<LinkTarget>()
        .filter(|t| EMBEDDED && policy::is_previewable_link(url, &t.server_base))
        .map(|t| t.app.clone());
    let opened = target.is_some_and(|app| {
        app.update(cx, |app, cx| app.open_preview(url, Origin::Link, cx))
            .is_ok()
    });
    if !opened {
        cx.open_url(url);
    }
}

impl P0App {
    /// Opens `text` in the Preview tab when the policy allows it; refusals show in the tab.
    pub(crate) fn open_preview(&mut self, text: &str, origin: Origin, cx: &mut Context<Self>) {
        let base = self.bridge.base_url().to_owned();
        let preview = &mut self.right_panel.preview;
        match policy::resolve(text, &base, origin) {
            Ok(url) => preview.show_page(url),
            Err(err) => preview.error = Some(err),
        }
        self.show_right_panel(PanelTab::Preview, cx);
    }

    pub(crate) fn open_document(&mut self, source: DocSource, cx: &mut Context<Self>) {
        let preview = &mut self.right_panel.preview;
        preview.pending_address = Some(source.name().to_owned());
        preview.error = None;
        preview.content = Content::Document {
            source: source.clone(),
            url: None,
            error: None,
        };
        let mint = self.mint_asset_url(&source);
        cx.spawn(async move |this, cx| {
            let result = mint.await;
            this.update(cx, |app, cx| {
                let preview = &mut app.right_panel.preview;
                let Content::Document {
                    source: s,
                    url,
                    error,
                } = &mut preview.content
                else {
                    return;
                };
                if *s != source {
                    return;
                }
                match result {
                    Ok(signed) => {
                        if EMBEDDED {
                            preview.web.navigate(signed.as_str());
                        }
                        *url = Some(signed);
                    }
                    Err(err) => *error = Some(err),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        self.show_right_panel(PanelTab::Preview, cx);
    }

    fn mint_asset_url(
        &self,
        source: &DocSource,
    ) -> impl Future<Output = Result<Url, String>> + use<> {
        let base = self.bridge.base_url().to_owned();
        let fetch = self.bridge.query::<_, CreateAssetUrlResult>(
            RPC_ASSETS_CREATE_URL,
            CreateAssetUrlInput {
                resource: source.resource(),
            },
        );
        async move {
            let signed = fetch.await?;
            policy::asset_url(&base, &signed.relative_url)
                .ok_or_else(|| "unexpected asset URL".to_owned())
        }
    }

    /// The system browser gets the page's current address, or a freshly signed document URL
    /// (signed URLs expire, and carry no session credential).
    fn open_preview_externally(&mut self, cx: &mut Context<Self>) {
        match &self.right_panel.preview.content {
            Content::Empty => {}
            Content::Page(url) => {
                let current = self.right_panel.preview.web.current_url();
                let target = current
                    .filter(|u| policy::page_may_navigate(u) && u != "about:blank")
                    .unwrap_or_else(|| url.to_string());
                cx.open_url(&target);
            }
            Content::Document { source, .. } => {
                let mint = self.mint_asset_url(source);
                cx.spawn(async move |_, cx| {
                    if let Ok(url) = mint.await {
                        cx.update(|cx| cx.open_url(url.as_str()));
                    }
                })
                .detach();
            }
        }
    }

    fn preview_address(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        let placeholder = self.i18n.tr("localhost:3000 or https://…").to_owned();
        let preview = &mut self.right_panel.preview;
        let input = match &preview.address {
            Some((input, _)) => input.clone(),
            None => {
                let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
                let sub = cx.subscribe_in(&input, window, |this, input, event, _, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        let text = input.read(cx).value().to_string();
                        this.open_preview(&text, Origin::Typed, cx);
                    }
                });
                preview.address = Some((input.clone(), sub));
                input
            }
        };
        if let Some(text) = preview.pending_address.take() {
            input.update(cx, |state, cx| state.set_value(text, window, cx));
        }
        input
    }

    pub(crate) fn render_preview(
        &mut self,
        palette: &AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let address = self.preview_address(window, cx);
        let t = |s: &'static str| SharedString::from(self.i18n.tr(s).to_owned());
        let nav = |id: &'static str, label: &'static str, tip: SharedString| {
            Button::new(id).label(label).compact().ghost().tooltip(tip)
        };
        let has_content = self.right_panel.preview.content != Content::Empty;
        let mut toolbar = div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4.0))
            .px(px(8.0))
            .py(px(6.0))
            .border_b_1()
            .border_color(palette.border);
        if EMBEDDED {
            toolbar =
                toolbar
                    .child(
                        nav("preview-back", "←", t("Back")).on_click(
                            cx.listener(|this, _, _, _| this.right_panel.preview.web.back()),
                        ),
                    )
                    .child(nav("preview-forward", "→", t("Forward")).on_click(
                        cx.listener(|this, _, _, _| this.right_panel.preview.web.forward()),
                    ))
                    .child(nav("preview-reload", "⟳", t("Reload")).on_click(
                        cx.listener(|this, _, _, _| this.right_panel.preview.web.reload()),
                    ));
        }
        toolbar = toolbar
            .child(div().flex_1().min_w_0().child(Input::new(&address)))
            .child(
                Button::new("preview-external")
                    .label(t("Open in browser"))
                    .compact()
                    .outline()
                    .disabled(!has_content)
                    .on_click(cx.listener(|this, _, _, cx| this.open_preview_externally(cx))),
            );

        let preview = &self.right_panel.preview;
        let message = |text: SharedString, color| {
            div()
                .px(px(12.0))
                .py(px(8.0))
                .text_sm()
                .text_color(color)
                .child(text)
        };
        let mut body = div().flex_1().min_h_0().flex().flex_col();
        if let Some(err) = preview.error {
            body = body.child(message(t(err.message()), palette.error));
        }
        if let Some(err) = preview.web.error() {
            body = body.child(message(SharedString::from(err), palette.error));
        }
        body = match &preview.content {
            Content::Empty => body.child(message(
                t("Preview a local dev server, this server's forwarded ports, or an https page."),
                palette.muted_foreground,
            )),
            Content::Document {
                url: None,
                error: None,
                ..
            } => body.child(message(t("Loading…"), palette.muted_foreground)),
            Content::Document {
                error: Some(err), ..
            } => body.child(message(SharedString::from(err.clone()), palette.error)),
            _ if preview.wants_webview() => {
                body.child(div().flex_1().min_h_0().child(preview.web.element()))
            }
            Content::Page(url) => body.child(fallback(
                SharedString::from(url.to_string()),
                t("This build has no embedded browser. Open the page in your browser."),
                palette,
            )),
            Content::Document { source, .. } => body.child(fallback(
                SharedString::from(source.name().to_owned()),
                t("This build has no embedded PDF viewer. Open the file in your browser."),
                palette,
            )),
        };
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(toolbar)
            .child(body)
    }
}

fn fallback(title: SharedString, hint: SharedString, palette: &AppPalette) -> impl IntoElement {
    div()
        .p(px(16.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .text_sm()
                .text_color(palette.foreground)
                .truncate()
                .child(title),
        )
        .child(
            div()
                .text_xs()
                .text_color(palette.muted_foreground)
                .child(hint),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_are_signed_by_resource() {
        let ws = DocSource::WorkspaceFile {
            thread_id: "t".into(),
            path: "docs/a/Spec.pdf".into(),
        };
        assert_eq!(ws.name(), "Spec.pdf");
        assert_eq!(
            ws.resource(),
            AssetResource::WorkspaceFile {
                thread_id: "t".into(),
                path: "docs/a/Spec.pdf".into()
            }
        );
        let att = DocSource::Attachment(ChatAttachment {
            kind: p0_protocol::AttachmentType::File,
            id: "att-1".into(),
            name: "r.pdf".into(),
            mime_type: "application/pdf".into(),
            size_bytes: 9,
        });
        let AssetResource::Attachment { disposition, .. } = att.resource() else {
            panic!("attachment resource");
        };
        assert_eq!(disposition.as_deref(), Some("inline"));
    }

    #[test]
    fn webview_only_for_ready_content_on_embedding_builds() {
        let mut panel = PreviewPanel::new();
        assert!(!panel.wants_webview());
        panel.show_page(Url::parse("http://localhost:3000").unwrap());
        assert_eq!(panel.wants_webview(), EMBEDDED);
        assert_eq!(
            panel.pending_address.as_deref(),
            Some("http://localhost:3000/")
        );
        panel.content = Content::Document {
            source: DocSource::WorkspaceFile {
                thread_id: "t".into(),
                path: "a.pdf".into(),
            },
            url: None,
            error: None,
        };
        assert!(
            !panel.wants_webview(),
            "nothing to show until the URL is signed"
        );
    }
}
