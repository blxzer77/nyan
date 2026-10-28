//! Auto-dream memory consolidation service.
//!
//! @nyan: the service owns the lock, fork policy, and no-delete tool boundary.
//! `services/mod.rs` registration and idle-trigger wiring are coordinator seams.

pub mod lock;

use crate::constants::query_source::QuerySource;
use crate::tool::{CanUseToolCallback, ToolUseContext};
use crate::types::message::{Message, UserContent, UserMessage};
use crate::types::permissions::{PermissionDecision, PermissionDecisionReason};
use crate::utils::forked_agent::{CacheSafeParams, ForkedAgentParams, SubagentContextOverrides};
use lock::{ConsolidationLock, LockAcquireError};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsolidationResult {
    pub suggested_deletions: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConsolidationError {
    Busy(String),
    Fork(String),
    TimedOut,
    Aborted,
    MemoryGuardBlocked,
    Lock(String),
}

fn deny(tool: &str, reason: &str, tool_use_id: &str) -> PermissionDecision {
    PermissionDecision::Deny {
        message: format!("{tool} is not allowed for memory consolidation"),
        decision_reason: PermissionDecisionReason::Other {
            reason: reason.to_string(),
        },
        tool_use_id: Some(tool_use_id.to_string()),
    }
}

fn in_memory(path: &str, context: &ToolUseContext, memory_dir: &Path) -> bool {
    crate::utils::path::expand_path(path, Some(&context.effective_cwd()))
        .map(|path| path.starts_with(memory_dir))
        .unwrap_or(false)
}

fn consolidation_callback(context: &ToolUseContext, memory_dir: &Path) -> CanUseToolCallback {
    let context = context.clone();
    let memory_dir = memory_dir.to_path_buf();
    CanUseToolCallback::new(
        move |tool, input, _context, _assistant, tool_use_id, _force| {
            if !matches!(
                tool.name.as_str(),
                "Read" | "Glob" | "Grep" | "Write" | "Edit"
            ) {
                return deny(
                    &tool.name,
                    "consolidation has no Bash or delete tool access",
                    tool_use_id,
                );
            }
            let path = input
                .get("file_path")
                .or_else(|| input.get("path"))
                .and_then(serde_json::Value::as_str);
            if path.is_none_or(|path| !in_memory(path, &context, &memory_dir)) {
                return deny(
                    &tool.name,
                    "consolidation paths must stay inside auto-memory",
                    tool_use_id,
                );
            }
            PermissionDecision::Allow {
                updated_input: None,
                user_modified: None,
                decision_reason: Some(PermissionDecisionReason::Other {
                    reason: "memory consolidation directory allowlist".to_string(),
                }),
                tool_use_id: Some(tool_use_id.to_string()),
                accept_feedback: None,
                content_blocks: Vec::new(),
            }
        },
    )
}

fn consolidation_prompt(
    index: &str,
    candidates: &[crate::memdir::memdir::MemoryCandidate],
) -> String {
    let files = candidates
        .iter()
        .map(|candidate| format!("- {}", candidate.path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "[MEMORY CONSOLIDATION]\nRead the auto-memory files and MEMORY.md index. Deduplicate and update stale project/feedback/reference memories. You may write topic Markdown files and edit MEMORY.md only inside the auto-memory directory. You MUST NOT delete any file and you MUST NOT use Bash. Remove outdated entries from the index only when clearly obsolete, leave the file in place, and report every removed path as `SUGGEST_DELETE: <path>` for explicit user confirmation. Never save or expose secrets.\n\nMEMORY.md:\n{index}\n\nUnindexed candidates:\n{files}",
    )
}

fn suggestions(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("SUGGEST_DELETE:").map(str::trim))
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect()
}

fn usage_total(usage: &crate::services::api::claude::NonNullableUsage) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.output_tokens)
        .saturating_add(usage.cache_creation_input_tokens)
        .saturating_add(usage.cache_read_input_tokens)
}

