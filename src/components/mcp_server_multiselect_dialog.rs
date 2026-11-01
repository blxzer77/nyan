//! Maps to: CC `components/MCPServerMultiselectDialog.tsx`.
//!
//! Safety boundary: the official dialog logs analytics and writes approved /
//! rejected server names into local settings. Nyan preserves visible copy,
//! default selection, Space/Enter/Esc behavior, approval partitioning, and emits
//! the approved/rejected lists via callback. Settings writes and analytics are
//! deferred to the MCP settings runtime slice.

use crate::components::configurable_shortcut_hint::ConfigurableShortcutHint;
use crate::components::custom_select::{SelectMulti, SelectOptionData};
use crate::components::design_system::byline::Byline;
use crate::components::design_system::dialog::Dialog;
use crate::components::design_system::keyboard_shortcut_hint::KeyboardShortcutHint;
use crate::components::mcp_server_dialog_copy::MCPServerDialogCopy;
use crate::utils::theme::Theme;
use iocraft::prelude::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MCPServerMultiselectResult {
    pub approved_servers: Vec<String>,
    pub rejected_servers: Vec<String>,
}

/// Maps to: CC `MCPServerMultiselectDialog.tsx` `partition(serverNames, ...)`.
pub fn partition_mcp_server_selection(
    server_names: &[String],
    selected_servers: &[String],
) -> MCPServerMultiselectResult {
    let mut approved_servers = Vec::new();
    let mut rejected_servers = Vec::new();
    for server in server_names {
        if selected_servers.iter().any(|selected| selected == server) {
            approved_servers.push(server.clone());
        } else {
            rejected_servers.push(server.clone());
        }
    }
    MCPServerMultiselectResult {
        approved_servers,
        rejected_servers,
    }
}

pub fn mcp_server_multiselect_options(server_names: &[String]) -> Vec<SelectOptionData> {
    server_names
        .iter()
        .map(|server| SelectOptionData {
            label: server.clone(),
            value: server.clone(),
            ..SelectOptionData::default()
        })
        .collect()
}

#[derive(Default, Props)]
pub struct MCPServerMultiselectDialogProps<'a> {
    pub server_names: Vec<String>,
    pub on_submit: HandlerMut<'a, MCPServerMultiselectResult>,
    pub on_done: HandlerMut<'a, ()>,
}

