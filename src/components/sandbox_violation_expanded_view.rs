//! Maps to: CC `components/SandboxViolationExpandedView.tsx`.
//!
//! The official component subscribes to `SandboxManager.getSandboxViolationStore()`
//! (via `utils/sandbox/sandbox-adapter.ts`). Nyan keeps the runtime store on
//! [`crate::utils::sandbox::sandbox_adapter::get_sandbox_violation_store`]; this
//! view currently receives the already-known last-violations snapshot plus total
//! count as props.

use chrono::{DateTime, Datelike, Local, Timelike};
use iocraft::prelude::*;
use std::time::SystemTime;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxViolationEventView {
    pub timestamp: SystemTime,
    pub command: Option<String>,
    pub line: String,
}

#[derive(Default, Props)]
pub struct SandboxViolationExpandedViewProps {
    pub sandboxing_enabled: bool,
    pub platform_is_linux: bool,
    pub violations: Vec<SandboxViolationEventView>,
    pub total_count: usize,
}

/// Maps to: CC `components/SandboxViolationExpandedView.tsx#formatTime`.
pub fn sandbox_violation_format_time_parts(hour_24: u32, minute: u32, second: u32) -> String {
    let h = hour_24 % 12;
    let h = if h == 0 { 12 } else { h };
    let ampm = if hour_24 < 12 { "am" } else { "pm" };
    format!("{h}:{minute:02}:{second:02}{ampm}")
}

pub fn sandbox_violation_format_time(timestamp: SystemTime) -> String {
    let date: DateTime<Local> = timestamp.into();
    let _ = date.year(); // keeps chrono Datelike import explicit for parity docs/tools.
    sandbox_violation_format_time_parts(date.hour(), date.minute(), date.second())
}

/// Maps to: CC `SandboxViolationExpandedView.tsx` visibility guards.
pub fn sandbox_violation_expanded_view_should_render(
    sandboxing_enabled: bool,
    platform_is_linux: bool,
    total_count: usize,
) -> bool {
    sandboxing_enabled && !platform_is_linux && total_count > 0
}

/// Maps to: CC `components/SandboxViolationExpandedView.tsx#SandboxViolationExpandedView`.
#[component]
pub fn SandboxViolationExpandedView(
    props: &SandboxViolationExpandedViewProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    if !sandbox_violation_expanded_view_should_render(
        props.sandboxing_enabled,
        props.platform_is_linux,
        props.total_count,
    ) {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    }

    let violations = props
        .violations
        .iter()
        .rev()
        .take(10)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let total_count = props.total_count;
    let shown_count = violations.len().min(10);

    element! {
        View(flex_direction: FlexDirection::Column, margin_top: 1u32) {
            View(margin_left: 0u32) {
                Text(
                    content: format!(
                        "⧈ Sandbox blocked {total_count} total {}",
                        if total_count == 1 { "operation" } else { "operations" }
                    ),
                    color: theme.permission,
                    wrap: TextWrap::NoWrap,
                )
            }
            #(violations.into_iter().map(|violation| {
                let command = violation.command.as_deref().map(|command| format!(" {command}:")).unwrap_or_default();
                element! {
                    View(padding_left: 2u32) {
                        Text(
                            content: format!("{}{command} {}", sandbox_violation_format_time(violation.timestamp), violation.line),
                            dim: true,
                            wrap: TextWrap::Wrap,
                        )
                    }
                }
            }).collect::<Vec<_>>())
            View(padding_left: 2u32) {
                Text(content: format!("… showing last {shown_count} of {total_count}"), dim: true, wrap: TextWrap::NoWrap)
            }
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn sandbox_violation_format_time_matches_official_shape() {
        assert_eq!(sandbox_violation_format_time_parts(0, 3, 4), "12:03:04am");
        assert_eq!(sandbox_violation_format_time_parts(13, 30, 45), "1:30:45pm");
        assert_eq!(sandbox_violation_format_time_parts(12, 0, 0), "12:00:00pm");
    }

    #[test]
    fn sandbox_violation_visibility_matches_official_guards() {
        assert!(sandbox_violation_expanded_view_should_render(
            true, false, 1
        ));
        assert!(!sandbox_violation_expanded_view_should_render(
            false, false, 1
        ));
        assert!(!sandbox_violation_expanded_view_should_render(
            true, true, 1
        ));
        assert!(!sandbox_violation_expanded_view_should_render(
            true, false, 0
        ));
    }

    #[test]
    fn sandbox_violation_expanded_view_renders_last_ten_summary() {
        let violations = (0..12)
            .map(|i| SandboxViolationEventView {
                timestamp: UNIX_EPOCH + Duration::from_secs(i),
                command: Some(format!("cmd{i}")),
                line: format!("blocked {i}"),
            })
            .collect::<Vec<_>>();
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                SandboxViolationExpandedView(
                    sandboxing_enabled: true,
                    platform_is_linux: false,
                    total_count: 12usize,
                    violations: violations,
                )
            }
        }
        .render(Some(120))
        .to_string();

        assert!(
            text.contains("⧈ Sandbox blocked 12 total operations"),
            "canvas=\n{text}"
        );
        assert!(
            !text.contains("cmd0"),
            "should show only last ten; canvas=\n{text}"
        );
        assert!(text.contains("cmd2:"), "canvas=\n{text}");
        assert!(text.contains("blocked 11"), "canvas=\n{text}");
        assert!(text.contains("… showing last 10 of 12"), "canvas=\n{text}");
    }
}
