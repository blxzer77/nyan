//! ACP request dispatch: `initialize`, `session/new`, `session/load`, `session/list`,
//! `session/prompt`, `session/set_mode` and `session/set_config_option`, plus the
//! `session/cancel` notification while a prompt is running.
//! Other requests get Method not found. Responses to requests the agent sent
//! (`session/request_permission`) are routed back to them.

use agent_client_protocol_schema::ProtocolVersion;
use agent_client_protocol_schema::v1::{
    AGENT_METHOD_NAMES, AgentCapabilities, CancelNotification, ContentBlock, Implementation,
    InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse,
    NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, SessionCapabilities,
    SessionId, SessionListCapabilities, SetSessionConfigOptionRequest,
    SetSessionConfigOptionResponse, SetSessionModeRequest, SetSessionModeResponse,
};
use serde::Serialize;
use serde_json::Value;
use std::pin::pin;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, Lines};

use super::session::{
    AcpHost, AcpSession, Canceller, ConfigSwitch, ModeSwitch, NewSession, UpdateSink,
};
use super::transport::{
    INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, Incoming, METHOD_NOT_FOUND, Outbound,
    RpcError, parse_line, write_loop,
};
use crate::constants::product::VERSION;

/// Error code for a request that arrives while a prompt turn is still running.
pub(crate) const BUSY: i64 = -32000;

/// Reads and handles ACP messages line by line. Returns 0 on end of input and 1 on a
/// read failure. Output is written by a separate task that finishes once every queued
/// message is out, so the exit code is always the input loop's.
pub(crate) async fn serve<R, W, H>(reader: R, writer: W, host: H) -> i32
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    H: AcpHost,
{
    let (outbound, rx) = Outbound::channel();
    // A write error means the client went away. It does not change the exit code.
    let (code, _written) = tokio::join!(run_input(reader, host, outbound), write_loop(rx, writer));
    code
}

/// The input loop. It owns the host, the session and the outbound queue; when it
/// returns they are all dropped, which lets the writer drain and finish.
async fn run_input<R, H>(reader: R, mut host: H, outbound: Outbound) -> i32
where
    R: AsyncBufRead + Unpin,
    H: AcpHost,
{
    let mut lines = reader.lines();
    let mut session: Option<(String, H::Session)> = None;
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => {
                end_input(
                    &outbound,
                    session.as_ref().map(|(_, active)| active.on_input_closed()),
                );
                return 0;
            }
            Err(err) => {
                eprintln!("nyan acp: failed to read stdin: {err}");
                end_input(
                    &outbound,
                    session.as_ref().map(|(_, active)| active.on_input_closed()),
                );
                return 1;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match parse_line(&line) {
            Ok(Incoming::Request { id, method, params })
                if method == AGENT_METHOD_NAMES.session_prompt =>
            {
                if let Some(code) =
                    handle_prompt(&mut lines, &outbound, &mut session, id, params).await
                {
                    return code;
                }
            }
            Ok(Incoming::Request { id, method, params }) => {
                handle_request(&mut host, &outbound, &mut session, id, &method, params).await;
            }
            Ok(Incoming::Response { id, result }) => outbound.resolve(&id, result),
            Ok(Incoming::Notification { .. }) => {}
            Err(error) => outbound.respond_error(Value::Null, error),
        }
    }
}

/// Dispatches every request except `session/prompt`, which needs the input reader.
async fn handle_request<H: AcpHost>(
    host: &mut H,
    outbound: &Outbound,
    session: &mut Option<(String, H::Session)>,
    id: Value,
    method: &str,
    params: Value,
) {
    if method == AGENT_METHOD_NAMES.initialize {
        handle_initialize(outbound, id, params);
    } else if method == AGENT_METHOD_NAMES.session_new || method == AGENT_METHOD_NAMES.session_load
    {
        let load = method == AGENT_METHOD_NAMES.session_load;
        handle_open_session(host, outbound, session, id, params, load).await;
    } else if method == AGENT_METHOD_NAMES.session_list {
        respond(outbound, id, super::history::list_sessions_result(params));
    } else if method == AGENT_METHOD_NAMES.session_set_mode {
        let current = session
            .as_ref()
            .map(|(session_id, active)| (session_id.as_str(), active.mode_switch()));
        respond(outbound, id, set_mode(params, current));
    } else if method == AGENT_METHOD_NAMES.session_set_config_option {
        let current = session
            .as_ref()
            .map(|(session_id, active)| (session_id.as_str(), active.config_switch()));
        respond(outbound, id, set_config_option(params, current));
    } else {
        let error = RpcError::new(METHOD_NOT_FOUND, format!("Method not found: {method}"));
        outbound.respond_error(id, error);
    }
}

fn handle_initialize(outbound: &Outbound, id: Value, params: Value) {
    match initialize_result(params) {
        Ok(result) => outbound.respond(id, result),
        Err(error) => outbound.respond_error(id, error),
    }
}

/// The reply to `initialize`. It needs no session, so the phase before the first
/// session (see `startup`) answers with it too.
pub(super) fn initialize_result(params: Value) -> Result<Value, RpcError> {
    if let Err(err) = serde_json::from_value::<InitializeRequest>(params) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("Invalid params: {err}"),
        ));
    }
    let response = InitializeResponse::new(ProtocolVersion::V1)
        .agent_capabilities(
            AgentCapabilities::new()
                .load_session(true)
                .session_capabilities(
                    SessionCapabilities::new().list(SessionListCapabilities::new()),
                ),
        )
        .agent_info(Implementation::new("nyan", VERSION));
    serde_json::to_value(response)
        .map_err(|err| RpcError::new(INTERNAL_ERROR, format!("Internal error: {err}")))
}