/// Maps to: CC `components/MCPServerMultiselectDialog.tsx`.
#[component]
pub fn MCPServerMultiselectDialog<'a>(
    props: &mut MCPServerMultiselectDialogProps<'a>,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let mut pending_result = hooks.use_state(|| Option::<MCPServerMultiselectResult>::None);
    let server_names = props.server_names.clone();
    let options = mcp_server_multiselect_options(&server_names);

    let pending = {
        let result = pending_result.read();
        result.clone()
    };
    if let Some(result) = pending {
        pending_result.set(None);
        (props.on_submit)(result);
        (props.on_done)(());
    }

    let default_value = server_names.clone();
    let dialog_cancel_names = server_names.clone();
    let submit_server_names = server_names.clone();
    let select_cancel_names = server_names.clone();
    let mut dialog_cancel_pending = pending_result;
    let mut submit_pending = pending_result;
    let mut select_cancel_pending = pending_result;

    element! {
        View(flex_direction: FlexDirection::Column) {
            Dialog(
                title: format!("{} new MCP servers found in .mcp.json", server_names.len()),
                subtitle: Some("Select any you wish to enable.".to_string()),
                color: Some(theme.warning),
                hide_input_guide: true,
                on_cancel: move |_| {
                    dialog_cancel_pending.set(Some(MCPServerMultiselectResult {
                        approved_servers: Vec::new(),
                        rejected_servers: dialog_cancel_names.clone(),
                    }));
                },
            ) {
                MCPServerDialogCopy()
                SelectMulti(
                    options: options,
                    default_value: default_value,
                    hide_indexes: true,
                    handle_escape: Some(false),
                    on_submit: move |selected_servers: Vec<String>| {
                        submit_pending.set(Some(partition_mcp_server_selection(&submit_server_names, &selected_servers)));
                    },
                    on_cancel: move |_| {
                        select_cancel_pending.set(Some(MCPServerMultiselectResult {
                            approved_servers: Vec::new(),
                            rejected_servers: select_cancel_names.clone(),
                        }));
                    },
                )
            }
            View(padding_left: 1u32, padding_right: 1u32) {
                Byline {
                    KeyboardShortcutHint(shortcut: "Space".to_string(), action: "select".to_string())
                    KeyboardShortcutHint(shortcut: "Enter".to_string(), action: "confirm".to_string())
                    ConfigurableShortcutHint(
                        action: "confirm:no".to_string(),
                        context: "Confirmation".to_string(),
                        fallback: "Esc".to_string(),
                        description: "reject all".to_string(),
                    )
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;
    use futures::{StreamExt, stream};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn key(code: KeyCode) -> TerminalEvent {
        TerminalEvent::Key(KeyEvent::new(KeyEventKind::Press, code))
    }

    #[test]
    fn mcp_server_multiselect_partitions_like_official() {
        let names = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(
            partition_mcp_server_selection(&names, &["a".to_string(), "c".to_string()]),
            MCPServerMultiselectResult {
                approved_servers: vec!["a".to_string(), "c".to_string()],
                rejected_servers: vec!["b".to_string()],
            }
        );
    }

    #[test]
    fn mcp_server_multiselect_dialog_renders_copy_options_and_hints() {
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                MCPServerMultiselectDialog(server_names: vec!["fs".to_string(), "git".to_string()])
            }
        }
        .render(Some(120))
        .to_string();

        assert!(
            text.contains("2 new MCP servers found in .mcp.json"),
            "canvas=\n{text}"
        );
        assert!(
            text.contains("Select any you wish to enable."),
            "canvas=\n{text}"
        );
        assert!(text.contains("[✓] fs"), "canvas=\n{text}");
        assert!(text.contains("[✓] git"), "canvas=\n{text}");
        assert!(text.contains("Space to select"), "canvas=\n{text}");
        assert!(text.contains("Esc to reject all"), "canvas=\n{text}");
    }

    #[test]
    fn mcp_server_multiselect_space_and_enter_submit_partition_callback_only() {
        let results = Arc::new(Mutex::new(Vec::<MCPServerMultiselectResult>::new()));
        let done = Arc::new(Mutex::new(0usize));
        let results_for_handler = Arc::clone(&results);
        let done_for_handler = Arc::clone(&done);

        futures::executor::block_on(async move {
            let mut app = element! {
                ContextProvider(value: Context::owned(*theme::current())) {
                    MCPServerMultiselectDialog(
                        server_names: vec!["fs".to_string(), "git".to_string()],
                        on_submit: move |result| results_for_handler.lock().expect("results mutex").push(result),
                        on_done: move |_| *done_for_handler.lock().expect("done mutex") += 1,
                    )
                }
            };
            let mut render_loop = Box::pin(
                app.mock_terminal_render_loop(
                    MockTerminalConfig::with_events(stream::iter(vec![
                        key(KeyCode::Char(' ')),
                        key(KeyCode::Enter),
                    ]))
                    .with_size(120, 24),
                ),
            );
            for _ in 0..8 {
                let next = crate::utils::race(render_loop.next(), async {
                    futures_timer::Delay::new(Duration::from_millis(100)).await;
                    None
                })
                .await;
                if next.is_none() {
                    break;
                }
            }
        });

        assert_eq!(
            results.lock().expect("results mutex").as_slice(),
            &[MCPServerMultiselectResult {
                approved_servers: vec!["git".to_string()],
                rejected_servers: vec!["fs".to_string()],
            }]
        );
        assert_eq!(*done.lock().expect("done mutex"), 1);
    }

    #[test]
    fn mcp_server_multiselect_escape_rejects_all_like_official_cancel() {
        let results = Arc::new(Mutex::new(Vec::<MCPServerMultiselectResult>::new()));
        let results_for_handler = Arc::clone(&results);

        futures::executor::block_on(async move {
            let mut app = element! {
                ContextProvider(value: Context::owned(
                    crate::keybindings::keybinding_context::KeybindingRuntime::with_default_bindings()
                )) {
                    ContextProvider(value: Context::owned(*theme::current())) {
                        MCPServerMultiselectDialog(
                            server_names: vec!["fs".to_string(), "git".to_string()],
                            on_submit: move |result| results_for_handler.lock().expect("results mutex").push(result),
                        )
                    }
                }
            };
            let mut render_loop = Box::pin(
                app.mock_terminal_render_loop(
                    MockTerminalConfig::with_events(stream::iter(vec![key(KeyCode::Esc)]))
                        .with_size(120, 24),
                ),
            );
            for _ in 0..8 {
                let next = crate::utils::race(render_loop.next(), async {
                    futures_timer::Delay::new(Duration::from_millis(100)).await;
                    None
                })
                .await;
                if next.is_none() {
                    break;
                }
            }
        });

        assert_eq!(
            results.lock().expect("results mutex").as_slice(),
            &[MCPServerMultiselectResult {
                approved_servers: Vec::new(),
                rejected_servers: vec!["fs".to_string(), "git".to_string()],
            }]
        );
    }
}
