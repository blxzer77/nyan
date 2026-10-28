//! Background memory extraction service.
//!
//! @nyan: this directory is intentionally a standalone service seam. The
//! compaction owner must call [`extract_before_compact`] before it replaces
//! history; the stop-hook owner must call [`extract_if_due`] at turn end.
//! Top-level registration is left to the coordinator because `services/mod.rs`
//! is owned by the integration slice.

use crate::constants::query_source::QuerySource;
use crate::tool::{CanUseToolCallback, ToolUseContext};
use crate::types::message::{Message, UserContent, UserMessage};
use crate::types::permissions::{PermissionDecision, PermissionDecisionReason};
use crate::utils::forked_agent::{
    CacheSafeParams, ForkedAgentParams, SubagentContextOverrides, run_forked_agent,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const CURSOR_METADATA_TYPE: &str = "memory-extract-cursor";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExtractCursor {
    pub message_uuid: Option<String>,
    pub at_ms: Option<i64>,
}

impl ExtractCursor {
    pub fn marker(&self) -> Option<serde_json::Value> {
        self.message_uuid.as_ref().map(|uuid| {
            serde_json::json!({
                "type": CURSOR_METADATA_TYPE,
                "uuid": uuid,
                "at": self.at_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
            })
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExtractionProgress {
    pub turns_since_extract: u32,
    pub tokens_at_last_extract: u64,
    pub cursor: ExtractCursor,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExtractSkipReason {
    Disabled,
    NotDue,
    NoCacheSafeParams,
    NoNewMessages,
    MemoryGuardBlocked,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExtractFailure {
    Agent(String),
    TimedOut,
    Aborted,
    MemoryGuardBlocked,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExtractStatus {
    Success,
    Skipped(ExtractSkipReason),
    Failed(ExtractFailure),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractOutcome {
    pub status: ExtractStatus,
    pub cursor: ExtractCursor,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl ExtractOutcome {
    fn skipped(reason: ExtractSkipReason, cursor: ExtractCursor) -> Self {
        Self {
            status: ExtractStatus::Skipped(reason),
            cursor,
            input_tokens: 0,
            output_tokens: 0,
        }
    }
}

/// Cursor metadata is parsed separately from conversation messages because it
/// is a session JSONL metadata entry, not a model-visible `Message`.
pub fn cursor_from_metadata(entries: &[serde_json::Value]) -> ExtractCursor {
    entries
        .iter()
        .rev()
        .find(|entry| {
            entry.get("type").and_then(serde_json::Value::as_str) == Some(CURSOR_METADATA_TYPE)
        })
        .map(|entry| ExtractCursor {
            message_uuid: entry
                .get("uuid")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            at_ms: entry.get("at").and_then(serde_json::Value::as_i64),
        })
        .unwrap_or_default()
}

pub fn messages_after_cursor(messages: &[Message], cursor: &ExtractCursor) -> Vec<Message> {
    let Some(uuid) = cursor.message_uuid.as_deref() else {
        return messages.to_vec();
    };
    let Some(index) = messages.iter().position(|message| message.uuid() == uuid) else {
        return messages.to_vec();
    };
    messages.iter().skip(index + 1).cloned().collect()
}

fn message_text(message: &Message) -> String {
    match message {
        Message::User(user) => {
            crate::utils::messages::get_user_message_text(user).unwrap_or_default()
        }
        Message::Assistant(_) => {
            crate::utils::messages::get_assistant_message_text(message).unwrap_or_default()
        }
        // Tool results are retained only as a bounded diagnostic fragment on
        // the dedicated-model path; the default path already has the original
        // cache-safe history.
        _ => format!("{message:?}"),
    }
}

fn bounded_new_message_context(messages: &[Message]) -> String {
    messages
        .iter()
        .map(|message| {
            let text = message_text(message);
            let text = if text.chars().count() > 2_000 {
                text.chars().take(2_000).collect::<String>()
            } else {
                text
            };
            format!("### message {}\n{}", message.uuid(), text)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn extraction_prompt(new_context: &str, memory_index: &str, dedicated_model: bool) -> String {
    let context = if dedicated_model {
        new_context
    } else {
        "The complete cache-safe conversation history is already available to you. Use the cursor and index below to avoid duplicating existing memories."
    };
    format!(
        "[MEMORY EXTRACTION]\nExtract only durable facts that cannot be derived from the current repository or git history. Use only the four memory types user, feedback, project, and reference. Prefer updating an existing topic over creating a duplicate. `type: user` files are candidates and must not be added to MEMORY.md automatically. Never save prompts, transcripts, temporary task state, secrets, or credentials.\n\n{context}\n\nCurrent MEMORY.md index:\n{memory_index}\n\nWrite candidate/topic files only under the auto-memory directory. Add an index entry only for low-risk, non-user memories you are confident about. Report what you wrote and which files remain candidates.",
    )
}

fn deny(tool: &str, reason: &str, tool_use_id: &str) -> PermissionDecision {
    PermissionDecision::Deny {
        message: format!(
            "{tool} is not allowed for memory extraction outside the memory directory"
        ),
        decision_reason: PermissionDecisionReason::Other {
            reason: reason.to_string(),
        },
        tool_use_id: Some(tool_use_id.to_string()),
    }
}

fn path_is_in_memory(path: &str, context: &ToolUseContext, memory_dir: &Path) -> bool {
    crate::utils::path::expand_path(path, Some(&context.effective_cwd()))
        .map(|path| path.starts_with(memory_dir))
        .unwrap_or(false)
}

fn tool_path_allowed(
    tool_name: &str,
    input: &serde_json::Value,
    context: &ToolUseContext,
    memory_dir: &Path,
) -> bool {
    let paths = if tool_name == "Read" {
        input
            .get("files")
            .and_then(serde_json::Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .filter_map(|file| file.get("file_path").and_then(serde_json::Value::as_str))
                    .collect::<Vec<_>>()
            })
            .filter(|paths| !paths.is_empty())
            .unwrap_or_else(|| {
                input
                    .get("file_path")
                    .and_then(serde_json::Value::as_str)
                    .into_iter()
                    .collect()
            })
    } else {
        input
            .get("path")
            .or_else(|| input.get("file_path"))
            .and_then(serde_json::Value::as_str)
            .into_iter()
            .collect()
    };
    !paths.is_empty()
        && paths
            .into_iter()
            .all(|path| path_is_in_memory(path, context, memory_dir))
}

fn extraction_tool_callback(context: &ToolUseContext, memory_dir: &Path) -> CanUseToolCallback {
    let context = context.clone();
    let memory_dir = memory_dir.to_path_buf();
    CanUseToolCallback::new(
        move |tool, input, _context, _assistant, tool_use_id, _force| {
            let allowed_name = matches!(
                tool.name.as_str(),
                "Read" | "Glob" | "Grep" | "Write" | "Edit"
            );
            if !allowed_name {
                return deny(
                    &tool.name,
                    "memory extraction has no shell or unrelated tool access",
                    tool_use_id,
                );
            }
            if !tool_path_allowed(&tool.name, input, &context, &memory_dir) {
                return deny(
                    &tool.name,
                    "memory extraction paths must stay inside auto-memory",
                    tool_use_id,
                );
            }
            PermissionDecision::Allow {
                updated_input: None,
                user_modified: None,
                decision_reason: Some(PermissionDecisionReason::Other {
                    reason: "memory extraction directory allowlist".to_string(),
                }),
                tool_use_id: Some(tool_use_id.to_string()),
                accept_feedback: None,
                content_blocks: Vec::new(),
            }
        },
    )
}

fn token_total(usage: &crate::services::api::claude::NonNullableUsage) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.output_tokens)
        .saturating_add(usage.cache_creation_input_tokens)
        .saturating_add(usage.cache_read_input_tokens)
}

/// Deterministic turn/token throttle used by the stop-hook integration.
pub fn extraction_is_due(
    progress: &ExtractionProgress,
    message_count: usize,
    token_count: u64,
    every_turns: u32,
    every_tokens: u32,
) -> bool {
    message_count > 0
        && (progress.turns_since_extract >= every_turns.max(1)
            || token_count.saturating_sub(progress.tokens_at_last_extract)
                >= u64::from(every_tokens))
}

/// Run one extraction fork. The coordinator must append `outcome.cursor.marker()`
/// to the session metadata only after this returns `ExtractStatus::Success`.
pub async fn run_extract_memories(
    context: ToolUseContext,
    cache_safe_params: Option<Arc<CacheSafeParams>>,
    messages: Vec<Message>,
    cursor: ExtractCursor,
    memory_index: String,
    extract_model: Option<String>,
    max_turns: u32,
    timeout: Duration,
) -> ExtractOutcome {
    let Some(cache_safe_params) = cache_safe_params else {
        return ExtractOutcome::skipped(ExtractSkipReason::NoCacheSafeParams, cursor);
    };
    let new_messages = messages_after_cursor(&messages, &cursor);
    if new_messages.is_empty() {
        return ExtractOutcome::skipped(ExtractSkipReason::NoNewMessages, cursor);
    }
    let memory_dir = crate::memdir::paths::get_auto_mem_path();
    if !crate::memdir::write_guard::check_memory_injection(
        &crate::memdir::paths::get_auto_mem_entrypoint(),
        &memory_index,
    ) {
        return ExtractOutcome {
            status: ExtractStatus::Failed(ExtractFailure::MemoryGuardBlocked),
            cursor,
            input_tokens: 0,
            output_tokens: 0,
        };
    }

    let main_model = context
        .main_loop_model
        .clone()
        .unwrap_or_else(crate::utils::model::model::get_main_loop_model);
    let dedicated_model = extract_model
        .as_deref()
        .is_some_and(|model| model != main_model);
    let prompt = extraction_prompt(
        &bounded_new_message_context(&new_messages),
        &memory_index,
        dedicated_model,
    );
    let prompt_message = Message::User(UserMessage {
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
    });

    let mut fork_context = (*cache_safe_params).clone();
    let overrides = if dedicated_model {
        fork_context.fork_context_messages = Arc::new(Vec::new());
        let mut options = context.options();
        options.main_loop_model = extract_model;
        Some(SubagentContextOverrides {
            options: Some(options),
            abort_controller: Some(context.abort_controller.clone()),
            ..Default::default()
        })
    } else {
        Some(SubagentContextOverrides {
            abort_controller: Some(context.abort_controller.clone()),
            ..Default::default()
        })
    };
    let callback = extraction_tool_callback(&context, &memory_dir);
    let params = ForkedAgentParams {
        prompt_messages: vec![prompt_message],
        cache_safe_params: fork_context,
        can_use_tool: callback,
        query_source: QuerySource::ExtractMemories,
        fork_label: "extract-memories".to_string(),
        overrides,
        max_output_tokens: None,
        max_turns: Some(max_turns.max(1)),
        on_message: None,
        on_progress: None,
        skip_cache_write: true,
        skip_transcript: true,
    };

    let result = match tokio::time::timeout(timeout, run_forked_agent(params)).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let status = if crate::utils::errors::is_abort_error(&error) {
                ExtractFailure::Aborted
            } else {
                ExtractFailure::Agent(error.to_string())
            };
            return ExtractOutcome {
                status: ExtractStatus::Failed(status),
                cursor,
                input_tokens: 0,
                output_tokens: 0,
            };
        }
        Err(_) => {
            return ExtractOutcome {
                status: ExtractStatus::Failed(ExtractFailure::TimedOut),
                cursor,
                input_tokens: 0,
                output_tokens: 0,
            };
        }
    };
    let usage = result.total_usage;
    crate::cost_tracker::add_to_total_tokens(usage.input_tokens, usage.output_tokens);
    if !result.api_errors.is_empty() {
        return ExtractOutcome {
            status: ExtractStatus::Failed(ExtractFailure::Agent(
                "extraction fork returned API errors".to_string(),
            )),
            cursor,
            input_tokens: token_total(&usage),
            output_tokens: usage.output_tokens,
        };
    }
    let next_cursor = new_messages
        .last()
        .map(|message| ExtractCursor {
            message_uuid: Some(message.uuid().to_string()),
            at_ms: Some(chrono::Utc::now().timestamp_millis()),
        })
        .unwrap_or(cursor);
    ExtractOutcome {
        status: ExtractStatus::Success,
        cursor: next_cursor,
        input_tokens: token_total(&usage),
        output_tokens: usage.output_tokens,
    }
}

/// Public seam for the compaction owner. The timeout is deliberately bounded;
/// compaction proceeds after a failed/expired extraction and the cursor stays.
pub async fn extract_before_compact(
    context: ToolUseContext,
    cache_safe_params: Option<Arc<CacheSafeParams>>,
    messages: Vec<Message>,
    cursor: ExtractCursor,
    memory_index: String,
    extract_model: Option<String>,
    max_turns: u32,
    timeout_ms: u64,
) -> ExtractOutcome {
    run_extract_memories(
        context,
        cache_safe_params,
        messages,
        cursor,
        memory_index,
        extract_model,
        max_turns,
        Duration::from_millis(timeout_ms),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_requires_turn_or_token_threshold() {
        let progress = ExtractionProgress {
            turns_since_extract: 7,
            tokens_at_last_extract: 100,
            ..Default::default()
        };
        assert!(!extraction_is_due(&progress, 0, 30_000, 8, 30_000));
        assert!(extraction_is_due(&progress, 1, 30_000, 8, 30_000));
        assert!(extraction_is_due(
            &ExtractionProgress {
                turns_since_extract: 8,
                ..progress
            },
            1,
            100,
            8,
            30_000
        ));
        assert!(extraction_is_due(&progress, 1, 30_100, 8, 30_000));
    }

    #[test]
    fn cursor_slices_after_last_message_and_preserves_no_cursor_behavior() {
        let messages = vec![
            Message::User(crate::utils::messages::create_user_message(
                "one".to_string(),
            )),
            Message::User(crate::utils::messages::create_user_message(
                "two".to_string(),
            )),
        ];
        let cursor = ExtractCursor {
            message_uuid: Some(messages[0].uuid().to_string()),
            at_ms: None,
        };
        assert_eq!(messages_after_cursor(&messages, &cursor).len(), 1);
        assert_eq!(
            messages_after_cursor(&messages, &ExtractCursor::default()).len(),
            2
        );
    }
}
