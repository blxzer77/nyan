//! Maps to: CC `components/permissions/WorkerBadge.tsx`.
//!
//! Pure permission-prompt badge data/component boundary. The official component
//! renders a colored bullet plus bold `@name`; runtime worker/subagent state is
//! supplied by callers and is not read here.

use crate::constants::figures::BLACK_CIRCLE;
use iocraft::prelude::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkerBadgeProps {
    pub name: String,
    /// Maps to official `color: string`; Nyan callers that need exact color
    /// conversion should resolve it before constructing the iocraft component.
    pub color: Option<Color>,
}

#[derive(Default, Props)]
pub struct WorkerBadgeComponentProps {
    pub badge: WorkerBadgeProps,
}

/// Maps to: CC `components/permissions/WorkerBadge.tsx` `WorkerBadge`.
#[component]
pub fn WorkerBadge(props: &WorkerBadgeComponentProps) -> impl Into<AnyElement<'static>> {
    element! {
        View(flex_direction: FlexDirection::Row, column_gap: 1u32) {
            Text(content: format!("{} ", BLACK_CIRCLE), color: props.badge.color, wrap: TextWrap::NoWrap)
            Text(content: format!("@{}", props.badge.name), color: props.badge.color, weight: Weight::Bold, wrap: TextWrap::NoWrap)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_badge_renders_official_bullet_and_name() {
        let text = element! {
            WorkerBadge(badge: WorkerBadgeProps { name: "agent-a".to_string(), color: None })
        }
        .render(Some(80))
        .to_string();

        assert!(text.contains("@agent-a"), "canvas=\n{text}");
    }
}
