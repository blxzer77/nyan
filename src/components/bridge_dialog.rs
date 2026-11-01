//! Maps to: CC `components/BridgeDialog.tsx`.
//!
//! Safety boundary: the official dialog subscribes to AppState, registers an
//! overlay, reads git/original cwd, generates QR text via `qrcode`, persists an
//! explicit disconnect opt-out with `saveGlobalConfig`, and mutates bridge app
//! state. nyan keeps the visible dialog/status/footer/key paths from an
//! explicit snapshot. Disconnect and close are callback-only; config writes,
//! bridge transport mutation, overlay registration, and QR generation are
//! deferred to their dedicated runtime slices.

use crate::bridge::bridge_status_util::{
    BridgeStatusColor, FAILED_FOOTER_TEXT, bridge_error_present, build_active_footer_text,
    build_idle_footer_text, get_bridge_status,
};
use crate::components::design_system::dialog::Dialog;
use crate::constants::figures::{BRIDGE_FAILED_INDICATOR, BRIDGE_READY_INDICATOR};
use crate::utils::theme::Theme;
use iocraft::prelude::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BridgeDialogSnapshot {
    pub connected: bool,
    pub session_active: bool,
    pub reconnecting: bool,
    pub connect_url: Option<String>,
    pub session_url: Option<String>,
    pub error: Option<String>,
    pub explicit: bool,
    pub environment_id: Option<String>,
    pub session_id: Option<String>,
    pub verbose: bool,
    /// Already-known `basename(getOriginalCwd())`.
    pub repo_name: Option<String>,
    /// Already-known result of official `getBranch()`.
    pub branch_name: Option<String>,
}

#[derive(Default, Props)]
pub struct BridgeDialogProps<'a> {
    pub on_done: HandlerMut<'a, ()>,
    pub on_disconnect: HandlerMut<'a, bool>,
    pub snapshot: BridgeDialogSnapshot,
    pub show_qr_initial: bool,
    /// Pre-rendered UTF-8 QR text. Official computes this from `displayUrl`
    /// with `qrcode.toString`; nyan takes it as a pure snapshot input.
    pub qr_text: Option<String>,
}

/// Maps to: CC `components/BridgeDialog.tsx` context suffix construction.
pub fn bridge_context_suffix(repo_name: Option<&str>, branch_name: Option<&str>) -> String {
    let mut parts = Vec::new();
    if let Some(repo_name) = repo_name.filter(|value| !value.is_empty()) {
        parts.push(repo_name);
    }
    if let Some(branch_name) = branch_name.filter(|value| !value.is_empty()) {
        parts.push(branch_name);
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" · {}", parts.join(" · "))
    }
}

/// Maps to: CC `components/BridgeDialog.tsx` `displayUrl` selection.
pub fn bridge_display_url(snapshot: &BridgeDialogSnapshot) -> Option<String> {
    if snapshot.session_active {
        snapshot.session_url.clone()
    } else {
        snapshot.connect_url.clone()
    }
}

/// Maps to: CC `components/BridgeDialog.tsx` footer construction.
pub fn bridge_footer_text(snapshot: &BridgeDialogSnapshot) -> Option<String> {
    if bridge_error_present(snapshot.error.as_deref()) {
        Some(FAILED_FOOTER_TEXT.to_string())
    } else {
        bridge_display_url(snapshot).map(|url| {
            if snapshot.session_active {
                build_active_footer_text(&url)
            } else {
                build_idle_footer_text(&url)
            }
        })
    }
}

fn bridge_status_color_to_theme(color: BridgeStatusColor, theme: &Theme) -> Color {
    match color {
        BridgeStatusColor::Error => theme.error,
        BridgeStatusColor::Warning => theme.warning,
        BridgeStatusColor::Success => theme.success,
    }
}

