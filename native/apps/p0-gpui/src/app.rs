//! Root window: sidebar, thread feed, composer, command palette and settings.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui_kit::component::command::{Command, CommandItem, CommandState};
use gpui_kit::component::input::{InputEvent, TextareaState};
use gpui_kit::component::message_scroller::MessageScroller;
use gpui_kit::component::{Root, Theme, ThemeMode};
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable as _, FontWeight,
    InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, actions, div, px,
};
use p0_client::{ConnectionState, ShellState, ThreadState};
use p0_i18n::{Catalog, Key};
use p0_protocol::{ModelSelection, RuntimeMode, ThreadShell, ThreadStatus};

use crate::attachments::AttachmentTray;
use crate::bridge::AppBridge;
use crate::cards::CardForms;
use crate::completions::Completion;
use crate::composer::{available_models, render_composer};
use crate::feed::FeedState;
use crate::markdown::MarkdownCache;
use crate::palette::{PaletteAction, PaletteItem, rank};
use crate::right_panel::{PanelTab, RightPanel};
use crate::settings::{LocalPrefs, SECTIONS};
use p0_terminal::TerminalEngine as _;

use crate::terminal::{CELL_WIDTH, DRAWER_ROWS, SharedTerminal, key_bytes};
use crate::theme::AppPalette;

actions!(
    p0,
    [
        ToggleCommandPalette,
        FocusComposer,
        NextThread,
        PreviousThread,
        ToggleSidebar,
        OpenSettings,
        NewThread,
        ToggleTerminal,
        ToggleDiff,
    ]
);

/// `mod` in the web app's bindings: Cmd on macOS, Ctrl elsewhere. (This gpui cannot parse
/// `secondary-` without an OS argument, so it is resolved at compile time.)
macro_rules! mod_key {
    ($key:literal) => {
        if cfg!(target_os = "macos") {
            concat!("cmd-", $key)
        } else {
            concat!("ctrl-", $key)
        }
    };
}

/// The web app's default bindings for the same commands (`packages/shared/src/keybindings.ts`).
fn keybindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new(mod_key!("k"), ToggleCommandPalette, None),
        KeyBinding::new(mod_key!("b"), ToggleSidebar, None),
        KeyBinding::new(mod_key!("shift-]"), NextThread, None),
        KeyBinding::new(mod_key!("shift-["), PreviousThread, None),
        KeyBinding::new(mod_key!("n"), NewThread, None),
        KeyBinding::new(mod_key!("shift-o"), NewThread, None),
        KeyBinding::new(mod_key!(","), OpenSettings, None),
        KeyBinding::new(mod_key!("l"), FocusComposer, None),
        KeyBinding::new(mod_key!("j"), ToggleTerminal, None),
        KeyBinding::new(mod_key!("d"), ToggleDiff, None),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Chat,
    Settings(&'static str),
}

pub struct Palette {
    pub state: Entity<CommandState>,
    pub items: Vec<PaletteItem>,
    pub ranked: Vec<usize>,
}

pub struct P0App {
    pub(crate) bridge: Arc<AppBridge>,
    pub(crate) i18n: Catalog,
    pub(crate) prefs: LocalPrefs,
    pub(crate) view: View,
    pub(crate) shell: ShellState,
    pub(crate) thread: ThreadState,
    focus: FocusHandle,
    selected_thread_id: Option<String>,
    /// Project a new thread starts in when nothing is selected (New thread).
    draft_project_id: Option<String>,
    launched: Arc<Mutex<Option<String>>>,
    collapsed_projects: HashSet<String>,
    pub(crate) feed: FeedState,
    pub(crate) md_cache: MarkdownCache,
    pub(crate) expanded_items: HashSet<String>,
    pub(crate) cards: CardForms,
    selected_model: Option<ModelSelection>,
    selected_runtime_mode: Option<RuntimeMode>,
    model_picker_open: bool,
    composer_input: Entity<TextareaState>,
    pub(crate) palette: Option<Palette>,
    terminal: Option<TerminalPane>,
    pub(crate) right_panel: RightPanel,
    pub(crate) attachments: AttachmentTray,
    pub(crate) completion: Completion,
    _subs: Vec<Subscription>,
}

struct TerminalPane {
    thread_id: String,
    shared: SharedTerminal,
    focus: FocusHandle,
    size: (u16, u16),
}

