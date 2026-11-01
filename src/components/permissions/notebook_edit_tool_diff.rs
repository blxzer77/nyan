//! Maps to: CC
//! `components/permissions/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx`.
//!
//! Reads the notebook, resolves the target cell by id or `cell-N`, and renders
//! the official bordered header plus syntax-highlighted insert/delete content
//! or a `StructuredDiff` replacement.

use super::file_permission_dialog::file_permission_relative_to_cwd;
use crate::components::highlighted_code::HighlightedCode;
use crate::components::structured_diff_list::StructuredDiffList;
use crate::types::notebook::NotebookContent;
use crate::utils::notebook::parse_cell_id;
use iocraft::prelude::*;
use similar::{ChangeTag, TextDiff};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotebookEditToolDiffInput {
    pub notebook_path: String,
    pub cell_id: Option<String>,
    pub new_source: String,
    pub cell_type: Option<String>,
    pub edit_mode: String,
    pub verbose: bool,
    pub width: usize,
}

impl Default for NotebookEditToolDiffInput {
    fn default() -> Self {
        Self {
            notebook_path: String::new(),
            cell_id: None,
            new_source: String::new(),
            cell_type: None,
            edit_mode: "replace".to_string(),
            verbose: false,
            width: 80,
        }
    }
}

#[derive(Default, Props)]
pub struct NotebookEditToolDiffProps {
    pub notebook_path: String,
    pub cell_id: Option<String>,
    pub new_source: String,
    pub cell_type: Option<String>,
    pub edit_mode: Option<String>,
    pub verbose: bool,
    pub width: usize,
}

/// Maps to: CC `NotebookEditToolDiff`.
#[component]
pub fn NotebookEditToolDiff(
    props: &NotebookEditToolDiffProps,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let input = NotebookEditToolDiffInput {
        notebook_path: props.notebook_path.clone(),
        cell_id: props.cell_id.clone(),
        new_source: props.new_source.clone(),
        cell_type: props.cell_type.clone(),
        edit_mode: props
            .edit_mode
            .clone()
            .unwrap_or_else(|| "replace".to_string()),
        verbose: props.verbose,
        width: props.width,
    };
    let mut snapshot = hooks.use_state(|| Option::<Option<std::sync::Arc<NotebookContent>>>::None);
    let mut requested_path = hooks.use_state(|| (None::<String>, 0u64));
    let channel = hooks.use_const(|| {
        let channel =
            async_channel::unbounded::<(u64, String, Option<std::sync::Arc<NotebookContent>>)>();
        std::sync::Arc::new(channel)
    });
    let next_generation = {
        let requested = requested_path.read();
        next_notebook_snapshot_generation(&requested, &input.notebook_path)
    };
    if let Some(generation) = next_generation {
        let notebook_path = input.notebook_path.clone();
        requested_path.set((Some(notebook_path.clone()), generation));
        snapshot.set(None);
        let sender = channel.0.clone();
        let _ = std::thread::Builder::new()
            .name("notebook-edit-permission-diff".to_string())
            .spawn(move || {
                let notebook = read_notebook_data(&notebook_path).map(std::sync::Arc::new);
                let _ = sender.send_blocking((generation, notebook_path, notebook));
            });
    }
    let receiver = channel.1.clone();
    hooks.use_future(async move {
        while let Ok((generation, notebook_path, notebook)) = receiver.recv().await {
            let is_current = {
                let requested = requested_path.read();
                notebook_snapshot_is_current(&requested, generation, &notebook_path)
            };
            if is_current {
                snapshot.set(Some(notebook));
            }
        }
    });
    let syntax_highlighting_disabled =
        crate::state::app_state::use_app_state(&mut hooks, |state| {
            state.settings.syntax_highlighting_disabled.unwrap_or(false)
        });
    let rendered = snapshot.read().clone().map(|notebook_data| {
        notebook_edit_diff_element(
            &input,
            notebook_data.as_deref(),
            syntax_highlighting_disabled,
        )
    });

    // CC wraps the read in Suspense with `fallback={null}`. The empty outer
    // View is iocraft's retained equivalent while the background snapshot is
    // pending; filesystem I/O never runs on the render thread.
    element! {
        View(flex_direction: FlexDirection::Column) {
            #(rendered)
        }
    }
}

