//! Maps to: CC `components/permissions/rules/RemoveWorkspaceDirectory.tsx`.
//!
//! The confirmation Select is driven by the CustomSelect hooks
//! (`use_select_state` + `use_select_input`), matching CC's autonomous
//! `<Select>` at RemoveWorkspaceDirectory.tsx:58-65. This owner applies the
//! session-only removal before delivering setPermissionContext and onRemove.

use crate::components::custom_select::{
    Select, SelectInputOptionMeta, SelectLayout, SelectOptionData, UseSelectInputOptions,
    UseSelectStateProps, use_select_input, use_select_state,
};
use crate::components::design_system::dialog::Dialog;
use crate::tool::ToolPermissionContext;
use crate::types::permissions::{PermissionUpdate, PermissionUpdateDestination};
use crate::utils::permissions::permission_update::apply_permission_update;
use crate::utils::theme::Theme;
use iocraft::prelude::*;
use std::sync::Arc;

pub const REMOVE_WORKSPACE_DIRECTORY_MESSAGE: &str =
    "nyan will no longer have access to files in this directory.";

/// Maps to: CC `RemoveWorkspaceDirectory.tsx#handleRemove` update shape.
pub fn remove_workspace_directory_update(directory_path: &str) -> PermissionUpdate {
    PermissionUpdate::RemoveDirectories {
        destination: PermissionUpdateDestination::Session,
        directories: vec![directory_path.to_string()],
    }
}

pub fn remove_workspace_directory_options() -> Vec<SelectOptionData> {
    [("Yes", "yes"), ("No", "no")]
        .into_iter()
        .map(|(label, value)| SelectOptionData {
            label: label.to_string(),
            value: value.to_string(),
            description: None,
            dim_description: true,
            disabled: false,
            input: None,
        })
        .collect()
}

#[derive(Default, Props)]
pub struct RemoveWorkspaceDirectoryProps<'a> {
    pub directory_path: String,
    pub permission_context: Arc<ToolPermissionContext>,
    pub set_permission_context: HandlerMut<'a, Arc<ToolPermissionContext>>,
    /// Maps to: CC `onRemove` (invoked by `handleSelect('yes')` →
    /// `handleRemove`, RemoveWorkspaceDirectory.tsx:24-44).
    pub on_remove: HandlerMut<'a, ()>,
    /// Maps to: CC `onCancel` (non-yes selection and Select `onCancel`).
    pub on_cancel: HandlerMut<'a, ()>,
}

