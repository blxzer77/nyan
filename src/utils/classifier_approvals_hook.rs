//! Maps to: CC `utils/classifierApprovalsHook.ts`.
//!
//! Official Claude Code exposes a tiny React hook around the pure
//! `classifierApprovals` external store. Nyan's iocraft rendering does not
//! have React's `useSyncExternalStore`; this boundary preserves the official
//! file/function split and reads the same process-wide checking store on each
//! render.

use iocraft::prelude::Hooks;

/// Maps to CC `useIsClassifierChecking(toolUseID)`.
pub fn use_is_classifier_checking(_hooks: &Hooks, tool_use_id: &str) -> bool {
    crate::utils::classifier_approvals::is_classifier_checking(tool_use_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::classifier_approvals::{
        clear_classifier_approvals, clear_classifier_checking, set_classifier_checking,
    };

    #[test]
    fn is_classifier_checking_snapshot_tracks_official_store() {
        clear_classifier_approvals();
        set_classifier_checking("toolu_check");
        assert!(crate::utils::classifier_approvals::is_classifier_checking(
            "toolu_check"
        ));
        clear_classifier_checking("toolu_check");
        assert!(!crate::utils::classifier_approvals::is_classifier_checking(
            "toolu_check"
        ));
    }

    #[test]
    fn hook_function_has_official_signature_boundary() {
        let _: fn(&Hooks, &str) -> bool = use_is_classifier_checking;
    }
}