/// Handles `session/new`, or `session/load` when `load` is set. A load replays the earlier
/// session's history as session updates before it is answered.
async fn handle_open_session<H: AcpHost>(
    host: &mut H,
    outbound: &Outbound,
    session: &mut Option<(String, H::Session)>,
    id: Value,
    params: Value,
    load: bool,
) {
    let parsed = if load {
        serde_json::from_value::<LoadSessionRequest>(params).map(|request| NewSession {
            cwd: request.cwd,
            load: Some(request.session_id.0.to_string()),
        })
    } else {
        serde_json::from_value::<NewSessionRequest>(params).map(|request| NewSession {
            cwd: request.cwd,
            load: None,
        })
    };
    let request = match parsed {
        Ok(request) => request,
        Err(err) => {
            let error = RpcError::new(INVALID_PARAMS, format!("Invalid params: {err}"));
            outbound.respond_error(id, error);
            return;
        }
    };
    if session.is_some() {
        let error = RpcError::new(INVALID_REQUEST, "nyan acp serves one session per process");
        outbound.respond_error(id, error);
        return;
    }
    // `mcpServers` is ignored for now.
    match host.new_session(request, outbound.clone()).await {
        Ok((session_id, active)) => {
            if load {
                reply(
                    outbound,
                    id,
                    LoadSessionResponse::new()
                        .modes(active.modes())
                        .config_options(active.config_options()),
                );
            } else {
                reply(
                    outbound,
                    id,
                    NewSessionResponse::new(SessionId::new(session_id.as_str()))
                        .modes(active.modes())
                        .config_options(active.config_options()),
                );
            }
            // Announced after the response, so the client knows the session id.
            let commands = active.available_commands();
            if !commands.is_empty() {
                UpdateSink::new(outbound.clone(), session_id.as_str()).available_commands(commands);
            }
            *session = Some((session_id, active));
        }
        Err(msg) => outbound.respond_error(id, RpcError::new(INTERNAL_ERROR, msg)),
    }
}

/// Handles `session/prompt`. Returns `Some(code)` when input ended during the turn; the
/// caller then exits with that code after the turn has responded.
async fn handle_prompt<R, S>(
    lines: &mut Lines<R>,
    outbound: &Outbound,
    session: &mut Option<(String, S)>,
    id: Value,
    params: Value,
) -> Option<i32>
where
    R: AsyncBufRead + Unpin,
    S: AcpSession,
{
    let request = match serde_json::from_value::<PromptRequest>(params) {
        Ok(request) => request,
        Err(err) => {
            let error = RpcError::new(INVALID_PARAMS, format!("Invalid params: {err}"));
            outbound.respond_error(id, error);
            return None;
        }
    };
    let active = match session.as_mut() {
        Some((session_id, active)) if session_id.as_str() == &*request.session_id.0 => active,
        _ => {
            let message = format!("Unknown session: {}", request.session_id.0);
            outbound.respond_error(id, RpcError::new(INVALID_PARAMS, message));
            return None;
        }
    };
    let text = match prompt_text(&request.prompt) {
        Ok(text) => text,
        Err(error) => {
            outbound.respond_error(id, error);
            return None;
        }
    };
    run_turn(lines, outbound, active, &request.session_id.0, id, text).await
}

/// Runs one prompt turn while still reading input. A `session/cancel` for `session_id` asks
/// the turn to stop; the turn then answers with its own stop reason. Requests read during the
/// turn get a busy error; responses go to the requests they answer, and other notifications
/// are ignored. When input ends or
/// fails, reading stops, the turn still runs to completion and is answered, and `Some(code)`
/// is returned.
async fn run_turn<R, S>(
    lines: &mut Lines<R>,
    outbound: &Outbound,
    session: &mut S,
    session_id: &str,
    id: Value,
    text: String,
) -> Option<i32>
where
    R: AsyncBufRead + Unpin,
    S: AcpSession,
{
    let mut input_ended: Option<i32> = None;
    // Taken before the turn starts, because the turn borrows the session while it runs.
    let cancel = session.canceller();
    let on_input_closed = session.on_input_closed();
    let switches = Switches {
        mode: session.mode_switch(),
        config: session.config_switch(),
    };
    let turn = session.prompt(text);
    let mut turn = pin!(turn);
    loop {
        tokio::select! {
            // The turn is polled first, so a request it sends is registered before any
            // line that answers it is read.
            biased;
            result = &mut turn => {
                match result {
                    Ok(end) => reply(outbound, id, PromptResponse::new(end.stop_reason())),
                    Err(msg) => outbound.respond_error(id, RpcError::new(INTERNAL_ERROR, msg)),
                }
                return input_ended;
            }
            line = lines.next_line(), if input_ended.is_none() => match line {
                Ok(Some(line)) => {
                    handle_line_during_turn(outbound, &line, session_id, &cancel, &switches)
                }
                Ok(None) => {
                    end_input(outbound, Some(on_input_closed.clone()));
                    input_ended = Some(0);
                }
                Err(err) => {
                    eprintln!("nyan acp: failed to read stdin: {err}");
                    end_input(outbound, Some(on_input_closed.clone()));
                    input_ended = Some(1);
                }
            },
        }
    }
}

/// Runs when stdin ends or fails. The session is told the input is closed first, so it
/// stops waiting for answers. Then every request still waiting for the client fails, since
/// the client can no longer answer.
fn end_input(outbound: &Outbound, on_input_closed: Option<Canceller>) {
    if let Some(on_input_closed) = on_input_closed {
        on_input_closed();
    }
    outbound.fail_all(RpcError::new(INTERNAL_ERROR, "input closed"));
}

