//! Maps to: CC `components/PackageManagerAutoUpdater.tsx`.
//!
//! Package-manager auto-updater child. Slice 3b: this component owns its own
//! display state (`updateAvailable`, `packageManager`) and its own check loop
//! (mount check + 30-minute interval), exactly like CC (`:30-89`). Like CC it
//! never updates anything itself — it only surfaces the upgrade command. The
//! GCS version fetch is short-circuited in [`crate::utils::auto_updater`];
//! package-manager detection is the `NYAN_PACKAGE_MANAGER` env seam in
//! [`crate::utils::native_installer::package_managers`].

use crate::utils::auto_updater::{
    AutoUpdaterResult, CHECK_INTERVAL, check_for_package_manager_updates, current_version,
};
use crate::utils::native_installer::package_managers::PackageManager;
use crate::utils::theme::Theme;
use iocraft::prelude::*;

/// Maps to: CC `PackageManagerAutoUpdater.tsx:20-27` Props — exactly the six
/// CC fields (identical shape for all three updater children); CC destructures
/// only `verbose` (`:29`), the rest are accepted and unused.
#[derive(Default, Props)]
pub struct PackageManagerAutoUpdaterProps {
    /// Maps to: CC `isUpdating` (accepted, unused — CC `:29`).
    pub is_updating: bool,
    /// Maps to: CC `onChangeIsUpdating` (accepted, unused — CC `:29`).
    pub on_change_is_updating: Handler<bool>,
    /// Maps to: CC `onAutoUpdaterResult` (accepted, unused — CC `:29`).
    pub on_auto_updater_result: Handler<AutoUpdaterResult>,
    /// Maps to: CC `autoUpdaterResult` (accepted, unused — CC `:29`).
    pub auto_updater_result: Option<AutoUpdaterResult>,
    /// Maps to: CC `showSuccessMessage` (accepted, unused — CC `:29`).
    pub show_success_message: bool,
    pub verbose: bool,
}

/// Maps to: CC `PackageManagerAutoUpdater.tsx:95-105` — pacman, deb, and rpm
/// (and the version managers) don't get specific commands because each format
/// has multiple frontends.
pub fn package_manager_update_command(package_manager: PackageManager) -> &'static str {
    match package_manager {
        PackageManager::Homebrew => "brew upgrade claude-code",
        PackageManager::Winget => "winget upgrade Anthropic.ClaudeCode",
        PackageManager::Apk => "apk upgrade claude-code",
        _ => "your package manager update command",
    }
}

#[component]
pub fn PackageManagerAutoUpdater(
    props: &PackageManagerAutoUpdaterProps,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    // Maps to: CC PackageManagerAutoUpdater.tsx:30-32 `updateAvailable` /
    // `packageManager` — component-local state written only by this child's
    // check loop.
    let update_available = hooks.use_state(|| false);
    let package_manager = hooks.use_state(PackageManager::default);

    // Maps to: CC PackageManagerAutoUpdater.tsx:34-81 `checkForUpdates` +
    // initial-check effect (:83-86) + `useInterval(30m)` (:88-89) — this child
    // owns its own check loop (slice-3b split).
    // Skipped in unit tests so canvases stay deterministic.
    hooks.use_future({
        let mut update_available = update_available;
        let mut package_manager = package_manager;
        async move {
            if cfg!(test) {
                return;
            }
            loop {
                if let Some(outcome) = check_for_package_manager_updates().await {
                    // Maps to: CC :50 `setPackageManager(pm)` — committed
                    // before `setUpdateAvailable` (:65/:74), including on the
                    // max-version capped-skip path.
                    package_manager.set(outcome.package_manager);
                    update_available.set(outcome.update_available);
                }
                futures_timer::Delay::new(CHECK_INTERVAL).await;
            }
        }
    });

    // Maps to: CC :91-93.
    if !update_available.get() {
        return element! { View(width: 0u32, height: 0u32) };
    }

    let update_command = package_manager_update_command(package_manager.get());

    element! {
        View(flex_direction: FlexDirection::Row, column_gap: 1u32) {
            #(if props.verbose {
                Some(element! {
                    // Maps to: CC :109-113 — renders MACRO.VERSION inline.
                    Text(
                        content: format!("currentVersion: {}", current_version()),
                        color: theme.inactive,
                        dim: true,
                        wrap: TextWrap::Truncate,
                    )
                })
            } else {
                None
            })
            View(flex_direction: FlexDirection::Row) {
                Text(content: "Update available! Run: ".to_string(), color: theme.warning, wrap: TextWrap::Truncate)
                Text(content: update_command.to_string(), color: theme.warning, weight: Weight::Bold, wrap: TextWrap::Truncate)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    #[test]
    fn package_manager_update_commands_match_official_component() {
        assert_eq!(
            package_manager_update_command(PackageManager::Homebrew),
            "brew upgrade claude-code"
        );
        assert_eq!(
            package_manager_update_command(PackageManager::Winget),
            "winget upgrade Anthropic.ClaudeCode"
        );
        assert_eq!(
            package_manager_update_command(PackageManager::Apk),
            "apk upgrade claude-code"
        );
        // CC :95-105 fallthrough — multi-frontend formats get the generic hint.
        assert_eq!(
            package_manager_update_command(PackageManager::Pacman),
            "your package manager update command"
        );
        assert_eq!(
            package_manager_update_command(PackageManager::Deb),
            "your package manager update command"
        );
        assert_eq!(
            package_manager_update_command(PackageManager::Rpm),
            "your package manager update command"
        );
        assert_eq!(
            package_manager_update_command(PackageManager::Unknown),
            "your package manager update command"
        );
    }

    /// Maps to: CC :91-93 — with `updateAvailable` at its initial `false`
    /// (child-local state; the check loop is test-skipped), nothing renders.
    /// The visible copy is pinned by `package_manager_update_commands…` above;
    /// `updateAvailable == true` is unreachable without a real GCS version
    /// source (`get_latest_version_from_gcs` is short-circuited to `None`).
    #[test]
    fn package_manager_auto_updater_renders_nothing_without_update() {
        let hidden = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                PackageManagerAutoUpdater(verbose: true)
            }
        }
        .render(Some(140))
        .to_string();
        assert!(!hidden.contains("Update available!"), "canvas=\n{hidden}");
        assert!(hidden.trim().is_empty(), "canvas=\n{hidden}");
    }
}