fn notebook_edit_diff_element(
    input: &NotebookEditToolDiffInput,
    notebook_data: Option<&NotebookContent>,
    syntax_highlighting_disabled: bool,
) -> AnyElement<'static> {
    let old_source = notebook_data
        .and_then(|notebook| notebook_cell_source(notebook, input.cell_id.as_deref()))
        .unwrap_or_default();
    let display_path = notebook_display_path(&input.notebook_path, input.verbose);
    let description = notebook_edit_description_line(input);
    let body: AnyElement<'static> = match input.edit_mode.as_str() {
        "delete" => element! {
            View(flex_direction: FlexDirection::Column, padding_left: 2u32) {
                HighlightedCode(
                    code: old_source.clone(),
                    file_path: input.notebook_path.clone(),
                    width: Some(input.width),
                    syntax_highlighting_disabled: syntax_highlighting_disabled,
                )
            }
        }
        .into_any(),
        "insert" => element! {
            View(flex_direction: FlexDirection::Column, padding_left: 2u32) {
                HighlightedCode(
                    code: input.new_source.clone(),
                    file_path: if input.cell_type.as_deref() == Some("markdown") { "file.md".to_string() } else { input.notebook_path.clone() },
                    width: Some(input.width),
                    syntax_highlighting_disabled: syntax_highlighting_disabled,
                )
            }
        }
        .into_any(),
        _ if notebook_data.is_some() => element! {
            StructuredDiffList(
                hunks: crate::utils::diff::structured_diff_hunks(&old_source, &input.new_source, 3),
                dim: false,
                width: input.width,
                file_path: input.notebook_path.clone(),
                first_line: input.new_source.lines().next().map(str::to_string),
                file_content: Some(old_source.clone()),
            )
        }
        .into_any(),
        _ => element! {
            HighlightedCode(
                code: input.new_source.clone(),
                file_path: if input.cell_type.as_deref() == Some("markdown") { "file.md".to_string() } else { input.notebook_path.clone() },
                width: Some(input.width),
                syntax_highlighting_disabled: syntax_highlighting_disabled,
            )
        }
        .into_any(),
    };

    element! {
        View(flex_direction: FlexDirection::Column) {
            View(border_style: BorderStyle::Round, flex_direction: FlexDirection::Column, padding_left: 1u32, padding_right: 1u32) {
                View(padding_bottom: 1u32, flex_direction: FlexDirection::Column) {
                    Text(content: display_path, weight: Weight::Bold, wrap: TextWrap::Wrap)
                    Text(content: description, dim: true, wrap: TextWrap::Wrap)
                }
                #(body)
            }
        }
    }
    .into_any()
}

/// Maps to: CC `NotebookEditToolDiffInner` render data selection.
pub fn notebook_edit_tool_diff_text(input: &NotebookEditToolDiffInput) -> String {
    let _width = input.width;
    let notebook_data = read_notebook_data(&input.notebook_path);
    let old_source = notebook_data
        .as_ref()
        .and_then(|notebook| notebook_cell_source(notebook, input.cell_id.as_deref()))
        .unwrap_or_default();

    let mut lines = vec![
        notebook_display_path(&input.notebook_path, input.verbose),
        notebook_edit_description_line(input),
    ];

    let body = match input.edit_mode.as_str() {
        "delete" => old_source,
        "insert" => input.new_source.clone(),
        _ if notebook_data.is_some() => notebook_cell_diff_text(&old_source, &input.new_source),
        _ => input.new_source.clone(),
    };
    if !body.is_empty() {
        lines.push(body);
    }
    lines.join("\n")
}

/// Maps to: CC `NotebookEditToolDiff` `useMemo(...readFile...)`.
fn next_notebook_snapshot_generation(
    requested: &(Option<String>, u64),
    notebook_path: &str,
) -> Option<u64> {
    (requested.0.as_deref() != Some(notebook_path)).then_some(requested.1.wrapping_add(1))
}

fn notebook_snapshot_is_current(
    requested: &(Option<String>, u64),
    generation: u64,
    notebook_path: &str,
) -> bool {
    requested.1 == generation && requested.0.as_deref() == Some(notebook_path)
}

// DEVIATION(SAFETY): CC's Suspense read is asynchronous but unbounded. Cap
// preview-only I/O and reject non-regular handles so pipes/devices cannot pin a
// worker forever or force unbounded memory while the permission UI is open.
const MAX_NOTEBOOK_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;

