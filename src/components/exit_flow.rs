//! Maps to: CC `components/ExitFlow.tsx`.
//!
//! Safety boundary: official `ExitFlow` calls `gracefulShutdown(0,
//! 'prompt_input_exit')` after invoking `onDone`. nyan preserves the
//! WorktreeExitDialog delegation, goodbye fallback, and callback shape, but it
//! never exits the process. The App/REPL exit runtime must perform actual
//! shutdown when that slice is explicitly allowed.

use crate::components::worktree_exit_dialog::{WorktreeExitDialog, WorktreeExitStatus};
use crate::utils::worktree::{CommandResultDisplay, WorktreeExitDone, WorktreeSession};
use iocraft::prelude::*;

pub const GOODBYE_MESSAGES: &[&str] = &["Goodbye!", "See ya!", "Bye!", "Catch you later!"];

/// Maps to: CC `getRandomGoodbyeMessage()` — `sample(GOODBYE_MESSAGES) ??
/// 'Goodbye!'`. Uniform pick without a rand dependency: UUIDv4 bytes are
/// cryptographically random and already in the tree.
pub fn random_goodbye_message() -> &'static str {
    let roll = uuid::Uuid::new_v4().as_bytes()[0] as usize;
    GOODBYE_MESSAGES[roll % GOODBYE_MESSAGES.len()]
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExitFlowDone {
    pub message: Option<String>,
    pub display: Option<CommandResultDisplay>,
    /// True when official code would have called `gracefulShutdown`.
    pub would_shutdown: bool,
}

#[derive(Default, Props)]
pub struct ExitFlowProps<'a> {
    pub on_done: HandlerMut<'a, ExitFlowDone>,
    pub on_cancel: HandlerMut<'a, ()>,
    pub show_worktree: bool,
    /// Snapshot consumed by the safe WorktreeExitDialog port. Official
    /// `WorktreeExitDialog` reads this from `getCurrentWorktreeSession()`.
    pub worktree_session: Option<WorktreeSession>,
    pub worktree_status: WorktreeExitStatus,
    pub worktree_changes: Vec<String>,
    pub worktree_commit_count: usize,
}

pub fn exit_flow_result_message(result_message: Option<String>) -> String {
    result_message.unwrap_or_else(|| random_goodbye_message().to_string())
}

/// Maps to: CC `components/ExitFlow.tsx` `ExitFlow`.
#[component]
pub fn ExitFlow<'a>(
    props: &mut ExitFlowProps<'a>,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let mut reported_plain_exit = hooks.use_state(|| false);
    let mut pending_done = hooks.use_state(|| Option::<ExitFlowDone>::None);
    let mut pending_cancel = hooks.use_state(|| false);

    let pending = { pending_done.read().clone() };
    if let Some(done) = pending {
        pending_done.set(None);
        (props.on_done)(done);
    }
    if pending_cancel.get() {
        pending_cancel.set(false);
        (props.on_cancel)(());
    }

    if props.show_worktree {
        let mut pending_done_for_dialog = pending_done;
        let mut pending_cancel_for_dialog = pending_cancel;
        return element! {
            WorktreeExitDialog(
                on_done: move |done: WorktreeExitDone| {
                    pending_done_for_dialog.set(Some(ExitFlowDone {
                        message: Some(exit_flow_result_message(done.result)),
                        display: done.display,
                        would_shutdown: true,
                    }));
                },
                on_cancel: move |_| pending_cancel_for_dialog.set(true),
                session: props.worktree_session.clone(),
                status: props.worktree_status,
                changes: props.worktree_changes.clone(),
                commit_count: props.worktree_commit_count,
            )
        }
        .into_any();
    }

    if !reported_plain_exit.get() {
        reported_plain_exit.set(true);
        (props.on_done)(ExitFlowDone {
            message: Some(random_goodbye_message().to_string()),
            display: None,
            would_shutdown: true,
        });
    }

    element! { View {} }.into_any()
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

    fn session() -> WorktreeSession {
        WorktreeSession {
            original_cwd: "/repo".to_string(),
            worktree_path: "/repo-feature".to_string(),
            worktree_name: "feature".to_string(),
            worktree_branch: Some("nyan/feature".to_string()),
            original_branch: Some("main".to_string()),
            original_head_commit: Some("abc123".to_string()),
            session_id: "session-1".to_string(),
            tmux_session_name: None,
            hook_based: None,
            creation_duration_ms: None,
            used_sparse_paths: None,
        }
    }

    #[test]
    fn exit_flow_goodbye_fallback_matches_official_message_set_without_shutdown() {
        // CC samples uniformly from GOODBYE_MESSAGES; assert set membership.
        assert!(GOODBYE_MESSAGES.contains(&random_goodbye_message()));
        assert!(GOODBYE_MESSAGES.contains(&"Catch you later!"));
        assert!(GOODBYE_MESSAGES.contains(&exit_flow_result_message(None).as_str()));
        assert_eq!(exit_flow_result_message(Some("done".to_string())), "done");
    }

    #[test]
    fn exit_flow_plain_exit_reports_done_callback_without_process_exit() {
        let results = Arc::new(Mutex::new(Vec::<ExitFlowDone>::new()));
        let results_for_handler = results.clone();

        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                ExitFlow(
                    show_worktree: false,
                    on_done: move |done: ExitFlowDone| results_for_handler.lock().unwrap().push(done),
                )
            }
        }
        .render(Some(80))
        .to_string();

        assert!(text.trim().is_empty(), "canvas=\n{text}");
        let results = results.lock().unwrap();
        assert_eq!(results.len(), 1);
        let done = &results[0];
        assert!(GOODBYE_MESSAGES.contains(&done.message.as_deref().expect("goodbye message")));
        assert_eq!(done.display, None);
        assert!(done.would_shutdown);
    }

    #[test]
    fn exit_flow_delegates_worktree_selection_and_preserves_result_message() {
        let results = Arc::new(Mutex::new(Vec::<ExitFlowDone>::new()));
        let results_for_handler = results.clone();

        futures::executor::block_on(async move {
            let mut app = element! {
                ContextProvider(value: Context::owned(*theme::current())) {
                    ExitFlow(
                        show_worktree: true,
                        worktree_session: Some(session()),
                        worktree_status: WorktreeExitStatus::Asking,
                        worktree_changes: vec!["M src/main.rs".to_string()],
                        worktree_commit_count: 0usize,
                        on_done: move |done: ExitFlowDone| results_for_handler.lock().unwrap().push(done),
                    )
                }
            };
            let mut render_loop = Box::pin(
                app.mock_terminal_render_loop(
                    MockTerminalConfig::with_events(stream::iter(vec![key(KeyCode::Enter)]))
                        .with_size(120, 30),
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

        let captured = results.lock().unwrap().clone();
        assert_eq!(captured.len(), 1);
        assert!(
            captured[0]
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("Worktree kept"),
            "captured={captured:?}"
        );
        assert!(captured[0].would_shutdown);
    }
}
