//! The real engine behind `nyan acp`: sessions are `QueryEngine`s, prompt turns run
//! through `query_engine::ask`, and engine output goes out as ACP session updates.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use super::session::{AcpHost, AcpSession, Canceller, NewSession, TurnEnd, UpdateSink};
use super::tools::{describe_tool_call, tool_result_text};
use super::transport::Outbound;
use crate::cli::CliConfig;
use crate::query_engine::{QueryEngine, QueryEngineConfig, QueryEngineOutcome};

/// The headless configuration the engine runs with under ACP: what
/// `nyan -p --output-format stream-json --input-format stream-json --verbose`
/// parses to. ACP has no flags of its own yet.
pub(super) fn engine_cli_config() -> crate::cli::CliConfig {
    // `parse_cli_config` takes the full argv, program name first.
    let argv: Vec<String> = [
        "nyan",
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
    ]
    .iter()
    .map(|arg| (*arg).to_string())
    .collect();
    crate::cli::parse_cli_config(&argv)
}

/// The real engine behind `nyan acp`.
pub(super) struct EngineHost {
    config: CliConfig,
    launch_cwd: PathBuf,
}

impl EngineHost {
    /// Creates the host. Sessions are only allowed in `launch_cwd`, because the
    /// working directory is process-wide state.
    pub(super) fn new(config: CliConfig, launch_cwd: PathBuf) -> Self {
        Self { config, launch_cwd }
    }
}

/// One session on the real engine.
pub(super) struct EngineSession {
    engine: QueryEngine,
}

impl AcpHost for EngineHost {
    type Session = EngineSession;

    async fn new_session(
        &mut self,
        request: NewSession,
        outbound: Outbound,
    ) -> Result<(String, EngineSession), String> {
        if !same_dir(&request.cwd, &self.launch_cwd) {
            return Err(format!(
                "nyan acp serves the directory it was started in ({}); session/new asked for {}",
                self.launch_cwd.display(),
                request.cwd.display()
            ));
        }
        // Same startup order as `print::run_stream_json`.
        let workspace_trusted = crate::utils::config::check_has_trust_dialog_accepted();
        crate::main::initialize_lsp_if_trusted(workspace_trusted);
        let mcp_state =
            crate::cli::print::resolve_headless_mcp(&self.config, &self.launch_cwd).await?;

        let session_id = crate::bootstrap::state::get_session_id();
        let sink = UpdateSink::new(outbound, session_id.clone());
        let engine = QueryEngine::new(QueryEngineConfig {
            cli_config: self.config.clone(),
            schema: None,
            resume_seed: None,
            mcp_state: Some(mcp_state),
            output_sink: Some(QueryEngine::output_sink(move |value| {
                forward_engine_message(&sink, &value);
            })),
            // No permission resolver: tool calls that need approval are denied for now.
            permission_resolver: None,
            handle_elicitation: crate::tool::HandleElicitationCallback::default(),
        });
        Ok((session_id, EngineSession { engine }))
    }
}

impl AcpSession for EngineSession {
    async fn prompt(&mut self, text: String) -> Result<TurnEnd, String> {
        let outcome = crate::query_engine::ask(&mut self.engine, text, None).await?;
        turn_end(&outcome)
    }

    fn canceller(&self) -> Canceller {
        // Interrupting while no query is running is a no-op on the engine side.
        let control = self.engine.control_handle();
        Arc::new(move || control.interrupt())
    }
}

/// Whether two paths name the same directory. Both are canonicalized first; a path that
/// cannot be canonicalized is compared as given.
fn same_dir(a: &Path, b: &Path) -> bool {
    let canonical =
        |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical(a) == canonical(b)
}

/// Forwards one engine output value as ACP session updates. Assistant text becomes
/// `agent_message_chunk`, thinking becomes `agent_thought_chunk`, and a tool use becomes
/// `tool_call`. A tool result in a user message becomes `tool_call_update`. Everything
/// else is ignored for now.
fn forward_engine_message(sink: &UpdateSink, value: &Value) {
    let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            for block in blocks {
                forward_assistant_block(sink, block);
            }
        }
        Some("user") => {
            for block in blocks {
                forward_tool_result(sink, block);
            }
        }
        _ => {}
    }
}