/// Handles one line read while a prompt turn is running. A `session/cancel` naming
/// `session_id` calls `cancel`; one naming another session, or with params that do not
/// parse, is ignored. A `session/set_mode` or `session/set_config_option` is handled, for
/// the next turn. Any other request gets a busy error. A response goes to the request it
/// answers. Other notifications are ignored, and a line that is not valid JSON-RPC gets a
/// parse error.
fn handle_line_during_turn(
    outbound: &Outbound,
    line: &str,
    session_id: &str,
    cancel: &Canceller,
    switches: &Switches,
) {
    if line.trim().is_empty() {
        return;
    }
    match parse_line(line) {
        Ok(Incoming::Request { id, method, params })
            if method == AGENT_METHOD_NAMES.session_set_mode =>
        {
            let result = set_mode(params, Some((session_id, switches.mode.clone())));
            respond(outbound, id, result);
        }
        Ok(Incoming::Request { id, method, params })
            if method == AGENT_METHOD_NAMES.session_set_config_option =>
        {
            let result = set_config_option(params, Some((session_id, switches.config.clone())));
            respond(outbound, id, result);
        }
        Ok(Incoming::Request { id, .. }) => {
            outbound.respond_error(id, RpcError::new(BUSY, "A prompt is already in progress"));
        }
        Ok(Incoming::Notification { method, params })
            if method == AGENT_METHOD_NAMES.session_cancel =>
        {
            if cancel_names_session(params, session_id) {
                cancel();
            }
        }
        Ok(Incoming::Response { id, result }) => outbound.resolve(&id, result),
        Ok(Incoming::Notification { .. }) => {}
        Err(error) => outbound.respond_error(Value::Null, error),
    }
}

/// Handles `session/set_mode`. `current` is the open session's id and mode switch, if a
/// session is open.
fn set_mode(params: Value, current: Option<(&str, Option<ModeSwitch>)>) -> Result<Value, RpcError> {
    let request = serde_json::from_value::<SetSessionModeRequest>(params)
        .map_err(|err| RpcError::new(INVALID_PARAMS, format!("Invalid params: {err}")))?;
    let switch = match current {
        Some((session_id, switch)) if session_id == &*request.session_id.0 => switch,
        _ => {
            let message = format!("Unknown session: {}", request.session_id.0);
            return Err(RpcError::new(INVALID_PARAMS, message));
        }
    };
    let Some(switch) = switch else {
        return Err(RpcError::new(
            METHOD_NOT_FOUND,
            "Method not found: session/set_mode",
        ));
    };
    switch(&request.mode_id.0).map_err(|message| RpcError::new(INVALID_PARAMS, message))?;
    serde_json::to_value(SetSessionModeResponse::new())
        .map_err(|err| RpcError::new(INTERNAL_ERROR, format!("Internal error: {err}")))
}

/// The session's switch handles, taken before a turn borrows the session.
struct Switches {
    mode: Option<ModeSwitch>,
    config: Option<ConfigSwitch>,
}

/// Handles `session/set_config_option`. `current` is the open session's id and config
/// switch, if a session is open.
fn set_config_option(
    params: Value,
    current: Option<(&str, Option<ConfigSwitch>)>,
) -> Result<Value, RpcError> {
    let request = serde_json::from_value::<SetSessionConfigOptionRequest>(params)
        .map_err(|err| RpcError::new(INVALID_PARAMS, format!("Invalid params: {err}")))?;
    let switch = match current {
        Some((session_id, switch)) if session_id == &*request.session_id.0 => switch,
        _ => {
            let message = format!("Unknown session: {}", request.session_id.0);
            return Err(RpcError::new(INVALID_PARAMS, message));
        }
    };
    let Some(switch) = switch else {
        return Err(RpcError::new(
            METHOD_NOT_FOUND,
            "Method not found: session/set_config_option",
        ));
    };
    let Some(value) = request.value.as_value_id() else {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "Config option values are value ids",
        ));
    };
    let options = switch(&request.config_id.0, &value.0)
        .map_err(|message| RpcError::new(INVALID_PARAMS, message))?;
    serde_json::to_value(SetSessionConfigOptionResponse::new(options))
        .map_err(|err| RpcError::new(INTERNAL_ERROR, format!("Internal error: {err}")))
}

/// Sends `result` as the response to request `id`.
fn respond(outbound: &Outbound, id: Value, result: Result<Value, RpcError>) {
    match result {
        Ok(result) => outbound.respond(id, result),
        Err(error) => outbound.respond_error(id, error),
    }
}

/// Whether the params of a `session/cancel` notification parse and name `session_id`.
fn cancel_names_session(params: Value, session_id: &str) -> bool {
    serde_json::from_value::<CancelNotification>(params)
        .is_ok_and(|cancel| &*cancel.session_id.0 == session_id)
}

/// Flattens prompt content blocks into one string. Text blocks contribute their text and
/// resource links their URI; blocks are joined with newlines. Any other block is rejected.
pub(crate) fn prompt_text(blocks: &[ContentBlock]) -> Result<String, RpcError> {
    let mut parts: Vec<&str> = Vec::with_capacity(blocks.len());
    for block in blocks {
        match block {
            ContentBlock::Text(text) => parts.push(&text.text),
            ContentBlock::ResourceLink(link) => parts.push(&link.uri),
            _ => {
                return Err(RpcError::new(
                    INVALID_PARAMS,
                    "Unsupported content block in prompt",
                ));
            }
        }
    }
    Ok(parts.join("\n"))
}

