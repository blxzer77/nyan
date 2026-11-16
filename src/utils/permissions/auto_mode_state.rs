//! Maps to: CC `utils/permissions/autoModeState.ts`.
//!
//! Mutable process-wide auto-mode flags live in this module so classifier
//! callers can share the same state boundary as Claude Code. This module only
//! stores flags; gate checks and permission-context mutation remain in
//! `permission_setup` / `bypass_permissions_killswitch` slices.

use std::sync::atomic::{AtomicBool, Ordering};

static AUTO_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);
static AUTO_MODE_FLAG_CLI: AtomicBool = AtomicBool::new(false);
static AUTO_MODE_CIRCUIT_BROKEN: AtomicBool = AtomicBool::new(false);

/// Maps to: CC `setAutoModeActive(active)`.
pub fn set_auto_mode_active(active: bool) {
    AUTO_MODE_ACTIVE.store(active, Ordering::SeqCst);
}

/// Maps to: CC `isAutoModeActive()`.
pub fn is_auto_mode_active() -> bool {
    AUTO_MODE_ACTIVE.load(Ordering::SeqCst)
}

/// Maps to: CC `setAutoModeFlagCli(passed)`.
pub fn set_auto_mode_flag_cli(passed: bool) {
    AUTO_MODE_FLAG_CLI.store(passed, Ordering::SeqCst);
}

/// Maps to: CC `getAutoModeFlagCli()`.
pub fn get_auto_mode_flag_cli() -> bool {
    AUTO_MODE_FLAG_CLI.load(Ordering::SeqCst)
}

/// Maps to: CC `setAutoModeCircuitBroken(broken)`.
pub fn set_auto_mode_circuit_broken(broken: bool) {
    AUTO_MODE_CIRCUIT_BROKEN.store(broken, Ordering::SeqCst);
}

/// Maps to: CC `isAutoModeCircuitBroken()`.
pub fn is_auto_mode_circuit_broken() -> bool {
    AUTO_MODE_CIRCUIT_BROKEN.load(Ordering::SeqCst)
}

/// Maps to: CC `_resetForTesting()`.
pub fn reset_for_testing() {
    set_auto_mode_active(false);
    set_auto_mode_flag_cli(false);
    set_auto_mode_circuit_broken(false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_mode_state_round_trips_each_flag_and_resets() {
        let _lock = crate::utils::test_env::TEST_ENV_LOCK.lock().unwrap();
        reset_for_testing();
        assert!(!is_auto_mode_active());
        assert!(!get_auto_mode_flag_cli());
        assert!(!is_auto_mode_circuit_broken());

        set_auto_mode_active(true);
        set_auto_mode_flag_cli(true);
        set_auto_mode_circuit_broken(true);
        assert!(is_auto_mode_active());
        assert!(get_auto_mode_flag_cli());
        assert!(is_auto_mode_circuit_broken());

        reset_for_testing();
        assert!(!is_auto_mode_active());
        assert!(!get_auto_mode_flag_cli());
        assert!(!is_auto_mode_circuit_broken());
    }
}