impl P0App {
    pub fn new(bridge: Arc<AppBridge>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let prefs = LocalPrefs::load();
        let i18n = catalog_for(&prefs);
        let composer_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(i18n.get(Key::AskAnything).to_owned())
                .auto_grow(2, 8)
        });
        let composer_sub = cx.subscribe_in(
            &composer_input,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { shift: false, .. } => this.submit_composer(window, cx),
                InputEvent::Change => this.update_completion(cx),
                _ => {}
            },
        );
        let appearance_sub = cx.observe_window_appearance(window, |this, window, cx| {
            this.apply_theme(window, cx);
        });

        // One repaint per frame at most, and none while nothing changes.
        let waiter = bridge.clone();
        cx.spawn(async move |this, cx| {
            loop {
                waiter.changed().await;
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                if this.update(cx, |app, cx| app.on_bridge_change(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        let mut app = Self {
            shell: bridge.shell_state(),
            thread: bridge.thread_state(),
            bridge,
            i18n,
            prefs,
            view: View::Chat,
            focus: cx.focus_handle(),
            selected_thread_id: None,
            draft_project_id: None,
            launched: Arc::new(Mutex::new(None)),
            collapsed_projects: HashSet::new(),
            feed: FeedState::new(cx),
            md_cache: MarkdownCache::new(),
            expanded_items: HashSet::new(),
            cards: CardForms::default(),
            selected_model: None,
            selected_runtime_mode: None,
            model_picker_open: false,
            composer_input,
            palette: None,
            terminal: None,
            right_panel: RightPanel::new(cx),
            attachments: AttachmentTray::default(),
            completion: Completion::default(),
            _subs: vec![composer_sub, appearance_sub],
        };
        app.apply_theme(window, cx);
        app
    }

    fn on_bridge_change(&mut self, cx: &mut Context<Self>) {
        self.shell = self.bridge.shell_state();
        self.thread = self.bridge.thread_state();
        let launched = self.launched.lock().unwrap().take();
        if let Some(id) = launched {
            self.open_thread(id, cx);
        }
        self.auto_select_first_thread();
        self.sync_feed(cx);
        self.cards.retain_pending(&self.thread);
        self.sync_right_panel();
        cx.notify();
    }

    pub fn bridge(&self) -> &Arc<AppBridge> {
        &self.bridge
    }

    pub fn i18n(&self) -> &Catalog {
        &self.i18n
    }

    pub fn selected_thread_id(&self) -> Option<&str> {
        self.selected_thread_id.as_deref()
    }

    pub fn selected_model(&self) -> Option<&ModelSelection> {
        self.selected_model.as_ref()
    }

    pub fn selected_runtime_mode(&self) -> Option<RuntimeMode> {
        self.selected_runtime_mode
    }

    pub fn model_picker_open(&self) -> bool {
        self.model_picker_open
    }

    pub fn composer_input(&self) -> &Entity<TextareaState> {
        &self.composer_input
    }

    pub(crate) fn palette_colors(&self, window: &Window) -> AppPalette {
        AppPalette::for_preference(self.prefs.theme, window.appearance())
    }

    pub(crate) fn apply_theme(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mode = if self.prefs.theme.is_dark(window.appearance()) {
            ThemeMode::Dark
        } else {
            ThemeMode::Light
        };
        Theme::change(mode, Some(window), cx);
        cx.notify();
    }

    pub(crate) fn set_prefs(
        &mut self,
        prefs: LocalPrefs,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let language_changed = prefs.language != self.prefs.language;
        self.prefs = prefs;
        self.prefs.save();
        if language_changed {
            self.i18n = catalog_for(&self.prefs);
        }
        self.apply_theme(window, cx);
    }

    pub fn toggle_model_picker(&mut self, cx: &mut Context<Self>) {
        self.model_picker_open = !self.model_picker_open;
        cx.notify();
    }

    pub fn pick_model(&mut self, selection: ModelSelection, cx: &mut Context<Self>) {
        self.selected_model = Some(selection.clone());
        self.model_picker_open = false;
        if let Some(tid) = &self.selected_thread_id {
            self.bridge.set_model_selection(tid.clone(), selection);
        }
        cx.notify();
    }

    pub fn cycle_runtime_mode(&mut self, current: RuntimeMode, cx: &mut Context<Self>) {
        let next = current.next_cycle();
        self.selected_runtime_mode = Some(next);
        if let Some(tid) = &self.selected_thread_id {
            self.bridge.set_runtime_mode(tid.clone(), next);
        }
        cx.notify();
    }

    pub fn stop_active_thread(&mut self, cx: &mut Context<Self>) {
        if let Some(tid) = self.selected_thread_id.clone() {
            let active_run = self.thread.active_run_id().map(ToOwned::to_owned);
            self.bridge.stop_thread(tid, active_run);
            cx.notify();
        }
    }

    pub fn submit_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer_input.read(cx).value().trim().to_owned();
        let attachments = self.attachments.ready();
        if (text.is_empty() && attachments.is_empty()) || self.attachments.is_uploading() {
            return;
        }
        if let Some(tid) = self.selected_thread_id.clone() {
            let active_run = self.thread.active_run_id().map(ToOwned::to_owned);
            self.bridge.send_message(
                tid,
                text,
                attachments,
                self.selected_model.clone(),
                active_run,
            );
        } else if let Some(project_id) = self.draft_project_id.clone() {
            let config = self.bridge.server_config();
            let Some(model) = self.selected_model.clone().or_else(|| {
                available_models(config.as_ref())
                    .first()
                    .map(|c| c.to_selection())
            }) else {
                return;
            };
            let runtime_mode = self.selected_runtime_mode.unwrap_or_else(|| {
                self.bridge
                    .server_settings()
                    .map(|s| {
                        crate::settings::GeneralServerSettings::from_json(&s).default_runtime_mode
                    })
                    .unwrap_or(RuntimeMode::FullAccess)
            });
            let launched = self.launched.clone();
            self.bridge.launch_thread(
                project_id,
                model,
                runtime_mode,
                Some(text),
                attachments,
                move |id| {
                    *launched.lock().unwrap() = Some(id);
                },
            );
        } else {
            return;
        }
        self.composer_input
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.attachments.clear();
        self.feed.follow_tail(cx);
        cx.notify();
    }

    fn auto_select_first_thread(&mut self) {
        if self.selected_thread_id.is_some() || self.draft_project_id.is_some() {
            return;
        }
        if let Some(first) = self.sidebar_threads().first().map(|t| t.id.clone()) {
            self.selected_thread_id = Some(first.clone());
            self.bridge.select_thread(first);
        }
    }

    /// Threads in sidebar order, skipping collapsed projects.
    fn sidebar_threads(&self) -> Vec<&ThreadShell> {
        self.shell
            .projects
            .iter()
            .filter(|p| !self.collapsed_projects.contains(&p.id))
            .flat_map(|p| self.shell.threads_for_project(&p.id))
            .collect()
    }

    pub(crate) fn open_thread(&mut self, thread_id: String, cx: &mut Context<Self>) {
        self.view = View::Chat;
        self.draft_project_id = None;
        if self.selected_thread_id.as_deref() == Some(thread_id.as_str()) {
            cx.notify();
            return;
        }
        self.selected_thread_id = Some(thread_id.clone());
        self.selected_model = None;
        self.selected_runtime_mode = None;
        self.model_picker_open = false;
        self.expanded_items.clear();
        self.bridge.select_thread(thread_id);
        self.thread = self.bridge.thread_state();
        self.sync_feed(cx);
        self.sync_right_panel();
        cx.notify();
    }

    pub(crate) fn start_new_thread(
        &mut self,
        project_id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let project_id = project_id
            .or_else(|| {
                self.selected_thread_id
                    .as_deref()
                    .and_then(|id| self.shell.thread_by_id(id))
                    .map(|t| t.project_id.clone())
            })
            .or_else(|| self.shell.projects.first().map(|p| p.id.clone()));
        let Some(project_id) = project_id else {
            return;
        };
        self.view = View::Chat;
        self.draft_project_id = Some(project_id);
        self.selected_thread_id = None;
        self.selected_runtime_mode = None;
        self.bridge.clear_thread();
        self.thread = self.bridge.thread_state();
        self.sync_feed(cx);
        self.focus_composer(window, cx);
    }

    fn step_thread(&mut self, forward: bool, cx: &mut Context<Self>) {
        let ids: Vec<String> = self
            .sidebar_threads()
            .iter()
            .map(|t| t.id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        let current = self
            .selected_thread_id
            .as_ref()
            .and_then(|id| ids.iter().position(|t| t == id));
        let next = match (current, forward) {
            (Some(i), true) => (i + 1) % ids.len(),
            (Some(i), false) => (i + ids.len() - 1) % ids.len(),
            (None, _) => 0,
        };
        self.open_thread(ids[next].clone(), cx);
    }

    fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.view = View::Chat;
        let handle = self.composer_input.focus_handle(cx);
        window.focus(&handle, cx);
        cx.notify();
    }

    fn toggle_sidebar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut prefs = self.prefs.clone();
        prefs.sidebar_hidden = !prefs.sidebar_hidden;
        self.set_prefs(prefs, window, cx);
    }

    /// The folder a new thread will start in, while one is being drafted.
    pub(crate) fn draft_project_root(&self) -> Option<String> {
        let id = self.draft_project_id.as_deref()?;
        let project = self.shell.projects.iter().find(|p| p.id == id)?;
        Some(project.workspace_root.clone())
    }

    /// A thread's folder: its worktree, else its project's root.
    pub(crate) fn thread_cwd(&self, thread_id: &str) -> Option<String> {
        let thread = self.shell.thread_by_id(thread_id)?;
        thread.worktree_path.clone().or_else(|| {
            self.shell
                .projects
                .iter()
                .find(|p| p.id == thread.project_id)
                .map(|p| p.workspace_root.clone())
        })
    }

    fn terminal_cols(&self, window: &Window) -> u16 {
        let sidebar = if self.prefs.sidebar_hidden {
            0.0
        } else {
            272.0
        };
        let width =
            f32::from(window.viewport_size().width) - sidebar - self.right_panel.width() - 24.0;
        (width / CELL_WIDTH).clamp(20.0, 400.0) as u16
    }

    fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.terminal.take().is_some() {
            self.bridge.detach_terminal();
            window.focus(&self.focus, cx);
            cx.notify();
            return;
        }
        let Some(thread_id) = self.selected_thread_id.clone() else {
            return;
        };
        let Some(cwd) = self.thread_cwd(&thread_id) else {
            return;
        };
        let size = (self.terminal_cols(window), DRAWER_ROWS);
        let shared = self
            .bridge
            .attach_terminal(thread_id.clone(), cwd, size.0, size.1);
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        self.terminal = Some(TerminalPane {
            thread_id,
            shared,
            focus,
            size,
        });
        self.view = View::Chat;
        cx.notify();
    }

    pub(crate) fn focus_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(t) = &self.terminal {
            window.focus(&t.focus, cx);
            cx.notify();
        }
    }

    /// Sends a key press to the terminal; `false` when it was not the terminal's.
    pub(crate) fn terminal_key(&mut self, event: &gpui_kit::KeyDownEvent) -> bool {
        let Some(t) = &self.terminal else {
            return false;
        };
        let app_cursor = t.shared.lock().unwrap().engine.app_cursor_mode();
        let Some(bytes) = key_bytes(event, app_cursor) else {
            return false;
        };
        self.bridge.terminal_write(
            t.thread_id.clone(),
            String::from_utf8_lossy(&bytes).into_owned(),
        );
        true
    }

    /// Keeps the session's size in step with the window.
    fn sync_terminal_size(&mut self, window: &Window) {
        let size = (self.terminal_cols(window), DRAWER_ROWS);
        let Some(t) = self.terminal.as_mut() else {
            return;
        };
        if size != t.size {
            t.size = size;
            t.shared.lock().unwrap().engine.resize(size.0, size.1);
            self.bridge
                .terminal_resize(t.thread_id.clone(), size.0, size.1);
        }
    }

    pub(crate) fn open_settings(&mut self, path: &'static str, cx: &mut Context<Self>) {
        self.view = View::Settings(path);
        self.palette = None;
        cx.notify();
    }

    fn toggle_project(&mut self, project_id: String, cx: &mut Context<Self>) {
        if !self.collapsed_projects.remove(&project_id) {
            self.collapsed_projects.insert(project_id);
        }
        cx.notify();
    }

    fn palette_items(&self) -> Vec<PaletteItem> {
        let t = |s: &str| self.i18n.tr(s).to_owned();
        let project_title = |id: &str| {
            self.shell
                .projects
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.title.clone())
                .unwrap_or_default()
        };
        let mut threads: Vec<&ThreadShell> = self
            .shell
            .threads
            .iter()
            .filter(|t| t.deleted_at.is_none() && t.archived_at.is_none())
            .collect();
        threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let mut items: Vec<PaletteItem> = threads
            .into_iter()
            .map(|thread| PaletteItem {
                label: if thread.title.trim().is_empty() {
                    self.i18n.get(Key::UntitledThread).to_owned()
                } else {
                    thread.title.clone()
                },
                detail: project_title(&thread.project_id),
                action: PaletteAction::OpenThread(thread.id.clone()),
            })
            .collect();
        items.push(PaletteItem {
            label: t("New thread"),
            detail: String::new(),
            action: PaletteAction::NewThread,
        });
        items.extend(self.shell.projects.iter().map(|p| PaletteItem {
            label: format!("{} · {}", t("New thread"), p.title),
            detail: t("Projects"),
            action: PaletteAction::NewThreadIn(p.id.clone()),
        }));
        let config = self.bridge.server_config();
        items.extend(
            available_models(config.as_ref())
                .into_iter()
                .map(|c| PaletteItem {
                    label: format!("{}: {} · {}", t("Model"), c.provider_label, c.model_label),
                    detail: c.model_slug.clone(),
                    action: PaletteAction::SwitchModel(c.to_selection()),
                }),
        );
        items.extend(SECTIONS.iter().map(|s| PaletteItem {
            label: format!("{}: {}", t("Settings"), t(s.label)),
            detail: s.path.to_owned(),
            action: PaletteAction::OpenSettings(s.path),
        }));
        items.push(PaletteItem {
            label: "Toggle sidebar".to_owned(),
            detail: String::new(),
            action: PaletteAction::ToggleSidebar,
        });
        items.push(PaletteItem {
            label: "Focus composer".to_owned(),
            detail: String::new(),
            action: PaletteAction::FocusComposer,
        });
        items.push(PaletteItem {
            label: t("Terminal"),
            detail: String::new(),
            action: PaletteAction::ToggleTerminal,
        });
        items.push(PaletteItem {
            label: t("Changes"),
            detail: String::new(),
            action: PaletteAction::TogglePanel(PanelTab::Diff),
        });
        items.push(PaletteItem {
            label: t("Files"),
            detail: String::new(),
            action: PaletteAction::TogglePanel(PanelTab::Files),
        });
        items.push(PaletteItem {
            label: t("Reconnect"),
            detail: String::new(),
            action: PaletteAction::Reconnect,
        });
        items
    }

    fn toggle_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
            return;
        }
        let state = cx.new(|cx| CommandState::new(window, cx));
        state.update(cx, |s, cx| s.focus(window, cx));
        let items = self.palette_items();
        let ranked = rank("", &items);
        self.palette = Some(Palette {
            state,
            items,
            ranked,
        });
        cx.notify();
    }

    pub(crate) fn palette_query(&mut self, query: &str, cx: &mut Context<Self>) {
        if let Some(p) = self.palette.as_mut() {
            p.ranked = rank(query, &p.items);
            cx.notify();
        }
    }

    pub(crate) fn palette_confirm(
        &mut self,
        row: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(palette) = self.palette.take() else {
            return;
        };
        window.focus(&self.focus, cx);
        let Some(item) = palette
            .ranked
            .get(row)
            .and_then(|ix| palette.items.get(*ix))
        else {
            return;
        };
        match item.action.clone() {
            PaletteAction::OpenThread(id) => self.open_thread(id, cx),
            PaletteAction::NewThread => self.start_new_thread(None, window, cx),
            PaletteAction::NewThreadIn(project) => self.start_new_thread(Some(project), window, cx),
            PaletteAction::SwitchModel(selection) => self.pick_model(selection, cx),
            PaletteAction::OpenSettings(path) => self.open_settings(path, cx),
            PaletteAction::ToggleSidebar => self.toggle_sidebar(window, cx),
            PaletteAction::FocusComposer => self.focus_composer(window, cx),
            PaletteAction::ToggleTerminal => self.toggle_terminal(window, cx),
            PaletteAction::TogglePanel(tab) => self.toggle_right_panel(tab, cx),
            PaletteAction::Reconnect => self.bridge.reconnect_now(),
        }
        cx.notify();
    }

    fn render_palette(
        &self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        let p = self.palette.as_ref()?;
        let items = p
            .ranked
            .iter()
            .filter_map(|ix| p.items.get(*ix))
            .map(|item| {
                CommandItem::new().label(
                    if item.detail.is_empty() || item.detail.starts_with('/') {
                        item.label.clone()
                    } else {
                        format!("{}  —  {}", item.label, item.detail)
                    },
                )
            });
        let view = cx.entity();
        let on_query = view.clone();
        let on_confirm = view.clone();
        let on_cancel = view;
        let command = Command::new(&p.state)
            .filterable(false)
            .placeholder(self.i18n.tr("Search").to_owned())
            .items(items.collect::<Vec<_>>())
            .on_query(move |query, _, cx| {
                on_query.update(cx, |this, cx| this.palette_query(query, cx));
            })
            .on_confirm(move |ix, window, cx| {
                on_confirm.update(cx, |this, cx| this.palette_confirm(ix.row, window, cx));
            })
            .on_cancel(move |window, cx| {
                on_cancel.update(cx, |this, cx| {
                    this.palette = None;
                    window.focus(&this.focus, cx);
                    cx.notify();
                });
            });
        Some(
            div()
                .id("palette-backdrop")
                .absolute()
                .inset_0()
                .flex()
                .justify_center()
                .items_start()
                .pt(px(96.0))
                .bg(palette.backdrop)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.palette = None;
                    window.focus(&this.focus, cx);
                    cx.notify();
                }))
                .child(
                    div()
                        .id("palette")
                        .w(px(560.0))
                        .max_w_full()
                        .rounded(px(10.0))
                        .bg(palette.card)
                        .border_1()
                        .border_color(palette.border)
                        .shadow_lg()
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(command),
                ),
        )
    }

    fn render_connection_chip(
        &self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let state = self.bridge.connection_state();
        let (dot_color, label, action) = match &state {
            ConnectionState::Connected => (
                palette.success,
                self.i18n.get(Key::Connected).to_owned(),
                None,
            ),
            ConnectionState::Connecting => (
                palette.warning,
                self.i18n.get(Key::Connecting).to_owned(),
                None,
            ),
            ConnectionState::Reconnecting { attempt, .. } => (
                palette.warning,
                format!("{} (#{attempt})", self.i18n.get(Key::Reconnecting)),
                Some(self.i18n.get(Key::Reconnect).to_owned()),
            ),
            ConnectionState::SignedOutElsewhere { retry_in_ms } => (
                palette.warning,
                match retry_in_ms {
                    Some(ms) => format!(
                        "Signed in from another desktop app · {}s",
                        ms.div_ceil(1000)
                    ),
                    None => "Signed in from another desktop app".to_owned(),
                },
                Some("Sign in here".to_owned()),
            ),
            ConnectionState::Disconnected => (
                palette.muted_foreground,
                self.i18n.get(Key::NotConnected).to_owned(),
                Some(self.i18n.get(Key::Reconnect).to_owned()),
            ),
            ConnectionState::AuthFailed(msg) => (
                palette.error,
                format!("{}: {msg}", self.i18n.get(Key::Error)),
                Some(self.i18n.get(Key::Retry).to_owned()),
            ),
        };

        let mut chip = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .text_xs()
            .text_color(palette.muted_foreground)
            .child(
                div()
                    .flex_none()
                    .w(px(7.0))
                    .h(px(7.0))
                    .rounded_full()
                    .bg(dot_color),
            )
            .child(div().truncate().child(SharedString::from(label)));
        if let Some(action) = action {
            let bridge = self.bridge.clone();
            chip = chip.child(
                div()
                    .id("conn-reconnect-btn")
                    .flex_none()
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded(px(4.0))
                    .bg(palette.primary)
                    .text_color(palette.primary_foreground)
                    .cursor_pointer()
                    .on_click(cx.listener(move |_, _, _, _| bridge.reconnect_now()))
                    .child(SharedString::from(action)),
            );
        }
        chip
    }

    fn render_sidebar(&self, palette: &AppPalette, cx: &mut Context<Self>) -> impl IntoElement {
        let mut projects_col = div().flex().flex_col().gap(px(6.0)).p(px(8.0));

        if self.shell.projects.is_empty() {
            projects_col = projects_col.child(
                div()
                    .px(px(8.0))
                    .py(px(12.0))
                    .text_sm()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(
                        self.i18n.get(Key::NoProjectsYet).to_owned(),
                    )),
            );
        }
        for project in &self.shell.projects {
            let project_id = project.id.clone();
            let collapsed = self.collapsed_projects.contains(&project_id);
            let threads = self.shell.threads_for_project(&project.id);
            let toggle_pid = project_id.clone();
            let new_pid = project_id.clone();

            let header = div()
                .id(SharedString::from(format!("proj-{}", project.id)))
                .group("project-header")
                .flex()
                .items_center()
                .justify_between()
                .px(px(8.0))
                .py(px(5.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .hover(|s| s.bg(palette.row_hover))
                .on_click(
                    cx.listener(move |this, _, _, cx| this.toggle_project(toggle_pid.clone(), cx)),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .min_w_0()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(palette.muted_foreground)
                        .child(if collapsed { "▸" } else { "▾" })
                        .child(
                            div()
                                .truncate()
                                .child(SharedString::from(project.title.clone())),
                        ),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("proj-new-{}", project.id)))
                        .px(px(5.0))
                        .rounded(px(4.0))
                        .text_sm()
                        .text_color(palette.muted_foreground)
                        .hover(|s| s.bg(palette.row_selected).text_color(palette.foreground))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.start_new_thread(Some(new_pid.clone()), window, cx);
                        }))
                        .child("+"),
                );

            let mut group = div().flex().flex_col().gap(px(2.0)).child(header);
            if !collapsed {
                for thread in threads {
                    group = group.child(self.render_thread_row(thread, palette, cx));
                }
            }
            projects_col = projects_col.child(group);
        }

        div()
            .w(px(272.0))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(palette.sidebar)
            .border_r_1()
            .border_color(palette.border)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .px(px(12.0))
                    .py(px(10.0))
                    .border_b_1()
                    .border_color(palette.border)
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(palette.foreground)
                            .child("p0code"),
                    )
                    .child(self.render_connection_chip(palette, cx)),
            )
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex_1()
                    .overflow_y_scroll()
                    .child(projects_col),
            )
            .child(
                div()
                    .id("sidebar-settings")
                    .m(px(8.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_sm()
                    .text_color(palette.muted_foreground)
                    .hover(|s| s.bg(palette.row_hover).text_color(palette.foreground))
                    .on_click(
                        cx.listener(|this, _, _, cx| this.open_settings(SECTIONS[0].path, cx)),
                    )
                    .child(SharedString::from(self.i18n.get(Key::Settings).to_owned())),
            )
    }

    fn render_thread_row(
        &self,
        thread: &ThreadShell,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let tid = thread.id.clone();
        let selected =
            self.view == View::Chat && self.selected_thread_id.as_deref() == Some(tid.as_str());
        let title = if thread.title.trim().is_empty() {
            self.i18n.get(Key::UntitledThread).to_owned()
        } else {
            thread.title.clone()
        };
        let mut row = div()
            .id(SharedString::from(format!("thread-row-{}", thread.id)))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(6.0))
            .px(px(10.0))
            .py(px(6.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .when_selected(selected, palette)
            .hover(|s| s.bg(palette.row_hover))
            .on_click(cx.listener(move |this, _, _, cx| this.open_thread(tid.clone(), cx)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.0))
                    .min_w_0()
                    .child(
                        div()
                            .flex_none()
                            .w(px(7.0))
                            .h(px(7.0))
                            .rounded_full()
                            .bg(status_dot_color(thread.status, palette)),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(palette.foreground)
                            .truncate()
                            .child(SharedString::from(title)),
                    ),
            );
        if thread.pending_runtime_request.is_some() {
            row = row.child(
                div()
                    .flex_none()
                    .px(px(5.0))
                    .py(px(1.0))
                    .rounded(px(4.0))
                    .bg(palette.warning_surface)
                    .text_xs()
                    .text_color(palette.badge_approval)
                    .child(SharedString::from(
                        self.i18n.get(Key::ApprovalNeeded).to_owned(),
                    )),
            );
        } else if thread.is_unread() {
            row = row.child(
                div()
                    .flex_none()
                    .w(px(6.0))
                    .h(px(6.0))
                    .rounded_full()
                    .bg(palette.primary),
            );
        }
        row
    }

    fn render_chat(
        &mut self,
        palette: AppPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = self
            .selected_thread_id
            .as_deref()
            .and_then(|id| self.shell.thread_by_id(id));
        let title = match (&self.thread.projection, selected, &self.draft_project_id) {
            (Some(p), _, _) => p.thread.title.clone(),
            (None, Some(t), _) => t.title.clone(),
            (None, None, Some(project)) => format!(
                "{} · {}",
                self.i18n.tr("New thread"),
                self.shell
                    .projects
                    .iter()
                    .find(|p| &p.id == project)
                    .map(|p| p.title.as_str())
                    .unwrap_or_default()
            ),
            _ => self.i18n.get(Key::Thread).to_owned(),
        };
        let branch = self
            .thread
            .projection
            .as_ref()
            .and_then(|p| p.thread.branch.clone())
            .or_else(|| selected.and_then(|t| t.branch.clone()));

        let mut header = div()
            .w_full()
            .flex_none()
            .px(px(16.0))
            .py(px(10.0))
            .border_b_1()
            .border_color(palette.border)
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(palette.foreground)
                    .child(SharedString::from(title)),
            );
        if let Some(branch) = branch {
            header = header.child(
                div()
                    .flex_none()
                    .px(px(8.0))
                    .py(px(2.0))
                    .rounded(px(4.0))
                    .bg(palette.card)
                    .border_1()
                    .border_color(palette.border)
                    .font_family("monospace")
                    .text_xs()
                    .text_color(palette.muted_foreground)
                    .child(SharedString::from(branch)),
            );
        }

        let body = if self.thread.projection.is_some() {
            let view = cx.entity();
            MessageScroller::new(
                "thread-feed",
                self.feed.state.clone(),
                move |ix, window, cx| {
                    view.update(cx, |this, cx| this.render_feed_row(ix, palette, window, cx))
                },
            )
            .with_jump_button_label(self.i18n.tr("Jump to latest").to_owned())
            .size_full()
            .into_any_element()
        } else {
            let text = if self.selected_thread_id.is_some() {
                self.i18n.get(Key::LoadingMessages).to_owned()
            } else if self.draft_project_id.is_some() {
                String::new()
            } else {
                self.i18n.get(Key::NoThreadsFound).to_owned()
            };
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_sm()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(text))
                .into_any_element()
        };

        let mut pane = div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .bg(palette.background)
            .child(header);
        if let Some(notice) = self.bridge.notice() {
            let bridge = self.bridge.clone();
            pane = pane.child(
                div()
                    .flex_none()
                    .px(px(16.0))
                    .py(px(6.0))
                    .bg(palette.error_surface)
                    .border_b_1()
                    .border_color(palette.error)
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .text_xs()
                    .text_color(palette.error)
                    .child(div().min_w_0().child(SharedString::from(notice)))
                    .child(
                        div()
                            .id("dismiss-notice")
                            .flex_none()
                            .cursor_pointer()
                            .on_click(cx.listener(move |_, _, _, _| bridge.clear_notice()))
                            .child("✕"),
                    ),
            );
        }
        self.sync_terminal_size(window);
        let pane = pane
            .child(div().flex_1().min_h_0().w_full().child(body))
            .child(render_composer(self, &palette, cx));
        match &self.terminal {
            Some(t) => pane
                .child(self.render_terminal(&t.focus, &t.shared, &palette, window, cx))
                .into_any_element(),
            None => pane.into_any_element(),
        }
    }
}

