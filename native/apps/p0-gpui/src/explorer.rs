//! Files of the open thread's folder: a lazily listed tree (`projects.listEntries`, one folder
//! per expand) and a read-only, syntax-colored viewer (`projects.readFile`). PDFs open in the
//! Preview tab.

use std::collections::{HashMap, HashSet};

use gpui_kit::component::input::{Editor, EditorState};
use gpui_kit::component::list::ListItem;
use gpui_kit::component::tree::{TreeEvent, TreeItem, TreeState, tree};
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};
use p0_protocol::{
    EntriesResult, ListEntriesInput, ProjectEntry, ProjectEntryKind, RPC_PROJECTS_LIST_ENTRIES,
    RPC_PROJECTS_READ_FILE, ReadFileInput, ReadFileResult,
};

use crate::app::P0App;
use crate::theme::AppPalette;

/// Ids of rows that are not entries end in a NUL, which no path contains.
const PLACEHOLDER: &str = "\0";

struct OpenFile {
    path: String,
    editor: Option<Entity<EditorState>>,
    truncated: bool,
    error: Option<String>,
}

pub struct FileExplorer {
    tree: Entity<TreeState>,
    cwd: Option<String>,
    /// Folder (`""` is the root) to its entries, once listed.
    listings: HashMap<String, Vec<ProjectEntry>>,
    loading: HashSet<String>,
    expanded: HashSet<String>,
    ignored: HashSet<String>,
    error: Option<String>,
    open: Option<OpenFile>,
    _sub: Subscription,
}

impl FileExplorer {
    pub fn new(cx: &mut Context<P0App>) -> Self {
        let tree = cx.new(|cx| TreeState::new(cx));
        let sub = cx.subscribe(&tree, |app, _, event: &TreeEvent, cx| {
            app.on_explorer_tree_event(event, cx)
        });
        Self {
            tree,
            cwd: None,
            listings: HashMap::new(),
            loading: HashSet::new(),
            expanded: HashSet::new(),
            ignored: HashSet::new(),
            error: None,
            open: None,
            _sub: sub,
        }
    }

    /// Starts over when the thread's folder changes.
    pub fn sync(&mut self, cwd: Option<&str>) {
        if self.cwd.as_deref() == cwd {
            return;
        }
        self.cwd = cwd.map(ToOwned::to_owned);
        self.listings.clear();
        self.loading.clear();
        self.expanded.clear();
        self.ignored.clear();
        self.error = None;
        self.open = None;
    }

    fn items(&self, dir: &str) -> Vec<TreeItem> {
        let Some(entries) = self.listings.get(dir) else {
            return Vec::new();
        };
        let mut sorted: Vec<&ProjectEntry> = entries.iter().collect();
        sorted.sort_by(|a, b| {
            (a.kind != ProjectEntryKind::Directory, a.path.to_lowercase())
                .cmp(&(b.kind != ProjectEntryKind::Directory, b.path.to_lowercase()))
        });
        sorted
            .into_iter()
            .map(|entry| {
                let path = entry_path(dir, &entry.path);
                let mut item = TreeItem::new(path.clone(), basename(&path).to_owned());
                if entry.kind == ProjectEntryKind::Directory {
                    item = if self.listings.contains_key(&path) {
                        let children = self.items(&path);
                        if children.is_empty() {
                            item.child(placeholder(&path, "—"))
                        } else {
                            item.children(children)
                        }
                    } else {
                        item.child(placeholder(&path, "…"))
                    };
                    item = item.expanded(self.expanded.contains(&path));
                }
                item
            })
            .collect()
    }
}

fn placeholder(dir: &str, label: &str) -> TreeItem {
    TreeItem::new(format!("{dir}/{PLACEHOLDER}"), label.to_owned()).disabled(true)
}

