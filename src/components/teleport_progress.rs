//! Maps to: CC `components/TeleportProgress.tsx`.
//!
//! The official file also exports `teleportWithProgress(...)`, which performs
//! remote resume and branch checkout side effects. Nyan keeps that runtime
//! flow deferred to the teleport service slice; this component ports the
//! progress UI and step model only.

use crate::constants::figures::MAIN_SYMBOLS;
use iocraft::prelude::*;

pub const TELEPORT_SPINNER_FRAMES: &[&str] = &["◐", "◓", "◑", "◒"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TeleportProgressStep {
    #[default]
    Validating,
    FetchingLogs,
    FetchingBranch,
    CheckingOut,
}

impl TeleportProgressStep {
    pub fn key(self) -> &'static str {
        match self {
            Self::Validating => "validating",
            Self::FetchingLogs => "fetching_logs",
            Self::FetchingBranch => "fetching_branch",
            Self::CheckingOut => "checking_out",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TeleportProgressStepDef {
    pub key: TeleportProgressStep,
    pub label: &'static str,
}

/// Maps to: CC `components/TeleportProgress.tsx#STEPS`.
pub const TELEPORT_PROGRESS_STEPS: &[TeleportProgressStepDef] = &[
    TeleportProgressStepDef {
        key: TeleportProgressStep::Validating,
        label: "Validating session",
    },
    TeleportProgressStepDef {
        key: TeleportProgressStep::FetchingLogs,
        label: "Fetching session logs",
    },
    TeleportProgressStepDef {
        key: TeleportProgressStep::FetchingBranch,
        label: "Getting branch info",
    },
    TeleportProgressStepDef {
        key: TeleportProgressStep::CheckingOut,
        label: "Checking out branch",
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TeleportProgressRowState {
    Complete,
    Current,
    Pending,
}

pub fn teleport_progress_step_index(current_step: TeleportProgressStep) -> usize {
    TELEPORT_PROGRESS_STEPS
        .iter()
        .position(|step| step.key == current_step)
        .unwrap_or(0)
}

pub fn teleport_progress_row_state(
    current_step: TeleportProgressStep,
    row_index: usize,
) -> TeleportProgressRowState {
    let current_index = teleport_progress_step_index(current_step);
    if row_index < current_index {
        TeleportProgressRowState::Complete
    } else if row_index == current_index {
        TeleportProgressRowState::Current
    } else {
        TeleportProgressRowState::Pending
    }
}

#[derive(Default, Props)]
pub struct TeleportProgressProps {
    pub current_step: TeleportProgressStep,
    pub session_id: Option<String>,
    /// Maps to official `useAnimationFrame(100)` frame selection; callers pass
    /// the current frame index in deterministic renders/tests.
    pub frame_index: usize,
}

/// Maps to: CC `components/TeleportProgress.tsx#TeleportProgress`.
#[component]
pub fn TeleportProgress(
    props: &TeleportProgressProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    let frame = TELEPORT_SPINNER_FRAMES[props.frame_index % TELEPORT_SPINNER_FRAMES.len()];
    let session_id = props.session_id.clone();

    element! {
        View(flex_direction: FlexDirection::Column, padding_left: 1u32, padding_right: 1u32, padding_top: 1u32, padding_bottom: 1u32) {
            View(margin_bottom: 1u32) {
                Text(content: format!("{frame} Teleporting session…"), weight: Weight::Bold, color: theme.claude, wrap: TextWrap::NoWrap)
            }
            #(session_id.map(|session_id| element! {
                View(margin_bottom: 1u32) {
                    Text(content: session_id, dim: true, wrap: TextWrap::NoWrap)
                }
            }))
            View(flex_direction: FlexDirection::Column, margin_left: 2u32) {
                #(TELEPORT_PROGRESS_STEPS.iter().enumerate().map(|(index, step)| {
                    let state = teleport_progress_row_state(props.current_step, index);
                    let (icon, color, dim, bold) = match state {
                        TeleportProgressRowState::Complete => (MAIN_SYMBOLS.tick.to_string(), Some(Color::Green), false, false),
                        TeleportProgressRowState::Current => (frame.to_string(), Some(theme.claude), false, true),
                        TeleportProgressRowState::Pending => (MAIN_SYMBOLS.circle.to_string(), None, true, false),
                    };
                    element! {
                        View(flex_direction: FlexDirection::Row) {
                            View(width: 2u32) {
                                Text(content: icon, color: color, dim: dim, wrap: TextWrap::NoWrap)
                            }
                            Text(content: step.label.to_string(), dim: dim, weight: if bold { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                        }
                    }
                }).collect::<Vec<_>>())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    #[test]
    fn teleport_progress_steps_match_official_order() {
        assert_eq!(
            TELEPORT_PROGRESS_STEPS
                .iter()
                .map(|step| step.key.key())
                .collect::<Vec<_>>(),
            vec![
                "validating",
                "fetching_logs",
                "fetching_branch",
                "checking_out"
            ]
        );
        assert_eq!(
            TELEPORT_PROGRESS_STEPS
                .iter()
                .map(|step| step.label)
                .collect::<Vec<_>>(),
            vec![
                "Validating session",
                "Fetching session logs",
                "Getting branch info",
                "Checking out branch"
            ]
        );
    }

    #[test]
    fn teleport_progress_row_state_marks_complete_current_pending() {
        assert_eq!(
            teleport_progress_row_state(TeleportProgressStep::FetchingBranch, 0),
            TeleportProgressRowState::Complete
        );
        assert_eq!(
            teleport_progress_row_state(TeleportProgressStep::FetchingBranch, 2),
            TeleportProgressRowState::Current
        );
        assert_eq!(
            teleport_progress_row_state(TeleportProgressStep::FetchingBranch, 3),
            TeleportProgressRowState::Pending
        );
    }

    #[test]
    fn teleport_progress_renders_session_and_step_list() {
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                TeleportProgress(
                    current_step: TeleportProgressStep::FetchingLogs,
                    session_id: Some("sess-123".to_string()),
                    frame_index: 1usize,
                )
            }
        }
        .render(Some(100))
        .to_string();

        assert!(text.contains("◓ Teleporting session…"), "canvas=\n{text}");
        assert!(text.contains("sess-123"), "canvas=\n{text}");
        assert!(text.contains("Validating session"), "canvas=\n{text}");
        assert!(text.contains("Fetching session logs"), "canvas=\n{text}");
    }
}
