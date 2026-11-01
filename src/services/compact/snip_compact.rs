//! Snip compaction control-flow seam.
//! Maps to CC `services/compact/snipCompact.ts` `snipCompactIfNeeded(...)`.

#[derive(Debug, Clone, Default)]
pub struct SnipCompactResult {
    /// Maps to official `SnipCompactResult.messages`.
    pub messages: Vec<crate::types::message::Message>,
    /// Maps to official optional snip boundary message yielded by `query.ts`
    /// (`query.ts:406-407` `yield snipResult.boundaryMessage`) — a whole
    /// `Message`, like every other query yield.
    pub boundary_messages: Vec<crate::types::message::Message>,
    /// Maps to official `tokensFreed` threaded into autocompact.
    pub tokens_freed: i64,
}

/// Maps to: CC `services/compact/snipCompact.ts` `snipCompactIfNeeded(...)`.
///
/// The checked-in upstream source for `snipCompact.ts` is currently a
/// generated empty stub, while `query.ts` still has an explicit
/// `snipCompactIfNeeded(...)` control-flow slot and threads `tokensFreed` into
/// autocompact. Keep Nyan as a safe no-op seam at that official query-loop
/// position until a non-stub upstream implementation exists.
pub fn snip_compact_if_needed(
    messages_for_query: Vec<crate::types::message::Message>,
) -> SnipCompactResult {
    SnipCompactResult {
        messages: messages_for_query,
        boundary_messages: Vec::new(),
        tokens_freed: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snip_compact_if_needed_is_safe_noop_for_current_empty_upstream_stub() {
        let messages = vec![crate::types::message::Message::User(
            crate::types::message::UserMessage {
                uuid: uuid::Uuid::new_v4().to_string(),
                timestamp: chrono::Utc::now(),
                content: vec![crate::types::message::UserContent::Text(
                    "before snip".to_string(),
                )],
                is_compact_summary: false,
                plan_content: None,
                image_paste_ids: None,
                is_visible_in_transcript_only: false,
                mcp_meta: None,
                source_tool_assistant_uuid: None,
                permission_mode: None,
                origin: None,
                summarize_metadata: None,
            },
        )];

        let result = snip_compact_if_needed(messages.clone());

        assert_eq!(result.messages.len(), messages.len());
        assert!(result.boundary_messages.is_empty());
        assert_eq!(result.tokens_freed, 0);
    }
}
