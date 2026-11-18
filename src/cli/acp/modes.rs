//! Permission modes as ACP session modes.
//!
//! A session offers `default`, `acceptEdits` and `plan`, plus the mode the host's
//! settings start in when it is another one (such as `bypassPermissions`). So a client
//! can never switch a session into a mode the host did not choose itself.
//!
//! A switch takes effect at the start of the next prompt turn, because the engine applies
//! a new permission mode when a query starts.

use std::sync::{Arc, Mutex, MutexGuard};

use agent_client_protocol_schema::v1::{SessionMode, SessionModeState};

use crate::types::permissions::PermissionMode;
use crate::utils::permissions::permission_mode::{
    external_permission_mode_from_string, to_external_permission_mode,
};

/// Modes every session offers, as (id, name, description).
const BASE_MODES: [(&str, &str, &str); 3] = [
    (
        "default",
        "Default",
        "Ask before editing files or running commands",
    ),
    (
        "acceptEdits",
        "Accept edits",
        "Edit files without asking; ask for commands",
    ),
    ("plan", "Plan", "Explore and plan only; make no changes"),
];

/// Names for modes that are offered only when the host starts in them.
fn extra_mode(id: &str) -> Option<(&'static str, &'static str)> {
    match id {
        "bypassPermissions" => Some(("Bypass permissions", "Run every tool without asking")),
        "dontAsk" => Some(("Don't ask", "Deny anything that would need asking")),
        _ => None,
    }
}

/// A session's modes: what it offers, which one is current, and a switch the next
/// prompt turn still has to apply.
pub(super) struct Modes {
    available: Vec<SessionMode>,
    current: String,
    pending: Option<PermissionMode>,
}

/// Shared between the session and the switch handle the server calls.
pub(super) type SharedModes = Arc<Mutex<Modes>>;

impl Modes {
    /// The modes for a session whose settings start in `default_mode` (the
    /// `permissions.defaultMode` setting). An unknown or missing setting starts in
    /// `default`.
    pub(super) fn new(default_mode: Option<&str>) -> Self {
        let start = default_mode
            .and_then(external_permission_mode_from_string)
            .map(to_external_permission_mode)
            .unwrap_or("default");
        let mut available: Vec<SessionMode> = BASE_MODES
            .iter()
            .map(|(id, name, description)| {
                SessionMode::new(*id, *name).description(description.to_string())
            })
            .collect();
        if let Some((name, description)) = extra_mode(start) {
            available.push(SessionMode::new(start, name).description(description.to_string()));
        }
        Self {
            available,
            current: start.to_string(),
            pending: None,
        }
    }

    /// The modes as the `session/new` response reports them.
    pub(super) fn state(&self) -> SessionModeState {
        SessionModeState::new(self.current.clone(), self.available.clone())
    }

    /// Makes `id` the current mode, for the next prompt turn to apply. Fails for a mode
    /// the session does not offer.
    pub(super) fn switch(&mut self, id: &str) -> Result<(), String> {
        if !self.available.iter().any(|mode| &*mode.id.0 == id) {
            return Err(format!("Unknown mode: {id}"));
        }
        let mode = external_permission_mode_from_string(id)
            .ok_or_else(|| format!("Unknown mode: {id}"))?;
        self.current = id.to_string();
        self.pending = Some(mode);
        Ok(())
    }

    /// The switch the next prompt turn has to apply, if any.
    pub(super) fn take_pending(&mut self) -> Option<PermissionMode> {
        self.pending.take()
    }

    /// Records a mode the engine moved to by itself (leaving plan mode, say). Returns
    /// the new mode id when it differs from the current one and the session offers it.
    /// A switch the client asked for and the next turn has not applied yet wins.
    pub(super) fn follow_engine(&mut self, mode: PermissionMode) -> Option<&str> {
        if self.pending.is_some() {
            return None;
        }
        let id = to_external_permission_mode(mode);
        if id == self.current || !self.available.iter().any(|offered| &*offered.id.0 == id) {
            return None;
        }
        self.current = id.to_string();
        Some(&self.current)
    }
}

/// Locks the modes, recovering from a poisoned lock.
pub(super) fn lock_modes(modes: &SharedModes) -> MutexGuard<'_, Modes> {
    modes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(modes: &Modes) -> Vec<String> {
        modes
            .state()
            .available_modes
            .iter()
            .map(|mode| mode.id.0.to_string())
            .collect()
    }

    #[test]
    fn acp_modes_offer_the_base_modes_and_the_host_start_mode() {
        let modes = Modes::new(None);
        assert_eq!(ids(&modes), ["default", "acceptEdits", "plan"]);
        assert_eq!(&*modes.state().current_mode_id.0, "default");

        let modes = Modes::new(Some("acceptEdits"));
        assert_eq!(ids(&modes), ["default", "acceptEdits", "plan"]);
        assert_eq!(&*modes.state().current_mode_id.0, "acceptEdits");

        let modes = Modes::new(Some("bypassPermissions"));
        assert_eq!(
            ids(&modes),
            ["default", "acceptEdits", "plan", "bypassPermissions"]
        );
        assert_eq!(&*modes.state().current_mode_id.0, "bypassPermissions");

        // `auto` is internal, so it is not an external mode and starts as default.
        assert_eq!(
            &*Modes::new(Some("auto")).state().current_mode_id.0,
            "default"
        );
        assert_eq!(
            &*Modes::new(Some("nonsense")).state().current_mode_id.0,
            "default"
        );
    }

    #[test]
    fn acp_modes_switch_only_to_offered_modes() {
        let mut modes = Modes::new(None);
        assert!(modes.take_pending().is_none());

        modes.switch("plan").unwrap();
        assert_eq!(&*modes.state().current_mode_id.0, "plan");
        assert_eq!(modes.take_pending(), Some(PermissionMode::Plan));
        assert!(modes.take_pending().is_none());

        // Not offered, so a client cannot reach it.
        assert!(modes.switch("bypassPermissions").is_err());
        assert!(modes.switch("auto").is_err());
        assert_eq!(&*modes.state().current_mode_id.0, "plan");
        assert!(modes.take_pending().is_none());
    }

    #[test]
    fn acp_modes_follow_the_engine_unless_a_switch_waits() {
        let mut modes = Modes::new(Some("plan"));
        // The engine leaving plan mode (ExitPlanMode) is reported.
        assert_eq!(
            modes.follow_engine(PermissionMode::AcceptEdits),
            Some("acceptEdits")
        );
        assert_eq!(&*modes.state().current_mode_id.0, "acceptEdits");
        // No change, nothing to report.
        assert_eq!(modes.follow_engine(PermissionMode::AcceptEdits), None);
        // Internal auto shows as default.
        assert_eq!(modes.follow_engine(PermissionMode::Auto), Some("default"));
        // A mode the session does not offer is not adopted.
        assert_eq!(modes.follow_engine(PermissionMode::BypassPermissions), None);
        assert_eq!(&*modes.state().current_mode_id.0, "default");
        // A switch the client asked for wins until the next turn applies it.
        modes.switch("plan").unwrap();
        assert_eq!(modes.follow_engine(PermissionMode::Default), None);
        assert_eq!(&*modes.state().current_mode_id.0, "plan");
    }
}