fn non_empty_qr_lines(qr_text: Option<&str>) -> Vec<String> {
    qr_text
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// Maps to: CC `components/BridgeDialog.tsx` `BridgeDialog`.
#[component]
pub fn BridgeDialog<'a>(
    props: &mut BridgeDialogProps<'a>,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let show_qr_initial = props.show_qr_initial;
    let mut show_qr = hooks.use_state(move || show_qr_initial);
    let mut pending_done = hooks.use_state(|| false);
    let mut pending_disconnect = hooks.use_state(|| false);
    let runtime = hooks
        .try_use_context::<crate::keybindings::keybinding_context::KeybindingRuntime>()
        .map(|runtime| runtime.clone());
    crate::keybindings::use_keybinding::use_keybinding(
        &mut hooks,
        runtime.clone(),
        "confirm:yes",
        crate::keybindings::types::ContextName::Confirmation,
        || true,
        move || {
            pending_done.set(true);
            true
        },
    );
    crate::keybindings::use_keybinding::use_keybinding(
        &mut hooks,
        runtime,
        "confirm:toggle",
        crate::keybindings::types::ContextName::Confirmation,
        || true,
        move || {
            show_qr.set(!show_qr.get());
            true
        },
    );

    // Maps to: CC BridgeDialog's intentionally raw `d` disconnect key.
    hooks.use_propagated_terminal_events({
        let mut pending_done = pending_done;
        let mut pending_disconnect = pending_disconnect;
        move |event| {
            let TerminalEvent::Key(KeyEvent { code, kind, .. }) = event.event() else {
                return;
            };
            if *kind == KeyEventKind::Release {
                return;
            }
            if code == &KeyCode::Char('d') {
                pending_disconnect.set(true);
                pending_done.set(true);
                event.stop_propagation();
            }
        }
    });

    if pending_disconnect.get() {
        pending_disconnect.set(false);
        (props.on_disconnect)(props.snapshot.explicit);
    }
    if pending_done.get() {
        pending_done.set(false);
        (props.on_done)(());
    }

    let status = get_bridge_status(
        props.snapshot.error.as_deref(),
        props.snapshot.connected,
        props.snapshot.session_active,
        props.snapshot.reconnecting,
    );
    let has_error = bridge_error_present(props.snapshot.error.as_deref());
    let indicator = if has_error {
        BRIDGE_FAILED_INDICATOR
    } else {
        BRIDGE_READY_INDICATOR
    };
    let status_text = format!("{indicator} {}", status.label);
    let status_color = bridge_status_color_to_theme(status.color, &theme);
    let context_suffix = bridge_context_suffix(
        props.snapshot.repo_name.as_deref(),
        props.snapshot.branch_name.as_deref(),
    );
    let footer_text = bridge_footer_text(&props.snapshot);
    let show_qr_now = show_qr.get() && bridge_display_url(&props.snapshot).is_some();
    let qr_lines = if show_qr_now {
        non_empty_qr_lines(props.qr_text.as_deref())
    } else {
        Vec::new()
    };

    element! {
        Dialog(
            title: "Remote Control".to_string(),
            hide_input_guide: true,
            on_cancel: move |_| pending_done.set(true),
        ) {
            View(flex_direction: FlexDirection::Column, gap: 1u32) {
                View(flex_direction: FlexDirection::Column) {
                    View(flex_direction: FlexDirection::Row) {
                        Text(content: status_text, color: status_color, wrap: TextWrap::NoWrap)
                        Text(content: context_suffix, dim: true, wrap: TextWrap::NoWrap)
                    }
                    #(props.snapshot.error.clone().filter(|error| !error.is_empty()).map(|error| element! {
                        Text(content: error, color: theme.error, wrap: TextWrap::NoWrap)
                    }))
                    #(props.snapshot.verbose.then(|| props.snapshot.environment_id.clone()).flatten().map(|environment_id| element! {
                        Text(content: format!("Environment: {environment_id}"), dim: true, wrap: TextWrap::NoWrap)
                    }))
                    #(props.snapshot.verbose.then(|| props.snapshot.session_id.clone()).flatten().map(|session_id| element! {
                        Text(content: format!("Session: {session_id}"), dim: true, wrap: TextWrap::NoWrap)
                    }))
                }
                #(if !qr_lines.is_empty() {
                    Some(element! {
                        View(flex_direction: FlexDirection::Column) {
                            #(qr_lines.into_iter().map(|line| element! {
                                Text(content: line, wrap: TextWrap::NoWrap)
                            }).collect::<Vec<_>>())
                        }
                    })
                } else {
                    None
                })
                #(footer_text.map(|footer_text| element! {
                    Text(content: footer_text, dim: true, wrap: TextWrap::NoWrap)
                }))
                Text(
                    content: "d to disconnect · space for QR code · Enter/Esc to close".to_string(),
                    dim: true,
                    wrap: TextWrap::NoWrap,
                )
            }
        }
    }
    .into_any()
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

    fn active_snapshot() -> BridgeDialogSnapshot {
        BridgeDialogSnapshot {
            connected: true,
            session_active: true,
            reconnecting: false,
            connect_url: Some("https://claude.ai/code?bridge=env_123".to_string()),
            session_url: Some("https://claude.ai/code/session_abc?bridge=env_123".to_string()),
            error: None,
            explicit: true,
            environment_id: Some("env_123".to_string()),
            session_id: Some("session_abc".to_string()),
            verbose: true,
            repo_name: Some("nyan".to_string()),
            branch_name: Some("main".to_string()),
        }
    }

    #[test]
    fn bridge_dialog_renders_active_verbose_status_footer_and_shortcuts() {
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                BridgeDialog(snapshot: active_snapshot())
            }
        }
        .render(Some(160))
        .to_string();

        assert!(text.contains("Remote Control"), "canvas=\n{text}");
        assert!(
            text.contains("·✔︎· Remote Control active"),
            "canvas=\n{text}"
        );
        assert!(text.contains("· nyan · main"), "canvas=\n{text}");
        assert!(text.contains("Environment: env_123"), "canvas=\n{text}");
        assert!(text.contains("Session: session_abc"), "canvas=\n{text}");
        assert!(
            text.contains("Continue coding in the Claude app or https://claude.ai/code/session_abc?bridge=env_123"),
            "canvas=\n{text}"
        );
        assert!(
            text.contains("d to disconnect · space for QR code · Enter/Esc to close"),
            "canvas=\n{text}"
        );
    }

    #[test]
    fn bridge_dialog_renders_failed_status_and_error_footer() {
        let snapshot = BridgeDialogSnapshot {
            error: Some("bridge transport failed".to_string()),
            repo_name: Some("repo".to_string()),
            ..BridgeDialogSnapshot::default()
        };
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                BridgeDialog(snapshot: snapshot)
            }
        }
        .render(Some(120))
        .to_string();

        assert!(text.contains("× Remote Control failed"), "canvas=\n{text}");
        assert!(text.contains("bridge transport failed"), "canvas=\n{text}");
        assert!(
            text.contains("Something went wrong, please try again"),
            "canvas=\n{text}"
        );
    }

    #[test]
    fn bridge_dialog_renders_idle_footer_and_injected_qr_text() {
        let snapshot = BridgeDialogSnapshot {
            connect_url: Some("https://claude.ai/code?bridge=env_123".to_string()),
            repo_name: Some("repo".to_string()),
            ..BridgeDialogSnapshot::default()
        };
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                BridgeDialog(
                    snapshot: snapshot,
                    show_qr_initial: true,
                    qr_text: Some("██\n  \n▀▀".to_string()),
                )
            }
        }
        .render(Some(120))
        .to_string();

        assert!(
            text.contains("Remote Control connecting…"),
            "canvas=\n{text}"
        );
        assert!(
            text.contains(
                "Code everywhere with the Claude app or https://claude.ai/code?bridge=env_123"
            ),
            "canvas=\n{text}"
        );
        assert!(text.contains("██"), "canvas=\n{text}");
        assert!(text.contains("▀▀"), "canvas=\n{text}");
    }

    #[test]
    fn bridge_dialog_helpers_match_official_context_and_display_url_branches() {
        assert_eq!(bridge_context_suffix(None, None), "");
        assert_eq!(bridge_context_suffix(Some("repo"), None), " · repo");
        assert_eq!(
            bridge_context_suffix(Some("repo"), Some("main")),
            " · repo · main"
        );

        let mut snapshot = active_snapshot();
        assert_eq!(
            bridge_display_url(&snapshot),
            Some("https://claude.ai/code/session_abc?bridge=env_123".to_string())
        );
        snapshot.session_active = false;
        assert_eq!(
            bridge_display_url(&snapshot),
            Some("https://claude.ai/code?bridge=env_123".to_string())
        );
    }

    #[test]
    fn bridge_dialog_enter_and_escape_close_via_on_done() {
        for code in [KeyCode::Enter, KeyCode::Esc] {
            let dones = Arc::new(Mutex::new(0usize));
            let dones_for_handler = Arc::clone(&dones);

            futures::executor::block_on(async move {
                let mut app = element! {
                    ContextProvider(value: Context::owned(
                    crate::keybindings::keybinding_context::KeybindingRuntime::with_default_bindings()
                )) {
                        ContextProvider(value: Context::owned(*theme::current())) {
                            BridgeDialog(
                                snapshot: active_snapshot(),
                                on_done: move |_| {
                                    *dones_for_handler.lock().expect("dones mutex") += 1;
                                },
                            )
                        }
                    }
                };
                let mut render_loop = Box::pin(
                    app.mock_terminal_render_loop(
                        MockTerminalConfig::with_events(stream::iter(vec![key(code)]))
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

            assert_eq!(*dones.lock().expect("dones mutex"), 1);
        }
    }

    #[test]
    fn bridge_dialog_disconnect_is_callback_only_and_reports_explicit_flag() {
        let disconnects = Arc::new(Mutex::new(Vec::<bool>::new()));
        let dones = Arc::new(Mutex::new(0usize));
        let disconnects_for_handler = Arc::clone(&disconnects);
        let dones_for_handler = Arc::clone(&dones);

        futures::executor::block_on(async move {
            let mut app = element! {
                ContextProvider(value: Context::owned(*theme::current())) {
                    BridgeDialog(
                        snapshot: active_snapshot(),
                        on_disconnect: move |explicit| {
                            disconnects_for_handler.lock().expect("disconnects mutex").push(explicit);
                        },
                        on_done: move |_| {
                            *dones_for_handler.lock().expect("dones mutex") += 1;
                        },
                    )
                }
            };
            let mut render_loop = Box::pin(
                app.mock_terminal_render_loop(
                    MockTerminalConfig::with_events(stream::iter(vec![key(KeyCode::Char('d'))]))
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
            disconnects.lock().expect("disconnects mutex").as_slice(),
            &[true]
        );
        assert_eq!(*dones.lock().expect("dones mutex"), 1);
    }
}
