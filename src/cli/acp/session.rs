//! What the ACP server needs from the agent engine. The real engine (`engine.rs`)
//! implements these; tests drive the server with a fake.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol_schema::v1::{
    AvailableCommand, AvailableCommandsUpdate, CLIENT_METHOD_NAMES, Content, ContentBlock,
    ContentChunk, CurrentModeUpdate, Diff, MessageId, SessionConfigOption, SessionId,
    SessionModeState, SessionNotification, SessionUpdate, StopReason, TextContent, ToolCall,
    ToolCallContent, ToolCallId, ToolCallLocation, ToolCallStatus, ToolCallUpdate,
    ToolCallUpdateFields, ToolKind,
};

use super::transport::Outbound;

/// Parameters for creating the one session this process serves.
pub(crate) struct NewSession {
    pub cwd: PathBuf,
    /// For `session/load`: the earlier session to replay and continue. `None` starts a
    /// new one.
    pub load: Option<String>,
}

/// How a prompt turn ended. Mirrors ACP `StopReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnEnd {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    // Not produced yet: the engine's refusals are not mapped to a turn end.
    #[allow(dead_code)]
    Refusal,
    Cancelled,
}

impl TurnEnd {
    /// The ACP stop reason reported in the `session/prompt` response.
    pub(crate) fn stop_reason(self) -> StopReason {
        match self {
            TurnEnd::EndTurn => StopReason::EndTurn,
            TurnEnd::MaxTokens => StopReason::MaxTokens,
            TurnEnd::MaxTurnRequests => StopReason::MaxTurnRequests,
            TurnEnd::Refusal => StopReason::Refusal,
            TurnEnd::Cancelled => StopReason::Cancelled,
        }
    }
}

/// Creates sessions on the engine.
pub(crate) trait AcpHost {
    /// The session type this host creates.
    type Session: AcpSession;

    /// Creates the session. `outbound` is the queue the session reports progress
    /// through; the engine wraps it in an [`UpdateSink`] once it knows the session id.
    /// Returns the session id and the session.
    fn new_session(
        &mut self,
        request: NewSession,
        outbound: Outbound,
    ) -> impl std::future::Future<Output = Result<(String, Self::Session), String>>;
}

/// Asks the turn in flight to stop; a no-op when none is running.
pub(crate) type Canceller = Arc<dyn Fn() + Send + Sync>;

/// Switches the session to the mode with the given id, failing for a mode it does not
/// offer. Callable while a prompt turn runs.
pub(crate) type ModeSwitch = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Sets config option `config_id` to `value` and returns every option as it now stands,
/// failing for an unknown option or value. Callable while a prompt turn runs.
pub(crate) type ConfigSwitch =
    Arc<dyn Fn(&str, &str) -> Result<Vec<SessionConfigOption>, String> + Send + Sync>;

/// One session on the engine.
pub(crate) trait AcpSession {
    /// Runs one prompt turn to completion. Progress goes out through the engine's
    /// [`UpdateSink`] for this session.
    fn prompt(
        &mut self,
        text: String,
    ) -> impl std::future::Future<Output = Result<TurnEnd, String>>;

    /// A handle that asks the running turn to stop. Obtained before the turn
    /// starts, because the turn borrows the session while it runs.
    fn canceller(&self) -> Canceller;

    /// A handle that runs once the input has ended. A session uses it to stop waiting
    /// for client answers, which can no longer arrive. The default does nothing.
    fn on_input_closed(&self) -> Canceller {
        Arc::new(|| {})
    }

    /// The modes the session offers and the current one, for the `session/new` response.
    /// `None` when the session has no modes.
    fn modes(&self) -> Option<SessionModeState> {
        None
    }

    /// The handle `session/set_mode` calls. `None` when the session has no modes.
    fn mode_switch(&self) -> Option<ModeSwitch> {
        None
    }

    /// The session's config options, for the `session/new` response. `None` when it has
    /// none.
    fn config_options(&self) -> Option<Vec<SessionConfigOption>> {
        None
    }

    /// The handle `session/set_config_option` calls. `None` when the session has no
    /// config options.
    fn config_switch(&self) -> Option<ConfigSwitch> {
        None
    }