/// Maps to: CC `RemoveWorkspaceDirectory` render path
/// (RemoveWorkspaceDirectory.tsx:17-68).
#[component]
pub fn RemoveWorkspaceDirectory<'a>(
    props: &mut RemoveWorkspaceDirectoryProps<'a>,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let mut pending_cancel = hooks.use_state(|| false);
    let options = remove_workspace_directory_options();
    // Maps to: CC RemoveWorkspaceDirectory.tsx:58-65 — autonomous
    // `<Select options={Yes/No} onChange={handleSelect} onCancel={onCancel}/>`
    // (visibleOptionCount defaults to 5, select.tsx:207).
    let state = use_select_state(
        &mut hooks,
        UseSelectStateProps {
            visible_option_count: Some(5),
            values: options.iter().map(|option| option.value.clone()).collect(),
            default_value: None,
            focus_value: None,
        },
    );
    let events = use_select_input(
        &mut hooks,
        state,
        UseSelectInputOptions {
            has_on_cancel: true,
            option_metas: options
                .iter()
                .map(|option| SelectInputOptionMeta {
                    value: option.value.clone(),
                    disabled: option.disabled,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        },
    );

    // Maps to: CC RemoveWorkspaceDirectory.tsx:35-44 `handleSelect` —
    // 'yes' removes, anything else cancels.
    if let Some(value) = events.take_accepted() {
        if value == "yes" {
            // CC :24-33 handleRemove: apply to the captured context, publish
            // that context, then notify the parent; no settings persistence.
            let updated = apply_permission_update(
                &props.permission_context,
                &remove_workspace_directory_update(&props.directory_path),
            );
            (props.set_permission_context)(Arc::new(updated));
            (props.on_remove)(());
        } else {
            pending_cancel.set(true);
        }
    }
    // Maps to: CC RemoveWorkspaceDirectory.tsx:60 `onCancel={onCancel}`.
    if events.take_cancelled() {
        pending_cancel.set(true);
    }
    if pending_cancel.get() {
        pending_cancel.set(false);
        (props.on_cancel)(());
    }

    let navigation = state.navigation.snapshot();
    let focused_index = navigation.focused_index().unwrap_or(0);
    element! {
        Dialog(title: "Remove directory from workspace?".to_string(), color: Some(theme.error), on_cancel: move |_| pending_cancel.set(true)) {
            View(margin_left: 2u32, margin_right: 2u32, flex_direction: FlexDirection::Column) {
                Text(content: props.directory_path.clone(), weight: Weight::Bold)
            }
            Text(content: REMOVE_WORKSPACE_DIRECTORY_MESSAGE.to_string(), wrap: TextWrap::Wrap)
            Select(
                options: options.clone(),
                focused_index: focused_index,
                visible_option_count: navigation.visible_option_count,
                visible_from_index: navigation.visible_from_index,
                layout: SelectLayout::Compact,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    #[test]
    fn remove_workspace_directory_update_matches_official_shape() {
        assert_eq!(
            remove_workspace_directory_update("/repo/extra"),
            PermissionUpdate::RemoveDirectories {
                destination: PermissionUpdateDestination::Session,
                directories: vec!["/repo/extra".to_string()],
            }
        );
        assert_eq!(
            remove_workspace_directory_options()
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            vec!["yes", "no"]
        );
    }

    #[test]
    fn remove_workspace_directory_renders_official_copy() {
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                RemoveWorkspaceDirectory(directory_path: "/repo/extra".to_string())
            }
        }
        .render(Some(100))
        .to_string();
        assert!(
            text.contains("Remove directory from workspace?"),
            "canvas=\n{text}"
        );
        assert!(text.contains("/repo/extra"), "canvas=\n{text}");
        assert!(text.contains("no longer have access"), "canvas=\n{text}");
        assert!(
            text.contains("❯ 1. Yes"),
            "shared Select should render the focused pointer and index; canvas=\n{text}"
        );
        assert!(text.contains("2. No"), "canvas=\n{text}");
    }

    #[tokio::test]
    async fn remove_workspace_directory_matches_official_context_before_notification() {
        use futures::StreamExt;
        use std::time::Duration;
        let context = apply_permission_update(
            &ToolPermissionContext::default(),
            &PermissionUpdate::AddDirectories {
                directories: vec!["/repo/remove".to_string(), "/repo/keep".to_string()],
                destination: PermissionUpdateDestination::LocalSettings,
            },
        );
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let updates = events.clone();
        let removals = events.clone();
        let mut app = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                ContextProvider(value: Context::owned(crate::keybindings::keybinding_context::KeybindingRuntime::with_default_bindings())) {
                RemoveWorkspaceDirectory(
                    directory_path: "/repo/remove".to_string(), permission_context: Arc::new(context),
                    set_permission_context: move |updated: Arc<ToolPermissionContext>| {
                        assert!(!updated.additional_working_directories.contains_key("/repo/remove"));
                        assert!(updated.additional_working_directories.contains_key("/repo/keep"));
                        updates.lock().unwrap().push("set");
                    },
                    on_remove: move |_| removals.lock().unwrap().push("remove"),
                )
                }
            }
        };
        let (sender, keys) = async_channel::unbounded();
        let mut renders = Box::pin(
            app.mock_terminal_render_loop(MockTerminalConfig::with_events(keys).with_size(100, 20)),
        );
        let deadline = futures_timer::Delay::new(Duration::from_secs(1));
        tokio::pin!(deadline);
        let mut submitted = false;
        let mut last_canvas = String::new();
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                canvas = renders.next() => {
                    let Some(canvas) = canvas else { break; };
                    last_canvas = canvas.to_string();
                    if !submitted && last_canvas.contains("❯ 1. Yes") {
                        sender.send(TerminalEvent::Key(KeyEvent::new(KeyEventKind::Press, KeyCode::Enter))).await.unwrap();
                        submitted = true;
                    }
                    if events.lock().unwrap().len() == 2 { break; }
                }
            }
        }
        assert!(
            submitted,
            "Yes was not selectable; last canvas:\n{last_canvas}"
        );
        assert_eq!(
            *events.lock().unwrap(),
            vec!["set", "remove"],
            "last canvas:\n{last_canvas}"
        );
    }
}
