//! What the ACP server needs from the agent engine. The real engine (`engine.rs`)
//! implements these; tests drive the server with a fake.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol_schema::v1::{
    CLIENT_METHOD_NAMES, ContentBlock, ContentChunk, SessionId, SessionNotification, SessionUpdate,
    StopReason, TextContent,
};

use super::transport::Outbound;

/// Parameters for creating the one session this process serves.
pub(crate) struct NewSession {
    pub cwd: PathBuf,
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

    /// Emits an `agent_message_chunk` with a text content block.
    pub(crate) fn agent_message(&self, text: &str) {
        self.send(SessionUpdate::AgentMessageChunk(text_chunk(text)));
    }

    /// Emits an `agent_thought_chunk` with a text content block.
    pub(crate) fn agent_thought(&self, text: &str) {
        self.send(SessionUpdate::AgentThoughtChunk(text_chunk(text)));
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

fn text_chunk(text: &str) -> ContentChunk {
    ContentChunk::new(ContentBlock::Text(TextContent::new(text)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn acp_update_sink_emits_message_and_thought_chunks() {
        let (outbound, mut rx) = Outbound::channel();
        let sink = UpdateSink::new(outbound, "sess-9");
        sink.agent_message("hi");
        sink.agent_thought("hmm");
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

        assert!(rx.try_recv().is_err());
    }
}