    /// The slash commands a prompt may start with, announced right after `session/new`.
    /// Empty when there are none.
    fn available_commands(&self) -> Vec<AvailableCommand> {
        Vec::new()
    }
}

/// What the client is told when a tool call starts.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolCallStart {
    /// Id the agent gave the tool call. The later result refers to it.
    pub id: String,
    /// Human-readable title shown for the call.
    pub title: String,
    /// Category of the tool, used for icons and grouping.
    pub kind: ToolKind,
    /// Files the call touches.
    pub locations: Vec<PathBuf>,
    /// File change to show as a diff, as (path, old text, new text).
    pub diff: Option<(PathBuf, Option<String>, String)>,
    /// The tool's input, as the model sent it.
    pub raw_input: serde_json::Value,
}

/// Sends `session/update` notifications for one session.
#[derive(Clone)]
pub(crate) struct UpdateSink {
    outbound: Outbound,
    session_id: SessionId,
}

impl UpdateSink {
    /// Creates a sink that reports updates for `session_id` through `outbound`.
    pub(crate) fn new(outbound: Outbound, session_id: impl Into<String>) -> Self {
        Self {
            outbound,
            session_id: SessionId::new(session_id.into()),
        }
    }

    /// Emits an `agent_message_chunk` with a text content block. Chunks of one model
    /// message share its `message_id`, so the client joins them.
    pub(crate) fn agent_message(&self, text: &str, message_id: Option<&str>) {
        self.send(SessionUpdate::AgentMessageChunk(text_chunk(
            text, message_id,
        )));
    }

    /// Emits a `user_message_chunk` with a text content block, for replaying history.
    pub(crate) fn user_message(&self, text: &str, message_id: Option<&str>) {
        self.send(SessionUpdate::UserMessageChunk(text_chunk(
            text, message_id,
        )));
    }

    /// Emits an `agent_thought_chunk` with a text content block, tagged like
    /// [`UpdateSink::agent_message`].
    pub(crate) fn agent_thought(&self, text: &str, message_id: Option<&str>) {
        self.send(SessionUpdate::AgentThoughtChunk(text_chunk(
            text, message_id,
        )));
    }

    /// Emits an `available_commands_update` listing the session's slash commands.
    pub(crate) fn available_commands(&self, commands: Vec<AvailableCommand>) {
        self.send(SessionUpdate::AvailableCommandsUpdate(
            AvailableCommandsUpdate::new(commands),
        ));
    }

    /// Emits a `current_mode_update` naming the session's mode.
    pub(crate) fn current_mode(&self, mode_id: &str) {
        self.send(SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(
            mode_id.to_string(),
        )));
    }

    /// Emits a `tool_call` announcing a tool call that is now in progress.
    pub(crate) fn tool_call(&self, call: ToolCallStart) {
        let mut tool_call = ToolCall::new(ToolCallId::new(call.id), call.title)
            .kind(call.kind)
            .status(ToolCallStatus::InProgress)
            .locations(
                call.locations
                    .into_iter()
                    .map(ToolCallLocation::new)
                    .collect(),
            )
            .raw_input(Some(call.raw_input));
        if let Some((path, old_text, new_text)) = call.diff {
            let diff = Diff::new(path, new_text).old_text(old_text);
            tool_call = tool_call.content(vec![ToolCallContent::Diff(diff)]);
        }
        self.send(SessionUpdate::ToolCall(tool_call));
    }

    /// Emits a `tool_call_update` with the outcome of a tool call announced earlier.
    /// Only the changed fields are set: the status, the raw output and, when there is
    /// text, the content.
    pub(crate) fn tool_call_result(
        &self,
        id: &str,
        failed: bool,
        text: Option<String>,
        raw_output: serde_json::Value,
    ) {
        let status = if failed {
            ToolCallStatus::Failed
        } else {
            ToolCallStatus::Completed
        };
        let mut fields = ToolCallUpdateFields::new()
            .status(Some(status))
            .raw_output(Some(raw_output));
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            let block = ContentBlock::Text(TextContent::new(text));
            fields = fields.content(Some(vec![ToolCallContent::Content(Content::new(block))]));
        }
        self.send(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            ToolCallId::new(id),
            fields,
        )));
    }

    fn send(&self, update: SessionUpdate) {
        let notification = SessionNotification::new(self.session_id.clone(), update);
        match serde_json::to_value(&notification) {
            Ok(params) => self
                .outbound
                .notify(CLIENT_METHOD_NAMES.session_update, params),
            Err(err) => eprintln!("nyan acp: failed to serialize session update: {err}"),
        }
    }
}

