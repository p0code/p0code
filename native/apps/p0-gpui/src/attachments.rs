//! Composer attachments: picked, pasted or dropped files upload as soon as they are added
//! (`attachments.createUploadUrl` plus a POST, as the web app does) and ride on the next send.

use std::path::PathBuf;
use std::sync::Arc;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::{
    AppContext as _, ClipboardEntry, ClipboardItem, Context, Entity, ExternalPaths, Image,
    InteractiveElement as _, IntoElement, ParentElement as _, PathPromptOptions, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, img, px,
};
use p0_client::attachments::mime_for_name;
use p0_protocol::ChatAttachment;
use serde_json::Value;

use crate::app::P0App;
use crate::theme::AppPalette;

enum Upload {
    Uploading,
    Ready(ChatAttachment),
    Failed(String),
}

enum Preview {
    Path(PathBuf),
    Image(Arc<Image>),
}

struct Pending {
    id: u64,
    name: String,
    preview: Option<Preview>,
    upload: Upload,
}

#[derive(Default)]
pub struct AttachmentTray {
    items: Vec<Pending>,
    next_id: u64,
    path_input: Option<(Entity<InputState>, Subscription)>,
}

impl AttachmentTray {
    pub fn is_uploading(&self) -> bool {
        self.items
            .iter()
            .any(|p| matches!(p.upload, Upload::Uploading))
    }

    /// The uploaded attachments as `message.dispatch` takes them.
    pub fn ready(&self) -> Vec<Value> {
        self.items
            .iter()
            .filter_map(|p| match &p.upload {
                Upload::Ready(a) => serde_json::to_value(a).ok(),
                _ => None,
            })
            .collect()
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }
}

fn human_size(bytes: u64) -> String {
    match bytes {
        b if b >= 1024 * 1024 => format!("{:.1} MB", b as f64 / (1024.0 * 1024.0)),
        b if b >= 1024 => format!("{} KB", b.div_ceil(1024)),
        b => format!("{b} B"),
    }
}

