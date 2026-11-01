//! Pure display-state seam for official `utils/classifierApprovals.ts` and
//! `utils/classifierApprovalsHook.ts`.
//!
//! Nyan does not run classifier API calls yet. This module ports the official
//! approval/checking stores so permission/tool execution can record classifier
//! decisions once the live classifier path is enabled, and message renderers can
//! show the official auxiliary row by tool-use id.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

/// Maps to CC `utils/classifierApprovals.ts#ClassifierApproval`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClassifierApproval {
    Bash { matched_rule: String },
    AutoMode { reason: String },
}

static CLASSIFIER_APPROVALS: LazyLock<Mutex<HashMap<String, ClassifierApproval>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CLASSIFIER_CHECKING: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassifierChecking {
    pub tool_use_id: String,
    pub is_auto: bool,
}

/// Maps to CC `setClassifierApproval(toolUseID, matchedRule)`.
pub fn set_classifier_approval(tool_use_id: &str, matched_rule: &str) {
    CLASSIFIER_APPROVALS.lock().unwrap().insert(
        tool_use_id.to_string(),
        ClassifierApproval::Bash {
            matched_rule: matched_rule.to_string(),
        },
    );
}

/// Maps to CC `getClassifierApproval(toolUseID)`.
pub fn get_classifier_approval(tool_use_id: &str) -> Option<String> {
    match CLASSIFIER_APPROVALS.lock().unwrap().get(tool_use_id) {
        Some(ClassifierApproval::Bash { matched_rule }) => Some(matched_rule.clone()),
        _ => None,
    }
}

/// Maps to CC `setYoloClassifierApproval(toolUseID, reason)`.
pub fn set_yolo_classifier_approval(tool_use_id: &str, reason: &str) {
    CLASSIFIER_APPROVALS.lock().unwrap().insert(
        tool_use_id.to_string(),
        ClassifierApproval::AutoMode {
            reason: reason.to_string(),
        },
    );
}

/// Maps to CC `getYoloClassifierApproval(toolUseID)`.
pub fn get_yolo_classifier_approval(tool_use_id: &str) -> Option<String> {
    match CLASSIFIER_APPROVALS.lock().unwrap().get(tool_use_id) {
        Some(ClassifierApproval::AutoMode { reason }) => Some(reason.clone()),
        _ => None,
    }
}

/// Maps to CC `setClassifierChecking(toolUseID)`.
pub fn set_classifier_checking(tool_use_id: &str) {
    CLASSIFIER_CHECKING
        .lock()
        .unwrap()
        .insert(tool_use_id.to_string());
}

/// Maps to CC `clearClassifierChecking(toolUseID)`.
pub fn clear_classifier_checking(tool_use_id: &str) {
    CLASSIFIER_CHECKING.lock().unwrap().remove(tool_use_id);
}

/// Maps to CC `isClassifierChecking(toolUseID)`.
pub fn is_classifier_checking(tool_use_id: &str) -> bool {
    CLASSIFIER_CHECKING.lock().unwrap().contains(tool_use_id)
}

/// Maps to CC `deleteClassifierApproval(toolUseID)`.
pub fn delete_classifier_approval(tool_use_id: &str) {
    CLASSIFIER_APPROVALS.lock().unwrap().remove(tool_use_id);
}

/// Maps to CC `clearClassifierApprovals()`.
pub fn clear_classifier_approvals() {
    CLASSIFIER_APPROVALS.lock().unwrap().clear();
    CLASSIFIER_CHECKING.lock().unwrap().clear();
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClassifierApprovalsState {
    checking: Option<ClassifierChecking>,
}

impl ClassifierApprovalsState {
    pub fn start_checking(checking: ClassifierChecking) -> Self {
        Self {
            checking: Some(checking),
        }
    }

    pub fn clear(self) -> Self {
        Self::default()
    }

    pub fn checking(&self) -> Option<&ClassifierChecking> {
        self.checking.as_ref()
    }

    pub fn checking_tool_use_id(&self) -> Option<&str> {
        self.checking
            .as_ref()
            .map(|state| state.tool_use_id.as_str())
    }

    pub fn checking_is_auto(&self) -> bool {
        self.checking.as_ref().is_some_and(|state| state.is_auto)
    }

    pub fn is_classifier_checking(&self, tool_use_id: &str) -> bool {
        self.checking_tool_use_id() == Some(tool_use_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifier_approvals_state_matches_official_lookup_shape() {
        let state = ClassifierApprovalsState::start_checking(ClassifierChecking {
            tool_use_id: "toolu_1".to_string(),
            is_auto: true,
        });

        assert!(state.is_classifier_checking("toolu_1"));
        assert!(!state.is_classifier_checking("toolu_2"));
        assert_eq!(state.checking_tool_use_id(), Some("toolu_1"));
        assert!(state.checking_is_auto());
        assert_eq!(state.clone().clear(), ClassifierApprovalsState::default());
    }

    #[test]
    fn classifier_approval_store_tracks_bash_auto_mode_and_checking_sets() {
        clear_classifier_approvals();

        set_classifier_approval("toolu_bash", "Bash(git status:*)");
        set_yolo_classifier_approval("toolu_auto", "Safe read-only action");
        assert_eq!(
            get_classifier_approval("toolu_bash").as_deref(),
            Some("Bash(git status:*)")
        );
        assert_eq!(
            get_yolo_classifier_approval("toolu_auto").as_deref(),
            Some("Safe read-only action")
        );
        assert!(get_classifier_approval("toolu_auto").is_none());
        assert!(get_yolo_classifier_approval("toolu_bash").is_none());

        set_classifier_checking("toolu_bash");
        assert!(is_classifier_checking("toolu_bash"));
        clear_classifier_checking("toolu_bash");
        assert!(!is_classifier_checking("toolu_bash"));

        delete_classifier_approval("toolu_bash");
        assert!(get_classifier_approval("toolu_bash").is_none());
        clear_classifier_approvals();
        assert!(get_yolo_classifier_approval("toolu_auto").is_none());
    }
}
