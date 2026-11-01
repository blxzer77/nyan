//! Maps to: CC `components/messages/HookProgressMessage.tsx`.
//!
//! Official hook-progress rows are intentionally narrow: PreToolUse/PostToolUse
//! progress is hidden in live rows and summarized only in transcript mode, while
//! other unresolved hook events show a `Running … hook…` response row. Nyan
//! keeps this as display-only chrome; no hooks are executed here.

use crate::components::message_response::MessageResponse;
use crate::utils::theme::Theme;
use iocraft::prelude::*;

#[derive(Default, Props)]
pub struct HookProgressMessageProps {
    pub hook: String,
    pub status: String,
    pub add_margin: bool,
    pub is_transcript_mode: bool,
}

#[component]
pub fn HookProgressMessage(
    props: &HookProgressMessageProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let Some(content) =
        hook_progress_message_text(&props.hook, &props.status, props.is_transcript_mode)
    else {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    };

    element! {
        View(margin_top: if props.add_margin { 1u32 } else { 0u32 }) {
            MessageResponse(content: content, color: Some(theme.inactive))
        }
    }
    .into_any()
}

fn hook_progress_message_text(
    hook_event: &str,
    status: &str,
    is_transcript_mode: bool,
) -> Option<String> {
    let in_progress_count = hook_progress_count(status);
    if in_progress_count == 0 {
        return None;
    }

    if matches!(hook_event, "PreToolUse" | "PostToolUse") {
        if !is_transcript_mode {
            return None;
        }
        let noun = if in_progress_count == 1 {
            "hook"
        } else {
            "hooks"
        };
        return Some(format!("{in_progress_count} {hook_event} {noun} ran"));
    }

    if hook_progress_status_is_resolved(status) {
        return None;
    }

    let noun = if in_progress_count == 1 {
        "hook…"
    } else {
        "hooks…"
    };
    Some(format!("Running {hook_event} {noun}"))
}

fn hook_progress_count(status: &str) -> usize {
    status
        .split_whitespace()
        .next()
        .and_then(|token| token.parse::<usize>().ok())
        .unwrap_or(1)
}

fn hook_progress_status_is_resolved(status: &str) -> bool {
    let status = status.to_ascii_lowercase();
    status.contains("resolved")
        || status.contains("complete")
        || status.contains("completed")
        || status.contains("ran")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_progress_hides_pre_and_post_tool_use_outside_transcript_mode() {
        assert_eq!(
            hook_progress_message_text("PostToolUse", "running formatter", false),
            None
        );
        assert_eq!(
            hook_progress_message_text("PreToolUse", "running policy", false),
            None
        );
    }

    #[test]
    fn hook_progress_summarizes_pre_and_post_tool_use_in_transcript_mode() {
        assert_eq!(
            hook_progress_message_text("PostToolUse", "running formatter", true),
            Some("1 PostToolUse hook ran".to_string())
        );
        assert_eq!(
            hook_progress_message_text("PreToolUse", "2 running hooks", true),
            Some("2 PreToolUse hooks ran".to_string())
        );
    }

    #[test]
    fn hook_progress_renders_unresolved_non_tool_hook_like_official() {
        assert_eq!(
            hook_progress_message_text("Stop", "running cleanup", false),
            Some("Running Stop hook…".to_string())
        );
        assert_eq!(
            hook_progress_message_text("Notification", "3 running hooks", false),
            Some("Running Notification hooks…".to_string())
        );
    }

    #[test]
    fn hook_progress_hides_resolved_non_tool_hooks() {
        assert_eq!(hook_progress_message_text("Stop", "resolved", false), None);
        assert_eq!(
            hook_progress_message_text("Stop", "1 hook ran", false),
            None
        );
    }

    #[test]
    fn hook_progress_component_renders_message_response_for_visible_rows() {
        let text = element! {
            ContextProvider(value: Context::owned(*crate::utils::theme::current())) {
                HookProgressMessage(
                    hook: "Stop".to_string(),
                    status: "running cleanup".to_string(),
                    is_transcript_mode: false,
                )
            }
        }
        .render(None)
        .to_string();

        assert!(text.contains("⎿ Running Stop hook…"), "canvas=\n{text}");
    }
}