impl P0App {
    fn add_attachment(
        &mut self,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
        preview: Option<Preview>,
        cx: &mut Context<Self>,
    ) {
        let tray = &mut self.attachments;
        let id = tray.next_id;
        tray.next_id += 1;
        let size = bytes.len() as u64;
        tray.items.push(Pending {
            id,
            name: format!("{name} · {}", human_size(size)),
            preview,
            upload: Upload::Uploading,
        });
        let upload = self.bridge.upload_attachment(name, mime_type, bytes);
        cx.spawn(async move |this, cx| {
            let result = upload.await;
            this.update(cx, |app, cx| {
                if let Some(p) = app.attachments.items.iter_mut().find(|p| p.id == id) {
                    p.upload = match result {
                        Ok(a) => Upload::Ready(a),
                        Err(err) => Upload::Failed(err),
                    };
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn attach_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        for path in paths {
            let read_path = path.clone();
            let read = cx
                .background_executor()
                .spawn(async move { std::fs::read(&read_path) });
            cx.spawn(async move |this, cx| {
                let bytes = read.await;
                this.update(cx, |app, cx| {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| path.display().to_string());
                    match bytes {
                        Ok(bytes) => {
                            let mime = mime_for_name(&name).to_owned();
                            let preview = mime.starts_with("image/").then_some(Preview::Path(path));
                            app.add_attachment(name, mime, bytes, preview, cx);
                        }
                        Err(err) => {
                            let id = app.attachments.next_id;
                            app.attachments.next_id += 1;
                            app.attachments.items.push(Pending {
                                id,
                                name,
                                preview: None,
                                upload: Upload::Failed(err.to_string()),
                            });
                            cx.notify();
                        }
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    /// Takes pasted images and copied files; text falls through to the composer.
    pub(crate) fn paste_attachments(
        &mut self,
        item: &ClipboardItem,
        cx: &mut Context<Self>,
    ) -> bool {
        let mut consumed = false;
        for entry in item.entries() {
            match entry {
                ClipboardEntry::Image(image) => {
                    let name = format!("pasted-image.{}", image.format.extension());
                    let image = Arc::new(image.clone());
                    self.add_attachment(
                        name,
                        image.format.mime_type().to_owned(),
                        image.bytes.clone(),
                        Some(Preview::Image(image)),
                        cx,
                    );
                    consumed = true;
                }
                ClipboardEntry::ExternalPaths(paths) => {
                    self.attach_paths(paths.paths().to_vec(), cx);
                    consumed = true;
                }
                ClipboardEntry::String(_) => {}
            }
        }
        consumed
    }

    pub(crate) fn drop_attachments(&mut self, paths: &ExternalPaths, cx: &mut Context<Self>) {
        self.attach_paths(paths.paths().to_vec(), cx);
    }

    /// The system file picker; where none answers (no portal), a path field instead.
    pub(crate) fn pick_attachments(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: None,
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = picked.await;
            cx.update_window(window_handle, |_, window, cx| {
                this.update(cx, |app, cx| match result {
                    Ok(Ok(Some(paths))) => app.attach_paths(paths, cx),
                    Ok(Ok(None)) => {}
                    _ => app.open_attachment_path_input(window, cx),
                })
                .ok();
            })
            .ok();
        })
        .detach();
    }

    fn open_attachment_path_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| {
            InputState::new(window, cx).placeholder(self.i18n.tr("Path to a file").to_owned())
        });
        let sub = cx.subscribe_in(
            &input,
            window,
            |this, input, event: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let raw = input.read(cx).value().trim().to_owned();
                    if !raw.is_empty() {
                        let path = match raw.strip_prefix("~/") {
                            Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
                            None => PathBuf::from(raw),
                        };
                        this.attach_paths(vec![path], cx);
                    }
                    this.attachments.path_input = None;
                    this.focus_composer_input(window, cx);
                }
            },
        );
        input.update(cx, |state, cx| state.focus(window, cx));
        self.attachments.path_input = Some((input, sub));
        cx.notify();
    }

    fn focus_composer_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let handle = gpui_kit::Focusable::focus_handle(self.composer_input(), cx);
        window.focus(&handle, cx);
        cx.notify();
    }

    pub(crate) fn render_attachment_tray(
        &self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        let tray = &self.attachments;
        if tray.items.is_empty() && tray.path_input.is_none() {
            return None;
        }
        let mut row = div().flex().flex_wrap().gap(px(6.0)).pb(px(6.0));
        for item in &tray.items {
            let id = item.id;
            let (status, color) = match &item.upload {
                Upload::Uploading => (
                    Some(self.i18n.tr("Uploading…").to_owned()),
                    palette.muted_foreground,
                ),
                Upload::Ready(_) => (None, palette.foreground),
                Upload::Failed(err) => (Some(err.clone()), palette.error),
            };
            let mut chip = div()
                .id(("attachment", id))
                .flex()
                .items_center()
                .gap(px(6.0))
                .max_w(px(320.0))
                .px(px(6.0))
                .py(px(3.0))
                .rounded(px(6.0))
                .border_1()
                .border_color(if matches!(item.upload, Upload::Failed(_)) {
                    palette.error
                } else {
                    palette.border
                })
                .bg(palette.background)
                .text_xs()
                .text_color(color);
            chip = match &item.preview {
                Some(Preview::Path(path)) => {
                    chip.child(img(path.clone()).size(px(28.0)).rounded(px(4.0)))
                }
                Some(Preview::Image(image)) => {
                    chip.child(img(image.clone()).size(px(28.0)).rounded(px(4.0)))
                }
                None => chip,
            };
            chip = chip.child(div().min_w_0().truncate().child(SharedString::from(
                match &status {
                    Some(s) => format!("{} — {s}", item.name),
                    None => item.name.clone(),
                },
            )));
            row = row.child(
                chip.child(
                    div()
                        .id(("attachment-remove", id))
                        .flex_none()
                        .cursor_pointer()
                        .text_color(palette.muted_foreground)
                        .hover(|s| s.text_color(palette.foreground))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.attachments.items.retain(|p| p.id != id);
                            cx.notify();
                        }))
                        .child("✕"),
                ),
            );
        }
        let mut col = div().flex().flex_col().child(row);
        if let Some((input, _)) = &tray.path_input {
            col = col.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .pb(px(6.0))
                    .child(div().flex_1().child(Input::new(input)))
                    .child(
                        div()
                            .id("attachment-path-cancel")
                            .cursor_pointer()
                            .text_xs()
                            .text_color(palette.muted_foreground)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.attachments.path_input = None;
                                this.focus_composer_input(window, cx);
                            }))
                            .child("✕"),
                    ),
            );
        }
        Some(col)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_read_like_the_web_app() {
        assert_eq!(human_size(12), "12 B");
        assert_eq!(human_size(1500), "2 KB");
        assert_eq!(human_size(3 * 1024 * 1024), "3.0 MB");
    }
}
