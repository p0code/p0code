//! Where the native webview sits in the GPUI layout. The view is an OS child view drawn above
//! GPUI's surface, so it is positioned on every paint and hidden whenever the panel, the tab or
//! an overlay would leave it covering something.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::{App, Bounds, IntoElement, Pixels, Styled as _, Window, canvas};

/// Whether this build embeds a webview (macOS and Windows). Linux has none: wry needs a GTK
/// window there, which a GPUI window is not.
pub const EMBEDDED: bool = cfg!(any(target_os = "macos", target_os = "windows"));

#[derive(Clone, Default)]
pub struct WebSlot(Rc<RefCell<Inner>>);

#[derive(Default)]
struct Inner {
    /// Loaded on the next paint; the view is created on the first one.
    pending: Option<String>,
    error: Option<String>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    view: Option<ViewState>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct ViewState {
    view: super::native::NativeWebView,
    bounds: Option<super::native::LogicalRect>,
    visible: bool,
}

impl WebSlot {
    pub fn navigate(&self, url: &str) {
        let mut inner = self.0.borrow_mut();
        inner.pending = Some(url.to_owned());
        inner.error = None;
    }

    pub fn error(&self) -> Option<String> {
        self.0.borrow().error.clone()
    }

    /// The page's current address, once a view exists.
    pub fn current_url(&self) -> Option<String> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            self.0.borrow().view.as_ref().and_then(|v| v.view.url())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            None
        }
    }

    pub fn reload(&self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(v) = &self.0.borrow().view {
            v.view.reload();
        }
    }

    pub fn back(&self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(v) = &self.0.borrow().view {
            v.view.back();
        }
    }

    pub fn forward(&self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(v) = &self.0.borrow().view {
            v.view.forward();
        }
    }

    /// Called from render whenever the slot will not be painted this frame.
    pub fn hide(&self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(v) = self.0.borrow_mut().view.as_mut()
            && v.visible
        {
            v.visible = false;
            v.view.set_visible(false);
        }
    }

    /// Fills its parent; the webview follows these bounds.
    pub fn element(&self) -> impl IntoElement {
        let slot = self.clone();
        canvas(
            |_, _, _| (),
            move |bounds, (), window, cx| slot.paint(bounds, window, cx),
        )
        .size_full()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn paint(&self, _bounds: Bounds<Pixels>, _window: &mut Window, _cx: &mut App) {}

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn paint(&self, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
        use super::native::{LogicalRect, NativeWebView};

        let rect = LogicalRect {
            x: f64::from(bounds.origin.x),
            y: f64::from(bounds.origin.y),
            width: f64::from(bounds.size.width),
            height: f64::from(bounds.size.height),
        };
        let mut inner = self.0.borrow_mut();
        if inner.view.is_none() {
            let Some(url) = inner.pending.take() else {
                return;
            };
            // Native callbacks may fire while the app is borrowed; queue onto its executor.
            let app = cx.to_async();
            let open_external = move |url: String| {
                app.spawn(async move |cx| cx.update(|cx| cx.open_url(&url)))
                    .detach();
            };
            match NativeWebView::new(
                &*window,
                &url,
                rect,
                super::policy::page_may_navigate,
                open_external,
            ) {
                Ok(view) => {
                    inner.view = Some(ViewState {
                        view,
                        bounds: Some(rect),
                        visible: true,
                    });
                }
                Err(err) => {
                    tracing::warn!(error = %err, "preview webview could not be created");
                    inner.error = Some(err);
                }
            }
            return;
        }
        let pending = inner.pending.take();
        let mut failed = None;
        if let Some(v) = inner.view.as_mut() {
            if let Some(url) = pending
                && let Err(err) = v.view.load(&url)
            {
                failed = Some(err);
            }
            if v.bounds != Some(rect) {
                v.bounds = Some(rect);
                v.view.set_bounds(rect);
            }
            if !v.visible {
                v.visible = true;
                v.view.set_visible(true);
            }
        }
        if failed.is_some() {
            inner.error = failed;
        }
    }
}
