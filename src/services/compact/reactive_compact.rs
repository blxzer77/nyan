//! Reactive compact control-flow seam.
//! Maps to CC `services/compact/reactiveCompact.ts`.
//!
//! The checked-in upstream `services/compact/reactiveCompact.ts` is currently a
//! generated empty stub, while `query.ts` still contains optional prompt-too-long
//! and media-size recovery branches after context-collapse overflow recovery.
//! Nyan keeps this as a safe no-op seam at the official query-loop position
//! until a non-stub upstream implementation exists.

use crate::constants::query_source::QuerySource;
use crate::services::compact::auto_compact::AutoCompactCacheSafeParams;
use crate::types::message::{Message, SystemApiErrorMessage};

#[derive(Debug, Clone)]
pub struct ReactiveCompactParams {
    /// Maps to CC `tryReactiveCompact({ hasAttempted })`.
    pub has_attempted: bool,
    /// Maps to CC `tryReactiveCompact({ querySource })`.
    pub query_source: QuerySource,
    /// Maps to CC `tryReactiveCompact({ aborted })`.
    pub aborted: bool,
    /// Maps to CC `tryReactiveCompact({ messages })`.
    pub messages: Vec<Message>,
    /// Maps to CC `tryReactiveCompact({ cacheSafeParams })`.
    pub cache_safe_params: AutoCompactCacheSafeParams,
}

#[derive(Debug, Clone, Default)]
pub struct ReactiveCompactResult {
    /// Maps to CC `tryReactiveCompact(...)` returning a compaction result or
    /// `undefined`. Current upstream stub never compacts.
    pub compacted: Option<crate::services::compact::auto_compact::AutocompactResult>,
}

/// Maps to CC `services/compact/reactiveCompact.ts` `isReactiveCompactEnabled()`.
pub fn is_reactive_compact_enabled() -> bool {
    // Upstream source is a generated empty stub in this snapshot, so there is
    // no official enabled state to mirror yet.
    false
}

/// Maps to CC `services/compact/reactiveCompact.ts`
/// `isWithheldPromptTooLong(...)`.
pub fn is_withheld_prompt_too_long(error: &SystemApiErrorMessage) -> bool {
    // Safe no-op until upstream ships a non-stub implementation. Keep the
    // official predicate shape so query.rs can call the seam at the upstream
    // branch point without surfacing the withheld message early.
    is_reactive_compact_enabled()
        && (error
            .content
            .starts_with(crate::services::api::errors::PROMPT_TOO_LONG_ERROR_MESSAGE)
            || error
                .error_details
                .as_deref()
                .is_some_and(|details| details.to_ascii_lowercase().contains("prompt is too long")))
}

/// Maps to CC `services/compact/reactiveCompact.ts`
/// `isWithheldMediaSizeError(...)`.
pub fn is_withheld_media_size_error(error: &SystemApiErrorMessage) -> bool {
    // Safe no-op until upstream ships a non-stub implementation. The media
    // classifier is still mirrored behind the disabled gate so enabling the
    // service later preserves official query-loop ordering.
    is_reactive_compact_enabled()
        && crate::services::api::errors::is_media_size_error(&format!(
            "{}\n{}\n{}",
            error.content,
            error.api_error,
            error.error_details.as_deref().unwrap_or_default()
        ))
}

/// Maps to CC `services/compact/reactiveCompact.ts` `tryReactiveCompact(...)`.
pub fn try_reactive_compact(_params: ReactiveCompactParams) -> ReactiveCompactResult {
    // TODO: Port real reactive compact once upstream source is available.
    ReactiveCompactResult { compacted: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reactive_compact_is_safe_noop_for_current_empty_upstream_stub() {
        let error = SystemApiErrorMessage {
            content: crate::services::api::errors::PROMPT_TOO_LONG_ERROR_MESSAGE.to_string(),
            api_error: "invalid_request".to_string(),
            error: "invalid_request".to_string(),
            error_details: None,
        };
        assert!(!is_reactive_compact_enabled());
        assert!(!is_withheld_prompt_too_long(&error));
        assert!(!is_withheld_media_size_error(&error));

        let result = try_reactive_compact(ReactiveCompactParams {
            has_attempted: false,
            query_source: QuerySource::Prompt,
            aborted: false,
            messages: Vec::new(),
            cache_safe_params: AutoCompactCacheSafeParams {
                system_prompt: Vec::new(),
                user_context: std::collections::BTreeMap::new(),
                system_context: std::collections::BTreeMap::new(),
                fork_context_messages: Vec::new(),
            },
        });
        assert!(result.compacted.is_none());
    }
}