/// Run one consolidation pass. The lock is rolled back on every non-success
/// path, including timeout and abort, so a later idle pass may retry.
pub async fn run_consolidation(
    context: ToolUseContext,
    cache_safe_params: Arc<CacheSafeParams>,
    max_turns: u32,
    timeout: Duration,
) -> Result<ConsolidationResult, ConsolidationError> {
    let memory_dir = crate::memdir::paths::get_auto_mem_path();
    let mut lock = ConsolidationLock::acquire(&memory_dir).map_err(|error| match error {
        LockAcquireError::Busy { pid, started_at_ms } => {
            ConsolidationError::Busy(format!("pid {pid}, started at {started_at_ms}"))
        }
        LockAcquireError::Io(error) => ConsolidationError::Lock(error.to_string()),
    })?;
    let index_path = crate::memdir::paths::get_auto_mem_entrypoint();
    let index = std::fs::read_to_string(&index_path).unwrap_or_default();
    if !crate::memdir::write_guard::check_memory_injection(&index_path, &index) {
        let _ = lock.rollback();
        return Err(ConsolidationError::MemoryGuardBlocked);
    }
    let candidates = crate::memdir::memdir::list_memory_candidates();
    let prompt = consolidation_prompt(&index, &candidates);
    let params = ForkedAgentParams {
        prompt_messages: vec![Message::User(UserMessage {
            uuid: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now(),
            content: vec![UserContent::Text(prompt)],
            is_compact_summary: false,
            plan_content: None,
            image_paste_ids: None,
            is_visible_in_transcript_only: false,
            mcp_meta: None,
            source_tool_assistant_uuid: None,
            permission_mode: None,
            origin: None,
            summarize_metadata: None,
        })],
        cache_safe_params: (*cache_safe_params).clone(),
        can_use_tool: consolidation_callback(&context, &memory_dir),
        query_source: QuerySource::AutoDream,
        fork_label: "auto-dream".to_string(),
        overrides: Some(SubagentContextOverrides {
            abort_controller: Some(context.abort_controller.clone()),
            ..Default::default()
        }),
        max_output_tokens: None,
        max_turns: Some(max_turns.max(1)),
        on_message: None,
        on_progress: None,
        skip_cache_write: true,
        skip_transcript: true,
    };
    let result = match tokio::time::timeout(
        timeout,
        crate::utils::forked_agent::run_forked_agent(params),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let _ = lock.rollback();
            if crate::utils::errors::is_abort_error(&error) {
                return Err(ConsolidationError::Aborted);
            }
            return Err(ConsolidationError::Fork(error.to_string()));
        }
        Err(_) => {
            let _ = lock.rollback();
            return Err(ConsolidationError::TimedOut);
        }
    };
    let usage = result.total_usage;
    crate::cost_tracker::add_to_total_tokens(usage.input_tokens, usage.output_tokens);
    if !result.api_errors.is_empty() {
        let _ = lock.rollback();
        return Err(ConsolidationError::Fork(
            "consolidation fork returned API errors".to_string(),
        ));
    }
    let text = crate::utils::forked_agent::extract_result_text(&result.messages, "");
    lock.complete()
        .map_err(|error| ConsolidationError::Lock(error.to_string()))?;
    Ok(ConsolidationResult {
        suggested_deletions: suggestions(&text),
        input_tokens: usage_total(&usage),
        output_tokens: usage.output_tokens,
    })
}

/// Deterministic automatic-trigger predicate. Manual callers bypass this.
pub fn consolidation_is_due(
    last_start_ms: Option<u64>,
    newest_file_ms: Option<u64>,
    new_file_count: usize,
    min_hours: u32,
    min_new_files: u32,
    now_ms: u64,
) -> bool {
    let elapsed_ok = last_start_ms
        .map(|last| now_ms.saturating_sub(last) >= u64::from(min_hours) * 3_600_000)
        .unwrap_or(true);
    elapsed_ok
        && new_file_count >= min_new_files as usize
        && newest_file_ms.is_some_and(|mtime| mtime > last_start_ms.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_trigger_requires_both_time_and_new_file_thresholds() {
        assert!(!consolidation_is_due(
            Some(1_000),
            Some(2_000),
            4,
            1,
            5,
            3_601_000
        ));
        assert!(consolidation_is_due(
            Some(1_000),
            Some(2_000),
            5,
            1,
            5,
            3_601_000
        ));
        assert!(!consolidation_is_due(
            Some(3_000),
            Some(2_000),
            5,
            1,
            5,
            3_601_000
        ));
    }
}