trait SelectedRow {
    fn when_selected(self, selected: bool, palette: &AppPalette) -> Self;
}

impl SelectedRow for gpui_kit::Stateful<gpui_kit::Div> {
    fn when_selected(self, selected: bool, palette: &AppPalette) -> Self {
        if selected {
            self.bg(palette.row_selected)
        } else {
            self
        }
    }
}

impl Render for P0App {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = self.palette_colors(window);
        let mut root =
            div()
                .id("p0-root")
                .key_context("P0App")
                .track_focus(&self.focus)
                .on_action(cx.listener(|this, _: &ToggleCommandPalette, window, cx| {
                    this.toggle_palette(window, cx)
                }))
                .on_action(cx.listener(|this, _: &FocusComposer, window, cx| {
                    this.focus_composer(window, cx)
                }))
                .on_action(cx.listener(|this, _: &NextThread, _, cx| this.step_thread(true, cx)))
                .on_action(
                    cx.listener(|this, _: &PreviousThread, _, cx| this.step_thread(false, cx)),
                )
                .on_action(cx.listener(|this, _: &ToggleSidebar, window, cx| {
                    this.toggle_sidebar(window, cx)
                }))
                .on_action(cx.listener(|this, _: &OpenSettings, _, cx| {
                    this.open_settings(SECTIONS[0].path, cx)
                }))
                .on_action(cx.listener(|this, _: &NewThread, window, cx| {
                    this.start_new_thread(None, window, cx)
                }))
                .on_action(cx.listener(|this, _: &ToggleTerminal, window, cx| {
                    this.toggle_terminal(window, cx)
                }))
                .on_action(cx.listener(|this, _: &ToggleDiff, _, cx| {
                    this.toggle_right_panel(PanelTab::Diff, cx)
                }))
                .relative()
                .size_full()
                .flex()
                .flex_row()
                .bg(palette.background)
                .text_color(palette.foreground);
        match self.view {
            View::Chat => {
                if !self.prefs.sidebar_hidden {
                    root = root.child(self.render_sidebar(&palette, cx));
                }
                root = root.child(self.render_chat(palette, window, cx));
                if let Some(panel) = self.render_right_panel(&palette, cx) {
                    root = root.child(panel);
                }
            }
            View::Settings(path) => {
                root = root.child(self.render_settings(path, &palette, window, cx));
            }
        }
        if let Some(overlay) = self.render_palette(&palette, cx) {
            root = root.child(overlay);
        }
        root
    }
}