/// Queues `response` as the result of request `id`.
fn reply<T: Serialize>(outbound: &Outbound, id: Value, response: T) {
    match serde_json::to_value(response) {
        Ok(result) => outbound.respond(id, result),
        Err(err) => {
            let error = RpcError::new(INTERNAL_ERROR, format!("Internal error: {err}"));
            outbound.respond_error(id, error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::acp::session::{Canceller, TurnEnd, UpdateSink};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::Notify;

    /// Scripted engine. Records every prompt, streams `chunks` as message chunks, then
    /// ends the turn with `end` (default `EndTurn`) or fails with `fail_prompt`.
    #[derive(Clone, Default)]
    struct FakeHost {
        /// Prompts received, in order.
        prompts: Arc<Mutex<Vec<String>>>,
        /// Chunks each prompt emits before finishing.
        chunks: Vec<&'static str>,
        /// When set, `new_session` fails with this message.
        fail_new_session: Option<&'static str>,
        /// When set, `prompt` fails with this message.
        fail_prompt: Option<&'static str>,
        /// Delay before a prompt finishes, to keep it in flight.
        delay: Option<Duration>,
        end: Option<TurnEnd>,
        /// When set, a prompt waits after its chunks until it is cancelled (or times out).
        wait_for_cancel: bool,
        /// Number of cancel requests the session has received.
        cancels: Arc<AtomicUsize>,
        /// Set by the canceller before it wakes a waiting turn.
        cancelled: Arc<AtomicBool>,
        /// Wakes a turn waiting for cancellation.
        cancel_signal: Arc<Notify>,
        /// When set, a prompt asks the client for permission first and waits for the answer.
        ask_permission: bool,
        /// Answers the session received to its permission request, in order.
        answers: Arc<Mutex<Vec<Result<Value, RpcError>>>>,
        /// When set, the session offers modes `default` and `plan`, and records each mode
        /// it is switched to here. Any other mode is refused.
        modes: Option<Arc<Mutex<Vec<String>>>>,
        /// When set, the session has a `model` option (`a` or `b`) and records each
        /// (option, value) it is set to here. Anything else is refused.
        config: Option<Arc<Mutex<Vec<(String, String)>>>>,
        /// Slash commands the session announces, as (name, description).
        commands: Vec<(&'static str, &'static str)>,
    }

    struct FakeSession {
        config: FakeHost,
        updates: UpdateSink,
        outbound: Outbound,
    }

    impl AcpHost for FakeHost {
        type Session = FakeSession;

        async fn new_session(
            &mut self,
            _request: NewSession,
            outbound: Outbound,
        ) -> Result<(String, FakeSession), String> {
            if let Some(msg) = self.fail_new_session {
                return Err(msg.to_string());
            }
            let session = FakeSession {
                config: self.clone(),
                updates: UpdateSink::new(outbound.clone(), "sess-1"),
                outbound,
            };
            Ok(("sess-1".to_string(), session))
        }
    }

    impl AcpSession for FakeSession {
        async fn prompt(&mut self, text: String) -> Result<TurnEnd, String> {
            if self.config.ask_permission {
                let (answer_tx, answer_rx) = tokio::sync::oneshot::channel();
                self.outbound.request(
                    "session/request_permission",
                    json!({"sessionId": "sess-1"}),
                    Box::new(move |answer| {
                        let _ = answer_tx.send(answer);
                    }),
                );
                let answer = match tokio::time::timeout(Duration::from_secs(5), answer_rx).await {
                    Ok(Ok(answer)) => answer,
                    _ => return Err("permission answer never arrived".to_string()),
                };
                self.config.answers.lock().unwrap().push(answer);
            }
            self.config.prompts.lock().unwrap().push(text);
            for chunk in &self.config.chunks {
                self.updates.agent_message(chunk, None);
            }
            if let Some(delay) = self.config.delay {
                tokio::time::sleep(delay).await;
            }
            if self.config.wait_for_cancel {
                let cancelled = self.config.cancelled.clone();
                let signal = self.config.cancel_signal.clone();
                let wait = async move {
                    // The flag is checked before every wait, so a cancel that fired
                    // earlier is not missed.
                    while !cancelled.load(Ordering::SeqCst) {
                        signal.notified().await;
                    }
                };
                if tokio::time::timeout(Duration::from_secs(5), wait)
                    .await
                    .is_err()
                {
                    return Err("fake turn was never cancelled".to_string());
                }
                return Ok(TurnEnd::Cancelled);
            }
            match self.config.fail_prompt {
                Some(msg) => Err(msg.to_string()),
                None => Ok(self.config.end.unwrap_or(TurnEnd::EndTurn)),
            }
        }

        fn modes(&self) -> Option<agent_client_protocol_schema::v1::SessionModeState> {
            use agent_client_protocol_schema::v1::{SessionMode, SessionModeState};
            self.config.modes.as_ref().map(|_| {
                SessionModeState::new(
                    "default",
                    vec![
                        SessionMode::new("default", "Default"),
                        SessionMode::new("plan", "Plan"),
                    ],
                )
            })
        }

        fn config_options(
            &self,
        ) -> Option<Vec<agent_client_protocol_schema::v1::SessionConfigOption>> {
            let set = self.config.config.as_ref()?;
            let current = set
                .lock()
                .unwrap()
                .last()
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| "a".to_string());
            Some(fake_model_option(&current))
        }

        fn available_commands(&self) -> Vec<agent_client_protocol_schema::v1::AvailableCommand> {
            self.config
                .commands
                .iter()
                .map(|(name, description)| {
                    agent_client_protocol_schema::v1::AvailableCommand::new(*name, *description)
                })
                .collect()
        }

        fn config_switch(&self) -> Option<ConfigSwitch> {
            let set = self.config.config.clone()?;
            Some(Arc::new(move |config_id: &str, value: &str| {
                if config_id != "model" || (value != "a" && value != "b") {
                    return Err(format!("Unknown value {value} for {config_id}"));
                }
                set.lock()
                    .unwrap()
                    .push((config_id.to_string(), value.to_string()));
                Ok(fake_model_option(value))
            }))
        }

        fn mode_switch(&self) -> Option<ModeSwitch> {
            let switched = self.config.modes.clone()?;
            Some(Arc::new(move |id: &str| {
                if id != "default" && id != "plan" {
                    return Err(format!("Unknown mode: {id}"));
                }
                switched.lock().unwrap().push(id.to_string());
                Ok(())
            }))
        }

        fn canceller(&self) -> Canceller {
            let cancels = self.config.cancels.clone();
            let cancelled = self.config.cancelled.clone();
            let signal = self.config.cancel_signal.clone();
            Arc::new(move || {
                cancels.fetch_add(1, Ordering::SeqCst);
                cancelled.store(true, Ordering::SeqCst);
                signal.notify_one();
            })
        }
    }

    fn request(id: u64, method: &str, params: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    }

    fn initialize() -> Value {
        request(
            1,
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}}),
        )
    }

    fn new_session(id: u64) -> Value {
        request(id, "session/new", json!({"cwd": "/tmp", "mcpServers": []}))
    }

    fn prompt(id: u64, session_id: &str, text: &str) -> Value {
        request(
            id,
            "session/prompt",
            json!({"sessionId": session_id, "prompt": [{"type": "text", "text": text}]}),
        )
    }

    /// Joins messages into newline-terminated input.
    fn input(messages: &[Value]) -> String {
        messages.iter().map(|m| format!("{m}\n")).collect()
    }

    /// Runs serve once on the given input, returning the exit code and each output line as JSON.
    async fn run_session(input: &str) -> (i32, Vec<Value>) {
        run_with(input, FakeHost::default()).await
    }

    async fn run_with(input: &str, host: FakeHost) -> (i32, Vec<Value>) {
        let mut out: Vec<u8> = Vec::new();
        let code = serve(tokio::io::BufReader::new(input.as_bytes()), &mut out, host).await;
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        (code, lines)
    }

    #[tokio::test]
    async fn acp_initialize_returns_protocol_version_and_agent_info() {
        let (code, lines) = run_session(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}\n",
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["id"], json!(1));
        assert_eq!(lines[0]["result"]["protocolVersion"], json!(1));
        assert_eq!(lines[0]["result"]["agentInfo"]["name"], json!("nyan"));
        assert_eq!(lines[0]["result"]["agentInfo"]["version"], json!(VERSION));
    }

    #[tokio::test]
    async fn acp_unknown_method_returns_method_not_found() {
        // `session/delete` is not implemented, so it stands in for an unknown method.
        let (code, lines) = run_session(
            "{\"jsonrpc\":\"2.0\",\"id\":\"req-7\",\"method\":\"session/delete\",\"params\":{\"sessionId\":\"s1\"}}\n",
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["error"]["code"], json!(-32601));
        assert_eq!(lines[0]["id"], json!("req-7"));
    }

    #[tokio::test]
    async fn acp_malformed_line_gets_parse_error_then_continues() {
        let (code, lines) = run_session(
            "not json\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}\n",
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["error"]["code"], json!(-32700));
        assert_eq!(lines[0]["id"], Value::Null);
        assert_eq!(lines[1]["id"], json!(1));
        assert_eq!(lines[1]["result"]["protocolVersion"], json!(1));
    }

    #[tokio::test]
    async fn acp_eof_exits_cleanly() {
        let (code, lines) = run_session("").await;
        assert_eq!(code, 0);
        assert!(lines.is_empty());

        // Whitespace-only lines also produce no output.
        let (code, lines) = run_session("\n   \n").await;
        assert_eq!(code, 0);
        assert!(lines.is_empty());
    }

    #[tokio::test]
    async fn acp_session_new_returns_session_id() {
        let (code, lines) = run_session(&input(&[initialize(), new_session(2)])).await;
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["id"], json!(2));
        assert_eq!(lines[1]["result"]["sessionId"], json!("sess-1"));
    }

    #[tokio::test]
    async fn acp_prompt_streams_chunks_then_responds() {
        let host = FakeHost {
            chunks: vec!["Hello", " world"],
            ..Default::default()
        };
        let prompts = host.prompts.clone();
        let (code, lines) = run_with(
            &input(&[initialize(), new_session(2), prompt(3, "sess-1", "hi")]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 5);

        for (index, text) in [(2, "Hello"), (3, " world")] {
            let note = &lines[index];
            assert_eq!(note["method"], json!("session/update"));
            assert_eq!(note["params"]["sessionId"], json!("sess-1"));
            assert_eq!(
                note["params"]["update"]["sessionUpdate"],
                json!("agent_message_chunk")
            );
            assert_eq!(note["params"]["update"]["content"]["text"], json!(text));
        }

        assert_eq!(lines[4]["id"], json!(3));
        assert_eq!(lines[4]["result"]["stopReason"], json!("end_turn"));
        assert_eq!(*prompts.lock().unwrap(), vec!["hi".to_string()]);
    }

    #[tokio::test]
    async fn acp_second_session_new_is_rejected() {
        let (code, lines) =
            run_session(&input(&[initialize(), new_session(2), new_session(3)])).await;
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2]["id"], json!(3));
        assert_eq!(lines[2]["error"]["code"], json!(-32600));
    }

    #[tokio::test]
    async fn acp_prompt_with_unknown_session_is_rejected() {
        let (code, lines) = run_session(&input(&[
            initialize(),
            new_session(2),
            prompt(3, "other", "hi"),
        ]))
        .await;
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2]["error"]["code"], json!(-32602));
        assert_eq!(
            lines[2]["error"]["message"],
            json!("Unknown session: other")
        );
    }

    #[tokio::test]
    async fn acp_prompt_before_session_new_is_rejected() {
        let (code, lines) = run_session(&input(&[initialize(), prompt(2, "sess-1", "hi")])).await;
        assert_eq!(code, 0);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["error"]["code"], json!(-32602));
    }

    #[test]
    fn acp_prompt_text_joins_text_and_resource_links() {
        let blocks: Vec<ContentBlock> = serde_json::from_value(json!([
            {"type": "text", "text": "look"},
            {"type": "resource_link", "name": "a.rs", "uri": "file:///a.rs"}
        ]))
        .unwrap();
        assert_eq!(prompt_text(&blocks).unwrap(), "look\nfile:///a.rs");

        let image: Vec<ContentBlock> = serde_json::from_value(json!([
            {"type": "image", "data": "AAAA", "mimeType": "image/png"}
        ]))
        .unwrap();
        assert_eq!(prompt_text(&image).unwrap_err().code, INVALID_PARAMS);
    }

    #[tokio::test]
    async fn acp_host_errors_become_internal_errors() {
        let host = FakeHost {
            fail_new_session: Some("boom"),
            ..Default::default()
        };
        let (code, lines) = run_with(&input(&[initialize(), new_session(2)]), host).await;
        assert_eq!(code, 0);
        assert_eq!(lines[1]["error"]["code"], json!(-32603));
        assert_eq!(lines[1]["error"]["message"], json!("boom"));

        let host = FakeHost {
            fail_prompt: Some("engine failed"),
            ..Default::default()
        };
        let (code, lines) = run_with(
            &input(&[initialize(), new_session(2), prompt(3, "sess-1", "hi")]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(lines[2]["id"], json!(3));
        assert_eq!(lines[2]["error"]["code"], json!(-32603));
        assert_eq!(lines[2]["error"]["message"], json!("engine failed"));
    }

    #[tokio::test]
    async fn acp_requests_during_a_prompt_get_busy_error() {
        let host = FakeHost {
            delay: Some(Duration::from_millis(200)),
            ..Default::default()
        };
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                new_session(2),
                prompt(3, "sess-1", "hi"),
                new_session(4),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        let busy = lines
            .iter()
            .position(|line| line["id"] == json!(4))
            .unwrap();
        let done = lines
            .iter()
            .position(|line| line["id"] == json!(3))
            .unwrap();
        assert_eq!(lines[busy]["error"]["code"], json!(-32000));
        assert!(busy < done, "busy error must precede the prompt response");
        assert_eq!(lines[done]["result"]["stopReason"], json!("end_turn"));
    }

    fn fake_model_option(
        current: &str,
    ) -> Vec<agent_client_protocol_schema::v1::SessionConfigOption> {
        use agent_client_protocol_schema::v1::{SessionConfigOption, SessionConfigSelectOption};
        vec![SessionConfigOption::select(
            "model",
            "Model",
            current.to_string(),
            vec![
                SessionConfigSelectOption::new("a", "A"),
                SessionConfigSelectOption::new("b", "B"),
            ],
        )]
    }

    fn set_config(id: u64, session_id: &str, config_id: &str, value: &str) -> Value {
        request(
            id,
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": config_id, "value": value}),
        )
    }

    #[tokio::test]
    async fn acp_session_new_reports_config_options_and_set_config_option_switches() {
        let set = Arc::new(Mutex::new(Vec::new()));
        let host = FakeHost {
            config: Some(set.clone()),
            delay: Some(Duration::from_millis(200)),
            ..Default::default()
        };
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                new_session(2),
                set_config(3, "sess-1", "model", "b"),
                set_config(4, "sess-1", "model", "z"),
                set_config(5, "other", "model", "a"),
                prompt(6, "sess-1", "hi"),
                set_config(7, "sess-1", "model", "a"),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(
            response(&lines, 2)["result"]["configOptions"][0]["currentValue"],
            json!("a")
        );
        assert_eq!(
            response(&lines, 3)["result"]["configOptions"][0]["currentValue"],
            json!("b")
        );
        assert_eq!(response(&lines, 4)["error"]["code"], json!(-32602));
        assert_eq!(response(&lines, 5)["error"]["code"], json!(-32602));
        // During a turn the option is still set, and answered before the turn ends.
        let switch = lines
            .iter()
            .position(|line| line["id"] == json!(7))
            .unwrap();
        let done = lines
            .iter()
            .position(|line| line["id"] == json!(6))
            .unwrap();
        assert!(switch < done);
        assert_eq!(
            lines[switch]["result"]["configOptions"][0]["currentValue"],
            json!("a")
        );
        assert_eq!(
            *set.lock().unwrap(),
            vec![
                ("model".to_string(), "b".to_string()),
                ("model".to_string(), "a".to_string())
            ]
        );
    }

    #[tokio::test]
    async fn acp_initialize_offers_load_and_list_and_session_load_answers_without_id() {
        let host = FakeHost {
            modes: Some(Arc::new(Mutex::new(Vec::new()))),
            ..Default::default()
        };
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                request(
                    2,
                    "session/load",
                    json!({"sessionId": "old-1", "cwd": "/tmp", "mcpServers": []}),
                ),
                request(3, "session/load", json!({"cwd": "/tmp"})),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        let capabilities = &response(&lines, 1)["result"]["agentCapabilities"];
        assert_eq!(capabilities["loadSession"], json!(true));
        assert_eq!(capabilities["sessionCapabilities"]["list"], json!({}));
        let loaded = &response(&lines, 2)["result"];
        assert!(loaded.get("sessionId").is_none());
        assert_eq!(loaded["modes"]["currentModeId"], json!("default"));
        // A load without a session id is invalid.
        assert_eq!(response(&lines, 3)["error"]["code"], json!(-32602));
    }

    #[tokio::test]
    async fn acp_session_new_announces_slash_commands_after_the_response() {
        let host = FakeHost {
            commands: vec![("review", "Review the diff"), ("cost", "Show cost")],
            ..Default::default()
        };
        let (_, lines) = run_with(&input(&[initialize(), new_session(2)]), host).await;
        let reply = lines
            .iter()
            .position(|line| line["id"] == json!(2))
            .unwrap();
        let update = lines
            .iter()
            .position(|line| {
                line["params"]["update"]["sessionUpdate"] == json!("available_commands_update")
            })
            .unwrap();
        assert!(reply < update, "the session id is known before the update");
        let commands = &lines[update]["params"]["update"]["availableCommands"];
        assert_eq!(lines[update]["params"]["sessionId"], json!("sess-1"));
        assert_eq!(
            commands[0],
            json!({"name": "review", "description": "Review the diff"})
        );
        assert_eq!(commands.as_array().unwrap().len(), 2);

        // Without commands there is no update.
        let (_, lines) = run_session(&input(&[initialize(), new_session(2)])).await;
        assert!(
            lines
                .iter()
                .all(|line| line["params"]["update"]["sessionUpdate"]
                    != json!("available_commands_update"))
        );
    }

    #[tokio::test]
    async fn acp_set_config_option_without_options_is_method_not_found() {
        let (_, lines) = run_session(&input(&[
            initialize(),
            new_session(2),
            set_config(3, "sess-1", "model", "a"),
        ]))
        .await;
        assert!(response(&lines, 2)["result"].get("configOptions").is_none());
        assert_eq!(response(&lines, 3)["error"]["code"], json!(-32601));
    }

    fn set_mode(id: u64, session_id: &str, mode_id: &str) -> Value {
        request(
            id,
            "session/set_mode",
            json!({"sessionId": session_id, "modeId": mode_id}),
        )
    }

    fn response(lines: &[Value], id: u64) -> &Value {
        lines
            .iter()
            .find(|line| line["id"] == json!(id))
            .unwrap_or_else(|| panic!("no response to request {id}: {lines:?}"))
    }

    #[tokio::test]
    async fn acp_session_new_reports_modes_and_set_mode_switches() {
        let switched = Arc::new(Mutex::new(Vec::new()));
        let host = FakeHost {
            modes: Some(switched.clone()),
            ..Default::default()
        };
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                set_mode(2, "sess-1", "plan"),
                new_session(3),
                set_mode(4, "sess-1", "plan"),
                set_mode(5, "sess-1", "nope"),
                set_mode(6, "other", "plan"),
                request(7, "session/set_mode", json!({"sessionId": "sess-1"})),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        // Before any session there is nothing to switch.
        assert_eq!(response(&lines, 2)["error"]["code"], json!(-32602));
        let modes = &response(&lines, 3)["result"]["modes"];
        assert_eq!(modes["currentModeId"], json!("default"));
        assert_eq!(modes["availableModes"][1]["id"], json!("plan"));
        assert_eq!(response(&lines, 4)["result"], json!({}));
        assert_eq!(response(&lines, 5)["error"]["code"], json!(-32602));
        assert_eq!(
            response(&lines, 5)["error"]["message"],
            json!("Unknown mode: nope")
        );
        assert_eq!(response(&lines, 6)["error"]["code"], json!(-32602));
        assert_eq!(response(&lines, 7)["error"]["code"], json!(-32602));
        assert_eq!(*switched.lock().unwrap(), vec!["plan".to_string()]);
    }

    #[tokio::test]
    async fn acp_set_mode_is_handled_during_a_prompt() {
        let switched = Arc::new(Mutex::new(Vec::new()));
        let host = FakeHost {
            modes: Some(switched.clone()),
            delay: Some(Duration::from_millis(200)),
            ..Default::default()
        };
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                new_session(2),
                prompt(3, "sess-1", "hi"),
                set_mode(4, "sess-1", "plan"),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        let switch = lines
            .iter()
            .position(|line| line["id"] == json!(4))
            .unwrap();
        let done = lines
            .iter()
            .position(|line| line["id"] == json!(3))
            .unwrap();
        assert_eq!(lines[switch]["result"], json!({}));
        assert!(switch < done, "set_mode is answered while the turn runs");
        assert_eq!(*switched.lock().unwrap(), vec!["plan".to_string()]);
    }

    #[tokio::test]
    async fn acp_set_mode_without_modes_is_method_not_found() {
        let (_, lines) = run_session(&input(&[
            initialize(),
            new_session(2),
            set_mode(3, "sess-1", "plan"),
        ]))
        .await;
        assert!(response(&lines, 2)["result"].get("modes").is_none());
        assert_eq!(response(&lines, 3)["error"]["code"], json!(-32601));
    }

    #[tokio::test]
    async fn acp_stop_reason_follows_turn_end() {
        let host = FakeHost {
            end: Some(TurnEnd::Cancelled),
            ..Default::default()
        };
        let (code, lines) = run_with(
            &input(&[initialize(), new_session(2), prompt(3, "sess-1", "hi")]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(lines[2]["result"]["stopReason"], json!("cancelled"));
    }

    #[tokio::test]
    async fn acp_responses_are_routed_to_pending_requests() {
        let host = FakeHost {
            ask_permission: true,
            ..Default::default()
        };
        let answers = host.answers.clone();
        let answer = json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}});
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                new_session(2),
                prompt(3, "sess-1", "hi"),
                json!({"jsonrpc": "2.0", "id": "nyan-1", "result": answer.clone()}),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);

        let request = lines
            .iter()
            .find(|line| line["method"] == json!("session/request_permission"))
            .unwrap();
        assert_eq!(request["id"], json!("nyan-1"));
        assert_eq!(request["params"]["sessionId"], json!("sess-1"));

        assert_eq!(
            *answers.lock().unwrap(),
            vec![Ok::<Value, RpcError>(answer)]
        );
        let reply = lines.iter().find(|line| line["id"] == json!(3)).unwrap();
        assert_eq!(reply["result"]["stopReason"], json!("end_turn"));
    }

    #[tokio::test]
    async fn acp_input_end_fails_pending_requests() {
        let host = FakeHost {
            ask_permission: true,
            ..Default::default()
        };
        let answers = host.answers.clone();
        let (code, lines) = run_with(
            &input(&[initialize(), new_session(2), prompt(3, "sess-1", "hi")]),
            host,
        )
        .await;
        assert_eq!(code, 0);

        assert!(
            lines
                .iter()
                .any(|line| line["method"] == json!("session/request_permission")
                    && line["id"] == json!("nyan-1"))
        );
        assert_eq!(
            *answers.lock().unwrap(),
            vec![Err::<Value, RpcError>(RpcError::new(
                INTERNAL_ERROR,
                "input closed"
            ))]
        );
        let reply = lines.iter().find(|line| line["id"] == json!(3)).unwrap();
        assert_eq!(reply["result"]["stopReason"], json!("end_turn"));
    }

    /// A `session/cancel` notification for `session_id`.
    fn cancel(session_id: &str) -> Value {
        json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}})
    }

    #[tokio::test]
    async fn acp_cancel_ends_the_running_turn_with_cancelled() {
        let host = FakeHost {
            chunks: vec!["working"],
            wait_for_cancel: true,
            ..Default::default()
        };
        let cancels = host.cancels.clone();
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                new_session(2),
                prompt(3, "sess-1", "hi"),
                cancel("sess-1"),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(cancels.load(Ordering::SeqCst), 1);
        // initialize, session/new, one chunk and the prompt response. The cancel
        // notification gets no reply of its own.
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[1]["id"], json!(2));
        assert_eq!(
            lines[2]["params"]["update"]["content"]["text"],
            json!("working")
        );
        assert!(lines.iter().all(|line| line.get("error").is_none()));
        assert_eq!(lines[3]["id"], json!(3));
        assert_eq!(lines[3]["result"]["stopReason"], json!("cancelled"));
    }

    #[tokio::test]
    async fn acp_cancel_for_another_session_is_ignored() {
        let host = FakeHost {
            chunks: vec!["working"],
            wait_for_cancel: true,
            ..Default::default()
        };
        let cancels = host.cancels.clone();
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                new_session(2),
                prompt(3, "sess-1", "hi"),
                cancel("other"),
                cancel("sess-1"),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        // Only the cancel for the session in flight reaches the turn.
        assert_eq!(cancels.load(Ordering::SeqCst), 1);
        assert_eq!(lines.len(), 4);
        assert!(lines.iter().all(|line| line.get("error").is_none()));
        assert_eq!(lines[3]["id"], json!(3));
        assert_eq!(lines[3]["result"]["stopReason"], json!("cancelled"));
    }

    #[tokio::test]
    async fn acp_cancel_while_idle_is_ignored() {
        let host = FakeHost {
            chunks: vec!["hi"],
            ..Default::default()
        };
        let cancels = host.cancels.clone();
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                new_session(2),
                cancel("sess-1"),
                prompt(3, "sess-1", "hi"),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(cancels.load(Ordering::SeqCst), 0);
        // initialize, session/new, one chunk and the prompt response.
        assert_eq!(lines.len(), 4);
        assert!(lines.iter().all(|line| line.get("error").is_none()));
        assert_eq!(lines[3]["id"], json!(3));
        assert_eq!(lines[3]["result"]["stopReason"], json!("end_turn"));
    }

    #[tokio::test]
    async fn acp_malformed_cancel_is_ignored() {
        let host = FakeHost {
            chunks: vec!["working"],
            wait_for_cancel: true,
            ..Default::default()
        };
        let cancels = host.cancels.clone();
        let malformed = json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {}});
        let (code, lines) = run_with(
            &input(&[
                initialize(),
                new_session(2),
                prompt(3, "sess-1", "hi"),
                malformed,
                cancel("sess-1"),
            ]),
            host,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(cancels.load(Ordering::SeqCst), 1);
        assert_eq!(lines.len(), 4);
        assert!(lines.iter().all(|line| line.get("error").is_none()));
        assert_eq!(lines[3]["id"], json!(3));
        assert_eq!(lines[3]["result"]["stopReason"], json!("cancelled"));
    }
}
