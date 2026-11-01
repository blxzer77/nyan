//! Maps to: CC `components/LogoV2/AnimatedClawd.tsx`.
//!
//! Official click animations require mouse tracking and timers. nyan keeps
//! the frame sequences and fixed-height render boundary, while live click/timer
//! playback remains inactive in main-screen native scrollback mode.

use super::clawd::{Clawd, ClawdPose};
use iocraft::prelude::*;

pub const FRAME_MS: u64 = 60;
pub const CLAWD_HEIGHT: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClawdAnimationFrame {
    pub pose: ClawdPose,
    pub offset: u32,
}

const IDLE: ClawdAnimationFrame = ClawdAnimationFrame {
    pose: ClawdPose::Default,
    offset: 0,
};

pub fn hold(pose: ClawdPose, offset: u32, frames: usize) -> Vec<ClawdAnimationFrame> {
    vec![ClawdAnimationFrame { pose, offset }; frames]
}

pub fn jump_wave() -> Vec<ClawdAnimationFrame> {
    let mut frames = Vec::new();
    frames.extend(hold(ClawdPose::Default, 1, 2));
    frames.extend(hold(ClawdPose::ArmsUp, 0, 3));
    frames.extend(hold(ClawdPose::Default, 0, 1));
    frames.extend(hold(ClawdPose::Default, 1, 2));
    frames.extend(hold(ClawdPose::ArmsUp, 0, 3));
    frames.extend(hold(ClawdPose::Default, 0, 1));
    frames
}

pub fn look_around() -> Vec<ClawdAnimationFrame> {
    let mut frames = Vec::new();
    frames.extend(hold(ClawdPose::LookRight, 0, 5));
    frames.extend(hold(ClawdPose::LookLeft, 0, 5));
    frames.extend(hold(ClawdPose::Default, 0, 1));
    frames
}

pub fn clawd_frame_at(sequence: &[ClawdAnimationFrame], frame_index: isize) -> ClawdAnimationFrame {
    if frame_index >= 0 {
        sequence.get(frame_index as usize).copied().unwrap_or(IDLE)
    } else {
        IDLE
    }
}

#[derive(Default, Props)]
pub struct AnimatedClawdProps {
    pub pose: Option<ClawdPose>,
    pub bounce_offset: Option<u32>,
}

#[component]
pub fn AnimatedClawd(props: &AnimatedClawdProps) -> impl Into<AnyElement<'static>> {
    let pose = props.pose.unwrap_or(ClawdPose::Default);
    let bounce_offset = props.bounce_offset.unwrap_or(0);

    element! {
        View(height: CLAWD_HEIGHT, flex_direction: FlexDirection::Column, overflow: Overflow::Hidden) {
            View(margin_top: bounce_offset, flex_shrink: 0.0f32) {
                Clawd(pose: pose)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    #[test]
    fn animated_clawd_sequences_match_official_frame_counts_and_poses() {
        let jump = jump_wave();
        assert_eq!(jump.len(), 12);
        assert_eq!(
            jump[0],
            ClawdAnimationFrame {
                pose: ClawdPose::Default,
                offset: 1
            }
        );
        assert_eq!(
            jump[2],
            ClawdAnimationFrame {
                pose: ClawdPose::ArmsUp,
                offset: 0
            }
        );
        assert_eq!(
            jump[11],
            ClawdAnimationFrame {
                pose: ClawdPose::Default,
                offset: 0
            }
        );

        let look = look_around();
        assert_eq!(look.len(), 11);
        assert_eq!(look[0].pose, ClawdPose::LookRight);
        assert_eq!(look[5].pose, ClawdPose::LookLeft);
        assert_eq!(
            look[10],
            ClawdAnimationFrame {
                pose: ClawdPose::Default,
                offset: 0
            }
        );
    }

    #[test]
    fn animated_clawd_frame_lookup_returns_idle_outside_active_sequence() {
        let jump = jump_wave();
        assert_eq!(clawd_frame_at(&jump, -1), IDLE);
        assert_eq!(clawd_frame_at(&jump, 99), IDLE);
        assert_eq!(clawd_frame_at(&jump, 2).pose, ClawdPose::ArmsUp);
    }

    #[test]
    fn animated_clawd_renders_fixed_height_boundary() {
        let canvas = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                AnimatedClawd(pose: Some(ClawdPose::ArmsUp), bounce_offset: Some(0u32))
            }
        }
        .render(Some(20));
        let text = canvas.to_string();
        assert!(text.contains("▗▟▛███▜▙▖"), "canvas=\n{text}");
    }
}