fn text_chunk(text: &str, message_id: Option<&str>) -> ContentChunk {
    ContentChunk::new(ContentBlock::Text(TextContent::new(text)))
        .message_id(message_id.map(MessageId::new))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn acp_update_sink_emits_message_and_thought_chunks() {
        let (outbound, mut rx) = Outbound::channel();
        let sink = UpdateSink::new(outbound, "sess-9");
        sink.agent_message("hi", None);
        sink.agent_thought("hmm", Some("msg_1"));
        drop(sink);

        let message: Value = rx.try_recv().unwrap();
        assert_eq!(message["method"], json!("session/update"));
        assert_eq!(message["params"]["sessionId"], json!("sess-9"));
        assert_eq!(
            message["params"]["update"]["sessionUpdate"],
            json!("agent_message_chunk")
        );
        assert_eq!(
            message["params"]["update"]["content"],
            json!({"type": "text", "text": "hi"})
        );

        let thought: Value = rx.try_recv().unwrap();
        assert_eq!(thought["method"], json!("session/update"));
        assert_eq!(thought["params"]["sessionId"], json!("sess-9"));
        assert_eq!(
            thought["params"]["update"]["sessionUpdate"],
            json!("agent_thought_chunk")
        );
        assert_eq!(
            thought["params"]["update"]["content"],
            json!({"type": "text", "text": "hmm"})
        );
        assert_eq!(thought["params"]["update"]["messageId"], json!("msg_1"));
        assert!(message["params"]["update"].get("messageId").is_none());

        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn acp_update_sink_emits_tool_call_and_result() {
        let (outbound, mut rx) = Outbound::channel();
        let sink = UpdateSink::new(outbound, "sess-7");
        sink.tool_call(ToolCallStart {
            id: "call-1".to_string(),
            title: "Edit /src/lib.rs".to_string(),
            kind: ToolKind::Edit,
            locations: vec![PathBuf::from("/src/lib.rs")],
            diff: Some((
                PathBuf::from("/src/lib.rs"),
                Some("old".to_string()),
                "new".to_string(),
            )),
            raw_input: json!({"file_path": "/src/lib.rs"}),
        });
        sink.tool_call_result("call-1", true, Some("boom".to_string()), json!("boom"));
        drop(sink);

        let call: Value = rx.try_recv().unwrap();
        assert_eq!(call["method"], json!("session/update"));
        assert_eq!(call["params"]["sessionId"], json!("sess-7"));
        let update = &call["params"]["update"];
        assert_eq!(update["sessionUpdate"], json!("tool_call"));
        assert_eq!(update["toolCallId"], json!("call-1"));
        assert_eq!(update["title"], json!("Edit /src/lib.rs"));
        assert_eq!(update["kind"], json!("edit"));
        assert_eq!(update["status"], json!("in_progress"));
        assert_eq!(update["locations"][0]["path"], json!("/src/lib.rs"));
        assert_eq!(
            update["content"][0],
            json!({
                "type": "diff",
                "path": "/src/lib.rs",
                "oldText": "old",
                "newText": "new"
            })
        );
        assert_eq!(update["rawInput"], json!({"file_path": "/src/lib.rs"}));

        let result: Value = rx.try_recv().unwrap();
        assert_eq!(result["method"], json!("session/update"));
        assert_eq!(result["params"]["sessionId"], json!("sess-7"));
        let update = &result["params"]["update"];
        assert_eq!(update["sessionUpdate"], json!("tool_call_update"));
        assert_eq!(update["toolCallId"], json!("call-1"));
        assert_eq!(update["status"], json!("failed"));
        assert_eq!(
            update["content"][0],
            json!({"type": "content", "content": {"type": "text", "text": "boom"}})
        );
        assert_eq!(update["rawOutput"], json!("boom"));
        assert!(update.get("title").is_none());

        assert!(rx.try_recv().is_err());
    }
}