/// Entries come relative to the listed root; tolerate a server that names them by basename.
fn entry_path(dir: &str, path: &str) -> String {
    if dir.is_empty() || path.starts_with(&format!("{dir}/")) {
        path.to_owned()
    } else {
        format!("{dir}/{path}")
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

impl P0App {
    fn rebuild_explorer_tree(&mut self, cx: &mut Context<Self>) {
        let explorer = &self.right_panel.files;
        let items = explorer.items("");
        let selected = explorer
            .tree
            .read(cx)
            .selected_item()
            .map(|item| item.id.clone());
        explorer.tree.update(cx, |tree, cx| {
            tree.set_items(items, cx);
            if let Some(ix) = selected.and_then(|id| tree.index_of(&id)) {
                tree.set_selected_index(Some(ix), cx);
            }
        });
    }

    fn list_explorer_dir(&mut self, dir: String, cx: &mut Context<Self>) {
        let explorer = &mut self.right_panel.files;
        let Some(cwd) = explorer.cwd.clone() else {
            return;
        };
        if explorer.listings.contains_key(&dir) || !explorer.loading.insert(dir.clone()) {
            return;
        }
        let fetch = self.bridge.query::<_, EntriesResult>(
            RPC_PROJECTS_LIST_ENTRIES,
            ListEntriesInput {
                cwd: cwd.clone(),
                directory_path: (!dir.is_empty()).then(|| dir.clone()),
            },
        );
        cx.spawn(async move |this, cx| {
            let result = fetch.await;
            this.update(cx, |app, cx| {
                let explorer = &mut app.right_panel.files;
                if explorer.cwd.as_deref() != Some(cwd.as_str()) {
                    return;
                }
                explorer.loading.remove(&dir);
                match result {
                    Ok(listing) => {
                        // A listing may reach below `dir`; like the web app, keep its children.
                        let children: Vec<ProjectEntry> = listing
                            .entries
                            .into_iter()
                            .filter(|e| parent(&entry_path(&dir, &e.path)) == dir)
                            .collect();
                        for entry in children.iter().filter(|e| e.ignored) {
                            explorer.ignored.insert(entry_path(&dir, &entry.path));
                        }
                        explorer.listings.insert(dir, children);
                    }
                    Err(err) => explorer.error = Some(err),
                }
                app.rebuild_explorer_tree(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn on_explorer_tree_event(&mut self, event: &TreeEvent, cx: &mut Context<Self>) {
        match event {
            TreeEvent::Expanded(id) => {
                let dir = id.to_string();
                self.right_panel.files.expanded.insert(dir.clone());
                self.list_explorer_dir(dir, cx);
            }
            TreeEvent::Collapsed(id) => {
                self.right_panel.files.expanded.remove(id.as_ref());
            }
        }
    }

    pub(crate) fn open_explorer_file(
        &mut self,
        path: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if crate::preview::policy::is_pdf(&path, "") {
            if let Some(thread_id) = self.selected_thread_id().map(ToOwned::to_owned) {
                self.open_document(
                    crate::preview::DocSource::WorkspaceFile { thread_id, path },
                    cx,
                );
            }
            return;
        }
        let explorer = &mut self.right_panel.files;
        let Some(cwd) = explorer.cwd.clone() else {
            return;
        };
        if explorer.open.as_ref().is_some_and(|f| f.path == path) {
            return;
        }
        explorer.open = Some(OpenFile {
            path: path.clone(),
            editor: None,
            truncated: false,
            error: None,
        });
        let fetch = self.bridge.query::<_, ReadFileResult>(
            RPC_PROJECTS_READ_FILE,
            ReadFileInput {
                cwd,
                relative_path: path.clone(),
            },
        );
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = fetch.await;
            cx.update_window(window_handle, |_, window, cx| {
                this.update(cx, |app, cx| {
                    let Some(open) = app
                        .right_panel
                        .files
                        .open
                        .as_mut()
                        .filter(|f| f.path == path)
                    else {
                        return;
                    };
                    match result {
                        Ok(file) => {
                            let language = path.rsplit('.').next().unwrap_or("text").to_owned();
                            let contents = file.contents;
                            open.truncated = file.truncated;
                            open.editor = Some(cx.new(|cx| {
                                EditorState::new(window, cx)
                                    .language(language)
                                    .line_number(true)
                                    .default_value(contents)
                            }));
                        }
                        Err(err) => open.error = Some(err),
                    }
                    cx.notify();
                })
                .ok();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn render_explorer(
        &mut self,
        palette: &AppPalette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.list_explorer_dir(String::new(), cx);
        let explorer = &self.right_panel.files;
        let view = cx.entity().downgrade();
        let ignored = explorer.ignored.clone();
        let (fg, muted, hover) = (
            palette.foreground,
            palette.muted_foreground,
            palette.row_hover,
        );
        let file_tree = tree(&explorer.tree, move |ix, entry, _selected, _, _| {
            let item = entry.item();
            let path = item.id.to_string();
            let is_folder = entry.is_folder();
            let marker = match (is_folder, entry.is_expanded()) {
                (true, true) => "▾",
                (true, false) => "▸",
                (false, _) => "",
            };
            let color = if entry.is_disabled() || ignored.contains(&path) {
                muted
            } else {
                fg
            };
            let view = view.clone();
            ListItem::new(ix)
                .on_click(move |_, window, cx| {
                    if is_folder || path.ends_with(PLACEHOLDER) {
                        return;
                    }
                    let path = path.clone();
                    view.update(cx, |app, cx| app.open_explorer_file(path, window, cx))
                        .ok();
                })
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .pl(px(12.0 * entry.depth() as f32))
                        .text_sm()
                        .text_color(color)
                        .hover(|s| s.bg(hover))
                        .child(div().w(px(10.0)).flex_none().child(marker))
                        .child(div().truncate().child(item.label.clone())),
                )
        });

        let mut col = div().flex_1().min_h_0().flex().flex_col();
        if let Some(err) = &explorer.error {
            col = col.child(
                div()
                    .flex_none()
                    .px(px(10.0))
                    .py(px(4.0))
                    .text_xs()
                    .bg(palette.error_surface)
                    .text_color(palette.error)
                    .child(SharedString::from(err.clone())),
            );
        }
        let tree_box = div().min_h_0().p(px(4.0)).child(file_tree);
        let Some(open) = &explorer.open else {
            return col.child(tree_box.flex_1());
        };
        let viewer = match (&open.editor, &open.error) {
            (Some(editor), _) => Editor::new(editor)
                .readonly(true)
                .bordered(false)
                .size_full()
                .into_any_element(),
            (None, Some(err)) => div()
                .p(px(12.0))
                .text_sm()
                .text_color(palette.error)
                .child(SharedString::from(err.clone()))
                .into_any_element(),
            (None, None) => div()
                .p(px(12.0))
                .text_sm()
                .text_color(palette.muted_foreground)
                .child(SharedString::from(self.i18n.tr("Loading...").to_owned()))
                .into_any_element(),
        };
        let mut header = div()
            .flex_none()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .px(px(10.0))
            .py(px(4.0))
            .border_y_1()
            .border_color(palette.border)
            .text_xs()
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family("monospace")
                    .text_color(palette.foreground)
                    .child(SharedString::from(open.path.clone())),
            );
        if open.truncated {
            header = header.child(
                div()
                    .flex_none()
                    .text_color(palette.warning)
                    .child(SharedString::from(self.i18n.tr("Truncated").to_owned())),
            );
        }
        header = header.child(
            div()
                .id("explorer-close-file")
                .flex_none()
                .cursor_pointer()
                .text_color(palette.muted_foreground)
                .hover(|s| s.text_color(palette.foreground))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.right_panel.files.open = None;
                    cx.notify();
                }))
                .child("✕"),
        );
        col.child(tree_box.h(px(220.0)).flex_none())
            .child(header)
            .child(div().flex_1().min_h_0().child(viewer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_paths_join_once() {
        assert_eq!(entry_path("", "src"), "src");
        assert_eq!(entry_path("src", "src/main.rs"), "src/main.rs");
        assert_eq!(entry_path("src", "main.rs"), "src/main.rs");
        assert_eq!(basename("src/util/math.rs"), "math.rs");
        assert_eq!(parent("src/util/math.rs"), "src/util");
        assert_eq!(parent("README.md"), "");
    }
}
