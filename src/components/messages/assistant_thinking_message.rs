//! Maps to: CC `components/messages/AssistantThinkingMessage.tsx`.

use crate::components::ctrl_o_to_expand::CtrlOToExpand;
use crate::components::markdown::Markdown;
use crate::utils::theme::Theme;
use iocraft::prelude::*;

#[derive(Default, Props)]
pub struct AssistantThinkingMessageProps {
    pub content: String,
    pub add_margin: bool,
    /// Per-message expansion carried by `AssistantMessageKind::Thinking`
    /// (no CC counterpart; CC's only per-message prop is the inverse
    /// `hideInTranscript`, AssistantThinkingMessage.tsx:20). Disposition
    /// (recorded 2026-08-01): every producer currently hardcodes `false`
    /// (query.rs `assistant_content_to_source_event_kind_with_status`,
    /// conversation_recovery.rs `assistant_block_kind`) — dormant seam,
    /// kept in the disjunct per the ruled expression.
    pub expanded: bool,
    /// CC prop (AssistantThinkingMessage.tsx:18). NOT part of the expansion
    /// decision (single-source ruling, see `expand_by_default`); retained for
    /// CC prop shape only.
    pub verbose: bool,
    pub is_transcript_mode: bool,
    /// Nyan extension (no CC counterpart) — user-authorized L2 (v3 ruling,
    /// 2026-08-01). SINGLE-SOURCE expansion control REPLACING CC's
    /// `isTranscriptMode || verbose` gate (AssistantThinkingMessage.tsx:38);
    /// transcript mode stays a separate disjunct, `verbose` is excluded.
    /// Default true (factory `expandThinking`, `AppState.expand_thinking`).
    /// When false, show the collapsed `∴ Thinking (ctrl+o to expand)` hint.
    pub expand_by_default: bool,
}

#[component]
pub fn AssistantThinkingMessage(
    props: &AssistantThinkingMessageProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    // Single-source rule (user-authorized L2, v3 2026-08-01): `expand_by_default`
    // REPLACES CC's `verbose` disjunct (`isTranscriptMode || verbose`,
    // AssistantThinkingMessage.tsx:38) — verbose is deliberately excluded;
    // transcript mode stays. Both AUTHORIZED deviations: this single-source
    // replacement, and the visibility gate — CC renders thinking as null when
    // neither verbose nor transcript (Message.tsx:449-451) while Nyan always
    // mounts this leaf and shows the collapsed hint (no Nyan visibility gate
    // reads verbose for thinking blocks; verified message.rs/messages_list.rs).
    // `expanded` is the dormant per-message seam (see props doc).
    let should_show_full = props.expanded || props.is_transcript_mode || props.expand_by_default;

    if !should_show_full {
        // Official: `∴ Thinking` + space + `<CtrlOToExpand />` (dim italic).
        return element! {
            View(
                flex_direction: FlexDirection::Row,
                margin_top: if props.add_margin { 1u32 } else { 0u32 },
            ) {
                Text(
                    content: "∴ Thinking ".to_string(),
                    color: theme.inactive,
                    italic: true,
                    wrap: TextWrap::NoWrap,
                )
                CtrlOToExpand
            }
        }
        .into_any();
    }

    element! {
        View(
            flex_direction: FlexDirection::Column,
            margin_top: if props.add_margin { 1u32 } else { 0u32 },
            gap: 1u32,
            width: 100pct,
        ) {
            Text(
                content: "∴ Thinking…".to_string(),
                color: theme.inactive,
                italic: true,
                wrap: TextWrap::NoWrap,
            )
            View(padding_left: 2u32) {
                Markdown(content: props.content.clone(), dim_color: true)
            }
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_collapsed_hides_content_until_expand_switch_or_transcript_mode() {
        let canvas = element! {
            ContextProvider(value: Context::owned(*crate::utils::theme::current())) {
                AssistantThinkingMessage(
                    content: "hidden reasoning".to_string(),
                    expanded: false,
                    verbose: false,
                    is_transcript_mode: false,
                    expand_by_default: false,
                )
            }
        }
        .render(None);

        let rendered = canvas.to_string();
        assert!(rendered.contains("∴ Thinking"));
        assert!(rendered.contains("ctrl+o to expand") || rendered.contains("to expand"));
        assert!(!rendered.contains("hidden reasoning"));
    }

    #[test]
    fn thinking_verbose_true_without_expand_switch_stays_collapsed() {
        // Pins the single-source rule (user-authorized L2, v3 2026-08-01):
        // `verbose` alone must NOT expand thinking blocks; only the expand
        // switch (or transcript mode / per-message `expanded`) does.
        let canvas = element! {
            ContextProvider(value: Context::owned(*crate::utils::theme::current())) {
                AssistantThinkingMessage(
                    content: "verbose-only reasoning".to_string(),
                    expanded: false,
                    verbose: true,
                    is_transcript_mode: false,
                    expand_by_default: false,
                )
            }
        }
        .render(None);

        let rendered = canvas.to_string();
        assert!(rendered.contains("∴ Thinking"));
        assert!(
            rendered.contains("to expand"),
            "collapsed hint expected; canvas=\n{rendered}"
        );
        assert!(!rendered.contains("verbose-only reasoning"));
    }

    #[test]
    fn thinking_expands_by_default_setting_without_transcript_mode() {
        let canvas = element! {
            ContextProvider(value: Context::owned(*crate::utils::theme::current())) {
                AssistantThinkingMessage(
                    content: "shown reasoning".to_string(),
                    expanded: false,
                    verbose: false,
                    is_transcript_mode: false,
                    expand_by_default: true,
                )
            }
        }
        .render(None);

        let rendered = canvas.to_string();
        assert!(rendered.contains("∴ Thinking…"));
        assert!(rendered.contains("shown reasoning"));
    }

    #[test]
    fn thinking_expands_in_transcript_mode_with_dim_markdown_content() {
        let canvas = element! {
            ContextProvider(value: Context::owned(*crate::utils::theme::current())) {
                AssistantThinkingMessage(
                    content: "**important**".to_string(),
                    expanded: false,
                    verbose: false,
                    is_transcript_mode: true,
                    expand_by_default: false,
                )
            }
        }
        .render(None);

        let rendered = canvas.to_string();
        assert!(rendered.contains("∴ Thinking…"));
        assert!(rendered.contains("important"));

        let important_line = rendered
            .lines()
            .position(|line| line.contains("important"))
            .expect("expanded thinking markdown content should render");
        let important_col = rendered
            .lines()
            .nth(important_line)
            .and_then(|line| line.find("important"))
            .expect("important column should exist");
        assert_eq!(
            canvas
                .resolved_text_style(important_line, important_col)
                .unwrap()
                .weight,
            Weight::Light
        );
    }
}