/// Forwards one content block of an assistant message.
fn forward_assistant_block(sink: &UpdateSink, block: &Value) {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => {
            if let Some(text) = block
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                sink.agent_message(text);
            }
        }
        Some("thinking") => {
            if let Some(text) = block
                .get("thinking")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                sink.agent_thought(text);
            }
        }
        Some("tool_use") => {
            let (Some(id), Some(name)) = (
                block.get("id").and_then(Value::as_str),
                block.get("name").and_then(Value::as_str),
            ) else {
                return;
            };
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            sink.tool_call(describe_tool_call(id, name, &input));
        }
        _ => {}
    }
}

/// Forwards one content block of a user message when it is a tool result. Other blocks
/// are ignored.
fn forward_tool_result(sink: &UpdateSink, block: &Value) {
    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
        return;
    }
    let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
        return;
    };
    let failed = block
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = block.get("content").cloned().unwrap_or(Value::Null);
    sink.tool_call_result(id, failed, tool_result_text(&content), content);
}

/// Maps the engine's outcome for one turn onto an ACP turn end, or an error message when
/// the turn failed. Follows `print::finish_outcome`, with two ACP-specific differences:
/// an aborted turn is `Cancelled` and `max_turns` is `MaxTurnRequests`, not failures. The
/// aborted and max-turns checks run before the error list, because the engine records
/// "Request aborted" for an aborted turn.
fn turn_end(outcome: &QueryEngineOutcome) -> Result<TurnEnd, String> {
    if outcome.reason.starts_with("aborted_") {
        return Ok(TurnEnd::Cancelled);
    }
    if outcome.reason == "max_turns" {
        return Ok(TurnEnd::MaxTurnRequests);
    }
    let is_error = !outcome.errors.is_empty()
        || matches!(
            outcome.reason.as_str(),
            "model_error" | "prompt_too_long" | "input_error" | "max_budget_usd"
        );
    if is_error {
        let message = if outcome.errors.is_empty() {
            outcome.reason.clone()
        } else {
            outcome.errors.join("; ")
        };
        return Err(message);
    }
    // The engine keeps the stop reason in snake_case, as the API reports it.
    if outcome.stop_reason.as_deref() == Some("max_tokens") {
        return Ok(TurnEnd::MaxTokens);
    }
    Ok(TurnEnd::EndTurn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn outcome(reason: &str, stop_reason: Option<&str>, errors: &[&str]) -> QueryEngineOutcome {
        // `carry` is private to `query_engine`, so the outcome is built by assignment.
        let mut outcome = QueryEngineOutcome::default();
        outcome.reason = reason.to_string();
        outcome.stop_reason = stop_reason.map(str::to_string);
        outcome.errors = errors.iter().map(|error| error.to_string()).collect();
        outcome
    }

    #[test]
    fn acp_engine_cli_config_is_headless_stream_json() {
        let config = engine_cli_config();
        assert!(config.print);
        assert_eq!(config.output_format.as_deref(), Some("stream-json"));
        assert_eq!(config.input_format.as_deref(), Some("stream-json"));
        assert!(config.unimplemented_reasons().is_empty());
    }

    #[test]
    fn acp_same_dir_compares_canonical_paths() {
        let root = crate::utils::node_os::tmpdir()
            .join(format!("nyan-acp-same-dir-{}", uuid::Uuid::new_v4()));
        let dir = root.join("a");
        let other = root.join("b");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        assert!(same_dir(&dir, &dir));
        assert!(same_dir(&dir, &dir.join(".")));
        assert!(same_dir(&dir, Path::new(&format!("{}/", dir.display()))));
        assert!(!same_dir(&dir, &other));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn acp_forward_engine_message_maps_text_and_thinking() {
        let (outbound, mut rx) = Outbound::channel();
        let sink = UpdateSink::new(outbound, "sess-1");
        forward_engine_message(
            &sink,
            &json!({
                "type": "assistant",
                "message": {"content": [
                    {"type": "text", "text": "hi"},
                    {"type": "thinking", "thinking": "hmm", "signature": "sig"},
                    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}},
                    {"type": "text", "text": ""},
                ]},
            }),
        );
        forward_engine_message(
            &sink,
            &json!({"type": "user", "message": {"content": [{"type": "text", "text": "x"}]}}),
        );
        forward_engine_message(&sink, &json!({"type": "system", "subtype": "init"}));
        forward_engine_message(&sink, &json!({"type": "result", "result": "done"}));
        drop(sink);

        let message: Value = rx.try_recv().unwrap();
        assert_eq!(message["params"]["sessionId"], json!("sess-1"));
        assert_eq!(
            message["params"]["update"]["sessionUpdate"],
            json!("agent_message_chunk")
        );
        assert_eq!(
            message["params"]["update"]["content"],
            json!({"type": "text", "text": "hi"})
        );

        let thought: Value = rx.try_recv().unwrap();
        assert_eq!(
            thought["params"]["update"]["sessionUpdate"],
            json!("agent_thought_chunk")
        );
        assert_eq!(
            thought["params"]["update"]["content"],
            json!({"type": "text", "text": "hmm"})
        );

        // The tool_use block announces a tool call; the empty text block after it is skipped.
        let tool: Value = rx.try_recv().unwrap();
        assert_eq!(
            tool["params"]["update"]["sessionUpdate"],
            json!("tool_call")
        );
        assert_eq!(tool["params"]["update"]["toolCallId"], json!("t1"));
        assert_eq!(tool["params"]["update"]["title"], json!("Bash"));
        assert_eq!(tool["params"]["update"]["kind"], json!("execute"));

        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn acp_forward_engine_message_maps_tool_use_and_tool_result() {
        let (outbound, mut rx) = Outbound::channel();
        let sink = UpdateSink::new(outbound, "sess-2");
        forward_engine_message(
            &sink,
            &json!({
                "type": "assistant",
                "message": {"content": [
                    {"type": "text", "text": "reading"},
                    {"type": "tool_use", "id": "toolu_1", "name": "Read",
                     "input": {"file_path": "/a.txt"}},
                ]},
            }),
        );
        forward_engine_message(
            &sink,
            &json!({
                "type": "user",
                "message": {"content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1",
                     "content": "nope", "is_error": true},
                ]},
            }),
        );
        forward_engine_message(
            &sink,
            &json!({"type": "user", "message": {"content": "plain string"}}),
        );
        drop(sink);

        let message: Value = rx.try_recv().unwrap();
        assert_eq!(
            message["params"]["update"]["sessionUpdate"],
            json!("agent_message_chunk")
        );

        let call: Value = rx.try_recv().unwrap();
        assert_eq!(call["params"]["sessionId"], json!("sess-2"));
        assert_eq!(
            call["params"]["update"]["sessionUpdate"],
            json!("tool_call")
        );
        assert_eq!(call["params"]["update"]["toolCallId"], json!("toolu_1"));
        assert_eq!(call["params"]["update"]["title"], json!("Read /a.txt"));
        assert_eq!(call["params"]["update"]["kind"], json!("read"));
        assert_eq!(call["params"]["update"]["status"], json!("in_progress"));

        let update: Value = rx.try_recv().unwrap();
        assert_eq!(
            update["params"]["update"]["sessionUpdate"],
            json!("tool_call_update")
        );
        assert_eq!(update["params"]["update"]["toolCallId"], json!("toolu_1"));
        assert_eq!(update["params"]["update"]["status"], json!("failed"));
        assert_eq!(
            update["params"]["update"]["content"][0]["content"]["text"],
            json!("nope")
        );

        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn acp_turn_end_maps_engine_outcomes() {
        assert_eq!(
            turn_end(&outcome("completed", Some("end_turn"), &[])),
            Ok(TurnEnd::EndTurn)
        );
        assert_eq!(
            turn_end(&outcome("completed", Some("max_tokens"), &[])),
            Ok(TurnEnd::MaxTokens)
        );
        assert_eq!(
            turn_end(&outcome("max_turns", None, &[])),
            Ok(TurnEnd::MaxTurnRequests)
        );
        assert_eq!(
            turn_end(&outcome("aborted_streaming", None, &["Request aborted"])),
            Ok(TurnEnd::Cancelled)
        );
        assert_eq!(
            turn_end(&outcome("model_error", None, &["boom", "bad"])),
            Err("boom; bad".to_string())
        );
        assert_eq!(
            turn_end(&outcome("input_error", None, &[])),
            Err("input_error".to_string())
        );
    }
}