fn catalog_for(prefs: &LocalPrefs) -> Catalog {
    match &prefs.language {
        Some(lang) => Catalog::for_locale(lang),
        None => Catalog::for_system(),
    }
}

pub fn status_dot_color(status: ThreadStatus, palette: &AppPalette) -> gpui_kit::Hsla {
    match status {
        ThreadStatus::Running | ThreadStatus::Starting | ThreadStatus::Preparing => palette.info,
        ThreadStatus::Waiting | ThreadStatus::Queued => palette.warning,
        ThreadStatus::Completed => palette.success,
        ThreadStatus::Failed => palette.error,
        ThreadStatus::Idle
        | ThreadStatus::Interrupted
        | ThreadStatus::Cancelled
        | ThreadStatus::RolledBack
        | ThreadStatus::Unknown => palette.muted_foreground,
    }
}

pub fn run_gui(bridge: Arc<AppBridge>) {
    let on_quit = bridge.clone();
    gpui_kit::application().run(move |cx: &mut App| {
        gpui_kit::init(cx);
        cx.bind_keys(keybindings());
        cx.on_app_quit(move |_| {
            on_quit.shutdown();
            async {}
        })
        .detach();
        let window_opts = gpui_kit::WindowOptions {
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some("p0code".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let bridge_w = bridge.clone();
        gpui_kit::open_window(window_opts, cx, move |window, cx| {
            let view = cx.new(|cx| P0App::new(bridge_w.clone(), window, cx));
            let focus = view.read(cx).focus.clone();
            window.focus(&focus, cx);
            cx.new(|cx| Root::new(view, window, cx))
        })
        .expect("failed to open p0-gpui window");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keybindings_parse() {
        // KeyBinding::new panics on a keystroke this gpui cannot parse.
        assert_eq!(keybindings().len(), 10);
    }
}