fn read_notebook_data(notebook_path: &str) -> Option<NotebookContent> {
    use std::io::Read as _;

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(notebook_path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_NOTEBOOK_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_NOTEBOOK_PREVIEW_BYTES {
        return None;
    }
    let content = String::from_utf8(bytes).ok()?;
    // CC safeParseJSON strips exactly one leading BOM for the preview path.
    serde_json::from_str::<NotebookContent>(content.strip_prefix('\u{feff}').unwrap_or(&content))
        .ok()
}

/// Maps to: CC `NotebookEditToolDiffInner` `oldSource` memo.
fn notebook_cell_source(notebook: &NotebookContent, cell_id: Option<&str>) -> Option<String> {
    let cell_id = cell_id?;
    if let Some(index) = parse_cell_id(cell_id) {
        return notebook.cells.get(index).map(|cell| cell.source.joined());
    }
    notebook
        .cells
        .iter()
        .find(|cell| cell.id.as_deref() == Some(cell_id))
        .map(|cell| cell.source.joined())
}

/// Maps to: CC `NotebookEditToolDiffInner` path header.
fn notebook_display_path(notebook_path: &str, verbose: bool) -> String {
    if verbose {
        notebook_path.to_string()
    } else {
        file_permission_relative_to_cwd(notebook_path)
    }
}

/// Maps to: CC `NotebookEditToolDiffInner` `editTypeDescription`.
fn notebook_edit_description_line(input: &NotebookEditToolDiffInput) -> String {
    let description = match input.edit_mode.as_str() {
        "insert" => "Insert new cell",
        "delete" => "Delete cell",
        _ => "Replace cell contents",
    };
    let cell_id = input.cell_id.as_deref().unwrap_or("undefined");
    let cell_type = input
        .cell_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" ({value})"))
        .unwrap_or_default();
    format!("{description} for cell {cell_id}{cell_type}")
}

