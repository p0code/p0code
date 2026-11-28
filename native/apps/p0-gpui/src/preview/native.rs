//! The OS webview (WKWebView on macOS, WebView2 on Windows) through `wry`, as a child of the
//! GPUI window. Free of GPUI types so it can be type-checked for those targets from any host.
//!
//! No IPC handler, custom protocol, initialization script or devtools: the page gets nothing
//! from the app, and no credential is ever passed to it.

use wry::dpi::{LogicalPosition, LogicalSize};
use wry::raw_window_handle::HasWindowHandle;
use wry::{NewWindowResponse, Rect, WebView, WebViewBuilder};

/// Logical pixels from the top-left of the window's content area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<LogicalRect> for Rect {
    fn from(r: LogicalRect) -> Self {
        Rect {
            position: LogicalPosition::new(r.x, r.y).into(),
            size: LogicalSize::new(r.width, r.height).into(),
        }
    }
}

pub struct NativeWebView(WebView);

impl NativeWebView {
    /// `may_navigate` guards every navigation; pages asking for a new window get
    /// `open_external` instead (when allowed), since the panel has one view.
    pub fn new(
        parent: &impl HasWindowHandle,
        url: &str,
        bounds: LogicalRect,
        may_navigate: fn(&str) -> bool,
        open_external: impl Fn(String) + 'static,
    ) -> Result<Self, String> {
        WebViewBuilder::new()
            .with_url(url)
            .with_bounds(bounds.into())
            .with_navigation_handler(move |url| may_navigate(&url))
            .with_new_window_req_handler(move |url, _features| {
                if may_navigate(&url) {
                    open_external(url);
                }
                NewWindowResponse::Deny
            })
            .with_download_started_handler(|_url, _path| false)
            .with_clipboard(true)
            .with_accept_first_mouse(true)
            .build_as_child(parent)
            .map(Self)
            .map_err(|err| err.to_string())
    }

    pub fn load(&self, url: &str) -> Result<(), String> {
        self.0.load_url(url).map_err(|err| err.to_string())
    }

    pub fn reload(&self) {
        let _ = self.0.reload();
    }

    /// History is the page's; these run the page's own `history` calls, not an app bridge.
    pub fn back(&self) {
        let _ = self.0.evaluate_script("history.back()");
    }

    pub fn forward(&self) {
        let _ = self.0.evaluate_script("history.forward()");
    }

    pub fn url(&self) -> Option<String> {
        self.0.url().ok()
    }

    pub fn set_bounds(&self, bounds: LogicalRect) {
        let _ = self.0.set_bounds(bounds.into());
    }

    pub fn set_visible(&self, visible: bool) {
        let _ = self.0.set_visible(visible);
        if !visible {
            let _ = self.0.focus_parent();
        }
    }
}
