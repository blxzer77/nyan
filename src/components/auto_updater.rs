//! Maps to: CC `components/AutoUpdater.tsx`.
//!
//! npm/local JS auto-updater child. Slice 3b: this component owns its own
//! display state (`versions`, `hasLocalInstall`) and its own check loop
//! (mount check + 30-minute interval), exactly like CC (`:46-55`, `:65-216`).
//! Results and the updating flag travel upward through the CC callback props
//! (`onAutoUpdaterResult` → REPL state, `onChangeIsUpdating` → PromptInput
//! state) — never through AppStore. Update network/package-manager IO is
//! short-circuited in [`crate::utils::auto_updater`]; analytics (`logEvent`)
//! are omitted.

use crate::utils::auto_updater::{
    AutoUpdaterResult, CHECK_INTERVAL, OFFICIAL_PACKAGE_URL, check_for_js_updates,
    perform_js_update_install,
};
use crate::utils::local_installer::local_installation_exists;
use crate::utils::theme::Theme;
use iocraft::prelude::*;

/// Maps to: CC `AutoUpdater.tsx:29-36` Props — exactly the six CC fields
/// (identical shape for all three updater children and the wrapper).
#[derive(Default, Props)]
pub struct AutoUpdaterProps {
    /// Maps to: CC `isUpdating` (PromptInput-owned `isAutoUpdating`).
    pub is_updating: bool,
    /// Maps to: CC `onChangeIsUpdating` (PromptInput `setIsAutoUpdating`).
    pub on_change_is_updating: Handler<bool>,
    /// Maps to: CC `onAutoUpdaterResult` (REPL `setAutoUpdaterResult`).
    pub on_auto_updater_result: Handler<AutoUpdaterResult>,
    /// Maps to: CC `autoUpdaterResult` (REPL-owned state).
    pub auto_updater_result: Option<AutoUpdaterResult>,
    pub show_success_message: bool,
    pub verbose: bool,
}

/// Maps to: CC `onChangeIsUpdating(true … false)` bracketing
/// (`AutoUpdater.tsx:112,130,153,170`; `NativeAutoUpdater.tsx:99` +
/// `:165-167` `finally`).
///
/// CC's in-flight `checkForUpdates` promise runs to completion even if the
/// child unmounts, so `finally` always clears the PromptInput-owned flag.
/// iocraft instead drops the child's `use_future` on unmount, which would
/// strand the surviving PromptInput at `is_auto_updating == true`; this guard
/// delivers the `false` from `Drop` when the future is cancelled.
///
/// Representation-only today: every `true` window is yield-free (all update
/// IO in `utils/auto_updater.rs` is short-circuited to immediately-ready
/// futures), so the cancel path cannot fire differently from CC. Recorded
/// seam: once real install IO lands, CC's run-to-completion semantics also
/// need the install itself detached from the component lifetime — the guard
/// clears the flag but cannot finish a cancelled install or emit its result.
pub(crate) struct IsUpdatingClearGuard {
    on_change_is_updating: Handler<bool>,
    armed: bool,
}

impl IsUpdatingClearGuard {
    /// Delivers `on_change_is_updating(true)` and arms the clear-on-drop.
    pub(crate) fn arm(on_change_is_updating: &Handler<bool>) -> Self {
        on_change_is_updating(true);
        Self {
            on_change_is_updating: on_change_is_updating.clone(),
            armed: true,
        }
    }

    /// Normal completion path — delivers `on_change_is_updating(false)` once.
    pub(crate) fn finish(mut self) {
        self.armed = false;
        (self.on_change_is_updating)(false);
    }
}

impl Drop for IsUpdatingClearGuard {
    fn drop(&mut self) {
        if self.armed {
            (self.on_change_is_updating)(false);
        }
    }
}

/// Maps to: CC `AutoUpdater.tsx` failure-hint command (`:255-259`).
pub fn js_auto_update_failure_command(has_local_install: bool) -> String {
    if has_local_install {
        format!("cd ~/.claude/local && npm update {OFFICIAL_PACKAGE_URL}")
    } else {
        format!("npm i -g {OFFICIAL_PACKAGE_URL}")
    }
}

/// Maps to: CC `AutoUpdater.tsx:218-224` render gate.
pub fn auto_updater_should_render(
    result_version_present: bool,
    global_version: Option<&str>,
    latest_version: Option<&str>,
    is_updating: bool,
) -> bool {
    if !result_version_present && (global_version.is_none() || latest_version.is_none()) {
        return false;
    }
    if !result_version_present && !is_updating {
        return false;
    }
    true
}