/// Maps to: CC `NotebookEditToolDiffInner` `getPatchForDisplay(...)` branch.
fn notebook_cell_diff_text(old_source: &str, new_source: &str) -> String {
    if old_source == new_source {
        return String::new();
    }
    let diff = TextDiff::from_lines(old_source, new_source);
    let mut lines = Vec::new();
    for change in diff.iter_all_changes() {
        let prefix = match change.tag() {
            ChangeTag::Delete => '-',
            ChangeTag::Insert => '+',
            ChangeTag::Equal => ' ',
        };
        let value = change.value().trim_end_matches('\n');
        if value.is_empty() && change.value().contains('\n') {
            lines.push(prefix.to_string());
        } else {
            lines.push(format!("{prefix}{value}"));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    fn temp_notebook(name: &str, cells: serde_json::Value) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nyan-notebook-edit-tool-diff-{name}-{}.ipynb",
            std::process::id()
        ));
        let content = serde_json::json!({
            "cells": cells,
            "metadata": {"language_info": {"name": "python"}},
            "nbformat": 4,
            "nbformat_minor": 5
        });
        std::fs::write(&path, serde_json::to_string(&content).unwrap()).unwrap();
        path
    }

    fn input(path: &std::path::Path, edit_mode: &str) -> NotebookEditToolDiffInput {
        NotebookEditToolDiffInput {
            notebook_path: path.display().to_string(),
            cell_id: Some("abc123".to_string()),
            new_source: "print('new')\n".to_string(),
            cell_type: Some("code".to_string()),
            edit_mode: edit_mode.to_string(),
            verbose: true,
            width: 120,
        }
    }

    #[test]
    fn notebook_edit_tool_diff_replaces_cell_with_diff_when_notebook_exists() {
        let path = temp_notebook(
            "replace",
            serde_json::json!([{ "id": "abc123", "cell_type": "code", "source": "print('old')\n" }]),
        );
        let text = notebook_edit_tool_diff_text(&input(&path, "replace"));
        let _ = std::fs::remove_file(path);

        assert!(
            text.contains("Replace cell contents for cell abc123 (code)"),
            "text=\n{text}"
        );
        assert!(text.contains("-print('old')"), "text=\n{text}");
        assert!(text.contains("+print('new')"), "text=\n{text}");
    }

    #[test]
    fn notebook_edit_tool_diff_finds_cell_dash_index_like_official_parse_cell_id() {
        let path = temp_notebook(
            "index",
            serde_json::json!([
                { "id": "first", "cell_type": "code", "source": "one\n" },
                { "id": "second", "cell_type": "markdown", "source": ["two", "\n"] }
            ]),
        );
        let mut request = input(&path, "delete");
        request.cell_id = Some("cell-1".to_string());
        request.cell_type = Some("markdown".to_string());
        let text = notebook_edit_tool_diff_text(&request);
        let _ = std::fs::remove_file(path);

        assert!(
            text.contains("Delete cell for cell cell-1 (markdown)"),
            "text=\n{text}"
        );
        assert!(text.contains("two"), "text=\n{text}");
    }

    #[test]
    fn notebook_edit_tool_diff_reloads_and_rejects_stale_snapshot_after_path_change() {
        let initial = (None, 0);
        let first_generation =
            next_notebook_snapshot_generation(&initial, "/tmp/a.ipynb").expect("initial snapshot");
        let first = (Some("/tmp/a.ipynb".to_string()), first_generation);
        assert_eq!(
            next_notebook_snapshot_generation(&first, "/tmp/a.ipynb"),
            None
        );

        let second_generation = next_notebook_snapshot_generation(&first, "/tmp/b.ipynb")
            .expect("changed path snapshot");
        let second = (Some("/tmp/b.ipynb".to_string()), second_generation);
        assert!(!notebook_snapshot_is_current(
            &second,
            first_generation,
            "/tmp/a.ipynb"
        ));
        assert!(notebook_snapshot_is_current(
            &second,
            second_generation,
            "/tmp/b.ipynb"
        ));
    }

    #[test]
    fn notebook_edit_tool_diff_preview_strips_utf8_bom_like_safe_parse_json() {
        let path = temp_notebook(
            "bom",
            serde_json::json!([{ "id": "abc123", "cell_type": "code", "source": "old\n" }]),
        );
        let content = std::fs::read(&path).unwrap();
        let mut bom_content = vec![0xef, 0xbb, 0xbf];
        bom_content.extend(content);
        std::fs::write(&path, bom_content).unwrap();
        let text = notebook_edit_tool_diff_text(&input(&path, "replace"));
        let _ = std::fs::remove_file(path);
        assert!(text.contains("-old"), "text=\n{text}");
        assert!(text.contains("+print('new')"), "text=\n{text}");
    }

    #[test]
    fn notebook_edit_tool_diff_insert_and_missing_notebook_show_new_source() {
        let path = std::env::temp_dir().join(format!(
            "nyan-notebook-edit-tool-diff-missing-{}.ipynb",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let text = notebook_edit_tool_diff_text(&input(&path, "insert"));

        assert!(
            text.contains("Insert new cell for cell abc123 (code)"),
            "text=\n{text}"
        );
        assert!(text.contains("print('new')"), "text=\n{text}");
    }

    #[test]
    fn notebook_edit_tool_diff_caps_background_preview_reads() {
        let path = std::env::temp_dir().join(format!(
            "nyan-notebook-edit-preview-cap-{}.ipynb",
            uuid::Uuid::new_v4().simple()
        ));
        let mut content = br#"{"cells":[]}"#.to_vec();
        content.resize(MAX_NOTEBOOK_PREVIEW_BYTES as usize + 1, b' ');
        std::fs::write(&path, content).unwrap();
        assert!(read_notebook_data(&path.display().to_string()).is_none());
        let _ = std::fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn notebook_edit_tool_diff_does_not_block_render_on_fifo() {
        let path = std::env::temp_dir().join(format!(
            "nyan-notebook-edit-preview-fifo-{}.ipynb",
            uuid::Uuid::new_v4().simple()
        ));
        let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(result, 0);

        let started = std::time::Instant::now();
        // The children thunk is `Fn`, so it cannot move `path` out; it also
        // must not borrow it, since the thunk outlives this statement.
        let path_for_tree = path.display().to_string();
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                // Reads `settings.syntax_highlighting_disabled`. This test is a
                // timing assertion (the FIFO must not block the render), so the
                // AppState value is irrelevant — defaults are the fixture.
                crate::state::app_state::AppStateProvider(
                    children: crate::state::app_state::ProviderChildren::new(move || element! {
                        NotebookEditToolDiff(
                            notebook_path: path_for_tree.clone(),
                            cell_id: Some("cell-a".to_string()),
                            new_source: "new".to_string(),
                            cell_type: Some("code".to_string()),
                            edit_mode: Some("replace".to_string()),
                            verbose: true,
                            width: 80usize,
                        )
                    }.into_any()),
                )
            }
        }
        .render(Some(100))
        .to_string();
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
        assert!(
            text.trim().is_empty(),
            "pending fallback should be null: {text:?}"
        );

        std::thread::sleep(std::time::Duration::from_millis(10));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn notebook_edit_tool_diff_loaded_snapshot_renders_text_preview() {
        let path = temp_notebook(
            "component",
            serde_json::json!([{ "id": "abc123", "cell_type": "code", "source": "old\n" }]),
        );
        let request = NotebookEditToolDiffInput {
            notebook_path: path.display().to_string(),
            cell_id: Some("abc123".to_string()),
            new_source: "new\n".to_string(),
            cell_type: Some("code".to_string()),
            edit_mode: "replace".to_string(),
            verbose: true,
            width: 80,
        };
        let notebook = read_notebook_data(&request.notebook_path).expect("notebook snapshot");
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                // `notebook_edit_diff_element` renders StructuredDiffList, which
                // reads `settings.syntax_highlighting_disabled` — so this free
                // function needs the provider just as the component does.
                crate::state::app_state::AppStateProvider(
                    children: crate::state::app_state::ProviderChildren::new({
                        let request = request.clone();
                        let notebook = notebook.clone();
                        move || element! {
                            View {
                                #(notebook_edit_diff_element(&request, Some(&notebook), false))
                            }
                        }.into_any()
                    }),
                )
            }
        }
        .render(Some(100))
        .to_string();
        let _ = std::fs::remove_file(path);

        assert!(text.contains("-old"), "canvas=\n{text}");
        assert!(text.contains("+new"), "canvas=\n{text}");
    }
}