#[component]
pub fn AutoUpdater(props: &AutoUpdaterProps, mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    // Maps to: CC AutoUpdater.tsx:46-49 `versions` ({global, latest}) —
    // component-local state written only by this child's check loop.
    let versions = hooks.use_state(|| (Option::<String>::None, Option::<String>::None));
    // Maps to: CC AutoUpdater.tsx:50 `hasLocalInstall`.
    let has_local_install = hooks.use_state(|| false);
    // Maps to: CC AutoUpdater.tsx:51 `useUpdateNotification(autoUpdaterResult?.version)`
    // — per-instance lastNotifiedSemver state, called before any early return.
    let update_semver = crate::hooks::use_update_notification::use_update_notification(
        &mut hooks,
        props
            .auto_updater_result
            .as_ref()
            .and_then(|result| result.version.as_deref()),
    );

    // Maps to: CC AutoUpdater.tsx:53-55 mount effect —
    // `localInstallationExists().then(setHasLocalInstall)`: an independent
    // filesystem probe, NOT derived from the installation type (slice-3b fix).
    // Skipped in unit tests so canvases stay deterministic.
    hooks.use_future({
        let mut has_local_install = has_local_install;
        async move {
            if cfg!(test) {
                return;
            }
            has_local_install.set(local_installation_exists());
        }
    });

    // Maps to: CC AutoUpdater.tsx:65-208 `checkForUpdates` + initial-check
    // effect (:211-213) + `useInterval(30m)` (:216) — this child owns its own
    // check loop (slice-3b split). CC's `isUpdatingRef` guard (:57-68) exists
    // because the initial effect and the interval are separate schedulers
    // sharing one memoized closure; this single sequential loop awaits every
    // check to completion before sleeping and is the only production writer of
    // `isAutoUpdating`, so the guard is subsumed by construction.
    // Skipped in unit tests so canvases stay deterministic.
    hooks.use_future({
        let mut versions = versions;
        let on_auto_updater_result = props.on_auto_updater_result.clone();
        let on_change_is_updating = props.on_change_is_updating.clone();
        async move {
            if cfg!(test) {
                return;
            }
            loop {
                if let Some(check) = check_for_js_updates().await {
                    // Maps to: CC :101 `setVersions({global, latest})` —
                    // committed before the install brackets the flag (:112).
                    versions.set((
                        Some(check.global_version.clone()),
                        check.latest_version.clone(),
                    ));
                    if let Some(target) = check.install_target.clone() {
                        // Maps to: CC :112 `onChangeIsUpdating(true)` …
                        // :130/:153/:170 `onChangeIsUpdating(false)` paths.
                        let guard = IsUpdatingClearGuard::arm(&on_change_is_updating);
                        let status = perform_js_update_install(check.channel).await;
                        guard.finish();
                        if let Some(status) = status {
                            // Maps to: CC :198-201 `onAutoUpdaterResult` with the
                            // (max-version-capped) target version.
                            on_auto_updater_result(AutoUpdaterResult {
                                version: Some(target),
                                status,
                                notifications: Vec::new(),
                            });
                        }
                    }
                }
                futures_timer::Delay::new(CHECK_INTERVAL).await;
            }
        }
    });

    let (global_version, latest_version) = versions.read().clone();
    let result_version_present = props
        .auto_updater_result
        .as_ref()
        .and_then(|result| result.version.as_deref())
        .is_some();
    if !auto_updater_should_render(
        result_version_present,
        global_version.as_deref(),
        latest_version.as_deref(),
        props.is_updating,
    ) {
        return element! { View(width: 0u32, height: 0u32) };
    }

    let result_status = props
        .auto_updater_result
        .as_ref()
        .map(|result| result.status);
    // Maps to: CC :243-245 — `updateSemver` is committed-null as executed
    // (see hooks/use_update_notification.rs), so this row never commits; the
    // expression keeps CC's shape.
    let show_success = result_status == Some(crate::utils::auto_updater::InstallStatus::Success)
        && props.show_success_message
        && update_semver.is_some();
    let show_failure = matches!(
        result_status,
        Some(crate::utils::auto_updater::InstallStatus::InstallFailed)
            | Some(crate::utils::auto_updater::InstallStatus::NoPermissions)
    );
    let failure_command = js_auto_update_failure_command(has_local_install.get());

    element! {
        View(flex_direction: FlexDirection::Row, column_gap: 1u32) {
            #(if props.verbose {
                Some(element! {
                    Text(
                        content: format!(
                            "globalVersion: {} · latestVersion: {}",
                            global_version.as_deref().unwrap_or(""),
                            latest_version.as_deref().unwrap_or(""),
                        ),
                        color: theme.inactive,
                        dim: true,
                        wrap: TextWrap::Truncate,
                    )
                })
            } else {
                None
            })
            #(if props.is_updating {
                Some(element! {
                    View {
                        Text(
                            content: "Auto-updating…".to_string(),
                            color: theme.text,
                            dim: true,
                            wrap: TextWrap::Truncate,
                        )
                    }
                }.into_any())
            } else if show_success {
                Some(element! {
                    Text(
                        content: "✓ Update installed · Restart to apply".to_string(),
                        color: theme.success,
                        wrap: TextWrap::Truncate,
                    )
                }.into_any())
            } else {
                None
            })
            #(if show_failure {
                Some(element! {
                    View(flex_direction: FlexDirection::Row) {
                        Text(content: "✗ Auto-update failed · Try ".to_string(), color: theme.error, wrap: TextWrap::Truncate)
                        Text(content: "claude doctor".to_string(), color: theme.error, weight: Weight::Bold, wrap: TextWrap::Truncate)
                        Text(content: " or ".to_string(), color: theme.error, wrap: TextWrap::Truncate)
                        Text(content: failure_command, color: theme.error, weight: Weight::Bold, wrap: TextWrap::Truncate)
                    }
                })
            } else {
                None
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::auto_updater::InstallStatus;
    use crate::utils::theme;
    use std::sync::{Arc, Mutex};

    fn render(props: AutoUpdaterProps) -> String {
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                AutoUpdater(
                    is_updating: props.is_updating,
                    auto_updater_result: props.auto_updater_result,
                    show_success_message: props.show_success_message,
                    verbose: props.verbose,
                )
            }
        }
        .render(Some(160))
        .to_string()
    }

    #[test]
    fn auto_updater_render_gate_matches_official_version_and_updating_checks() {
        assert!(!auto_updater_should_render(false, None, None, false));
        assert!(!auto_updater_should_render(
            false,
            Some("1.0.0"),
            Some("1.1.0"),
            false
        ));
        assert!(auto_updater_should_render(
            false,
            Some("1.0.0"),
            Some("1.1.0"),
            true
        ));
        assert!(auto_updater_should_render(true, None, None, false));
    }

    #[test]
    fn js_auto_update_failure_command_matches_official_variants() {
        assert_eq!(
            js_auto_update_failure_command(true),
            format!("cd ~/.claude/local && npm update {OFFICIAL_PACKAGE_URL}")
        );
        assert_eq!(
            js_auto_update_failure_command(false),
            format!("npm i -g {OFFICIAL_PACKAGE_URL}")
        );
    }

    /// Maps to: CC AutoUpdater.tsx:243-249 as executed — `useUpdateNotification`
    /// committed output is always null (render-phase set + React discard), so
    /// the success copy never commits. Nyan pins the same committed canvas.
    #[test]
    fn auto_updater_success_copy_never_commits_matching_official_render_discard() {
        let success = render(AutoUpdaterProps {
            auto_updater_result: Some(AutoUpdaterResult {
                version: Some("1.1.0".to_string()),
                status: InstallStatus::Success,
                notifications: Vec::new(),
            }),
            show_success_message: true,
            ..AutoUpdaterProps::default()
        });
        assert!(
            !success.contains("✓ Update installed"),
            "canvas=\n{success}"
        );
    }

    #[test]
    fn auto_updater_renders_failure_copy_like_official_component() {
        // hasLocalInstall is child-local state (probe skipped in tests →
        // CC initial `false`), so the global-install command variant renders;
        // the local variant is pinned by the pure command test above.
        let failure = render(AutoUpdaterProps {
            auto_updater_result: Some(AutoUpdaterResult {
                version: Some("1.1.0".to_string()),
                status: InstallStatus::InstallFailed,
                notifications: Vec::new(),
            }),
            ..AutoUpdaterProps::default()
        });
        assert!(
            failure.contains("✗ Auto-update failed · Try claude doctor or npm i -g"),
            "canvas=\n{failure}"
        );
    }

    #[test]
    fn auto_updater_renders_verbose_and_updating_rows() {
        // Gate passes via the result version (child-local versions state stays
        // at its CC initial `{}` in tests — the check loop is test-skipped).
        let text = render(AutoUpdaterProps {
            is_updating: true,
            verbose: true,
            auto_updater_result: Some(AutoUpdaterResult {
                version: Some("1.1.0".to_string()),
                status: InstallStatus::InProgress,
                notifications: Vec::new(),
            }),
            ..AutoUpdaterProps::default()
        });
        assert!(text.contains("globalVersion:"), "canvas=\n{text}");
        assert!(text.contains("Auto-updating…"), "canvas=\n{text}");
    }

    /// 6a ruling: the clear-on-drop guard delivers `false` when the child
    /// future is cancelled mid-install (iocraft unmount drop), matching CC's
    /// promise `finally`; the normal path delivers exactly one `true`/`false`
    /// pair with no double-clear.
    #[test]
    fn is_updating_clear_guard_delivers_false_on_finish_and_on_cancel_drop() {
        let seen: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
        let handler: Handler<bool> = Handler::from({
            let seen = Arc::clone(&seen);
            move |value: bool| seen.lock().unwrap().push(value)
        });

        let guard = IsUpdatingClearGuard::arm(&handler);
        guard.finish();
        assert_eq!(seen.lock().unwrap().as_slice(), &[true, false]);

        seen.lock().unwrap().clear();
        let guard = IsUpdatingClearGuard::arm(&handler);
        drop(guard);
        assert_eq!(seen.lock().unwrap().as_slice(), &[true, false]);
    }
}
