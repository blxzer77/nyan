//! The real engine behind `nyan acp`: sessions are `QueryEngine`s, prompt turns run
//! through `query_engine::ask`, and engine output goes out as ACP session updates.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use agent_client_protocol_schema::v1::{
    AvailableCommand, AvailableCommandInput, CLIENT_METHOD_NAMES, SessionConfigOption,
    SessionModeState, UnstructuredCommandInput,
};
use serde_json::Value;

use super::config_options::{ConfigOptions, Profile, SharedConfigOptions, lock_config};
use super::modes::{Modes, SharedModes, lock_modes};
use super::permission::{control_response_for, permission_request_params};
use super::session::{
    AcpHost, AcpSession, Canceller, ConfigSwitch, ModeSwitch, NewSession, TurnEnd, UpdateSink,
};
use super::tools::{describe_tool_call, tool_result_text};
use super::transport::{Outbound, RpcError};
use crate::cli::CliConfig;
use crate::cli::print::ControlResponseInput;
use crate::cli::structured_io::{
    PendingControlResponses, SdkControlBridge, request_sdk_tool_permission,
};
use crate::query_engine::{
    QueryEngine, QueryEngineConfig, QueryEngineOutcome, QueryEnginePermissionResolver,
};
use crate::tool::{AbortController, AppStoreRef};
use crate::types::permissions::{PermissionPromptResponse, PermissionRequest};

/// The headless configuration the engine runs with under ACP: what
/// `nyan -p --output-format stream-json --input-format stream-json --verbose
/// --include-partial-messages --disallowedTools AskUserQuestion` parses to. ACP has no
/// flags of its own yet. Partial messages let text and thinking stream to the client.
///
/// AskUserQuestion gets its answers through the permission response's updated input,
/// which an ACP permission answer (an option id) cannot carry, so the client could
/// neither see nor answer the questions. Without the tool the model asks in its reply.
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
        "--include-partial-messages",
        // Takes several values, so it stays last.
        "--disallowedTools",
        "AskUserQuestion",
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
    /// Carries the engine's permission requests to the client. Its input-closed hook is
    /// [`AcpSession::on_input_closed`].
    bridge: SdkControlBridge,
    /// The session's permission modes, shared with the switch `session/set_mode` calls.
    modes: SharedModes,
    /// The model and effort options, shared with the switch `session/set_config_option`
    /// calls. `None` when no model profiles are configured.
    config: Option<SharedConfigOptions>,
    /// The slash commands, announced after `session/new`.
    commands: Vec<AvailableCommand>,
    /// Reports mode switches to the client.
    sink: UpdateSink,
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

        // `session/load` resumes the earlier session as `--resume <id>` does, which also
        // makes its id this process's session id. Reading the transcript runs off the
        // runtime thread.
        let resume_seed = match request.load.clone() {
            Some(load_id) => {
                let mut config = self.config.clone();
                config.resume = Some(load_id);
                let cwd = self.launch_cwd.clone();
                tokio::task::spawn_blocking(move || {
                    crate::cli::print::load_headless_resume(&config, &cwd)
                })
                .await
                .map_err(|error| error.to_string())??
            }
            None => None,
        };
        let session_id = match &request.load {
            Some(load_id) => load_id.clone(),
            None => crate::bootstrap::state::get_session_id(),
        };
        let bridge = permission_bridge(outbound.clone(), session_id.clone());
        let sink = UpdateSink::new(outbound, session_id.clone());
        if let Some(seed) = &resume_seed {
            replay_history(&sink, seed.history());
        }
        // The mode the engine starts in comes from the same setting.
        let default_mode = crate::utils::settings::get_initial_settings()
            .permissions
            .and_then(|permissions| permissions.default_mode);
        let modes = Arc::new(Mutex::new(Modes::new(default_mode.as_deref())));
        let config = session_config_options().map(|options| Arc::new(Mutex::new(options)));
        // Loading commands reads files and may wait on plugins, so it runs off the runtime
        // thread, as in `print::initialize_control_response`.
        let commands_cwd = self.launch_cwd.clone();
        let commands = tokio::task::spawn_blocking(move || slash_commands(&commands_cwd))
            .await
            .map_err(|error| error.to_string())?;
        let engine = QueryEngine::new(QueryEngineConfig {
            cli_config: self.config.clone(),
            schema: None,
            resume_seed,
            mcp_state: Some(mcp_state),
            output_sink: Some(QueryEngine::output_sink({
                let forwarder = Mutex::new(EngineForwarder::new(sink.clone()));
                move |value| lock(&forwarder).forward(&value)
            })),
            permission_resolver: Some(permission_resolver(bridge.clone())),
            handle_elicitation: crate::tool::HandleElicitationCallback::default(),
        });
        let session = EngineSession {
            engine,
            bridge,
            modes,
            config,
            commands,
            sink,
        };
        Ok((session_id, session))
    }
}

impl AcpSession for EngineSession {
    async fn prompt(&mut self, text: String) -> Result<TurnEnd, String> {
        // A mode, model or effort picked since the last turn applies from this one on.
        let pending = lock_modes(&self.modes).take_pending();
        if let Some(mode) = pending {
            self.engine.set_permission_mode(mode);
        }
        if let Some(config) = &self.config {
            let pending = lock_config(config).take_pending();
            if let Some(profile) = pending.profile {
                // Also resets the effort to the profile's own.
                crate::cli::print::set_session_profile_from_ref(&mut self.engine, &profile)?;
            }
            if let Some(effort) = pending.effort {
                self.engine.set_effort(Some(effort));
            }
        }
        let outcome = crate::query_engine::ask(&mut self.engine, text, None).await;
        // The engine may have changed the mode itself during the turn (approving
        // ExitPlanMode leaves plan mode); the client is told, as for its own switches.
        if let Some(mode) = self.engine.permission_mode() {
            let changed = lock_modes(&self.modes)
                .follow_engine(mode)
                .map(str::to_string);
            if let Some(id) = changed {
                self.sink.current_mode(&id);
            }
        }
        // How full the context window is now, and what the session has cost so far (one
        // session per process, so the process total).
        if let Some(size) = current_context_window() {
            let used = crate::utils::tokens::token_count_from_last_api_response(
                self.engine.get_messages(),
            );
            self.sink.usage(
                u64::try_from(used).unwrap_or(0),
                size,
                crate::cost_tracker::get_total_cost(),
            );
        }
        turn_end(&outcome?)
    }

    fn modes(&self) -> Option<SessionModeState> {
        Some(lock_modes(&self.modes).state())
    }

    fn available_commands(&self) -> Vec<AvailableCommand> {
        self.commands.clone()
    }

    fn config_options(&self) -> Option<Vec<SessionConfigOption>> {
        self.config
            .as_ref()
            .map(|config| lock_config(config).options())
    }

    fn config_switch(&self) -> Option<ConfigSwitch> {
        let config = self.config.clone()?;
        Some(Arc::new(move |config_id: &str, value: &str| {
            let mut options = lock_config(&config);
            options.set(config_id, value)?;
            Ok(options.options())
        }))
    }

    fn mode_switch(&self) -> Option<ModeSwitch> {
        let modes = self.modes.clone();
        let sink = self.sink.clone();
        Some(Arc::new(move |id: &str| {
            lock_modes(&modes).switch(id)?;
            sink.current_mode(id);
            Ok(())
        }))
    }

    fn canceller(&self) -> Canceller {
        // Interrupting while no query is running is a no-op on the engine side.
        let control = self.engine.control_handle();
        Arc::new(move || control.interrupt())
    }

    fn on_input_closed(&self) -> Canceller {
        // Parked permission requests are dropped, so the engine stops waiting for them.
        let bridge = self.bridge.clone();
        Arc::new(move || bridge.close_input())
    }
}

/// Replays a resumed session's history to the client, as `session/load` requires: the
/// user's own messages as `user_message_chunk`, and the agent's messages, tool calls and
/// results as they went out live. Messages the user did not write (reminders, meta
/// rows) are skipped.
fn replay_history(sink: &UpdateSink, history: &[crate::types::message::Message]) {
    let mut forwarder = EngineForwarder::new(sink.clone());
    for message in history {
        if let Some(value) = crate::query_engine::stream_message_value(message) {
            forwarder.replay(&value);
        }
    }
}

/// The slash commands a user can run in `cwd`: user-invocable and not hidden, as the
/// headless `initialize` control response lists them, and runnable without the TUI:
/// prompt commands, and local commands that declare `supports_non_interactive`. The
/// rest (`/theme`, `/vim`, `/keybindings`, ...) do nothing here. A prompt starting with
/// `/name` runs one; its output comes back as an ordinary message.
fn slash_commands(cwd: &Path) -> Vec<AvailableCommand> {
    crate::commands::get_commands(cwd)
        .into_iter()
        .filter(|command| command.user_invocable && !command.is_hidden)
        .filter(|command| {
            command.kind == crate::commands::CommandKind::Prompt || command.supports_non_interactive
        })
        .map(|command| {
            let entry = AvailableCommand::new(
                crate::commands::get_command_name(&command),
                crate::commands::format_description_with_source(&command),
            );
            match command
                .argument_hint
                .as_deref()
                .filter(|hint| !hint.is_empty())
            {
                Some(hint) => entry.input(AvailableCommandInput::Unstructured(
                    UnstructuredCommandInput::new(hint),
                )),
                None => entry,
            }
        })
        .collect()
}

/// The context window, in tokens, of the profile the session runs on (its own, or
/// `selection.main`). `None` when no profile resolves.
fn current_context_window() -> Option<u64> {
    let settings = crate::utils::settings::get_initial_settings();
    let nyan = settings.nyan.as_deref()?;
    let profile = crate::bootstrap::state::get_session_profile().or_else(|| {
        nyan.selection
            .as_ref()
            .and_then(|selection| selection.main.clone())
    })?;
    crate::utils::model::profile::resolve_profile(nyan, &profile)
        .ok()
        .map(|resolved| u64::from(resolved.context_window))
}

/// The model and effort options for a new session, from `settings.nyan`: every profile in
/// `models`, with the session's profile (or `selection.main`) and its effort current.
/// `None` when no profiles are configured or none is selected.
fn session_config_options() -> Option<ConfigOptions> {
    use crate::utils::model::profile::{model_profile, profile_names, resolve_profile};

    let settings = crate::utils::settings::get_initial_settings();
    let nyan = settings.nyan.as_deref()?;
    let profiles: Vec<Profile> = profile_names(Some(nyan))
        .map(|name| {
            let configured = model_profile(nyan, name);
            Profile {
                name: name.to_string(),
                display_name: configured
                    .and_then(|profile| profile.display_name.clone())
                    .unwrap_or_else(|| name.to_string()),
                model: configured
                    .and_then(|profile| profile.model.clone())
                    .unwrap_or_default(),
                effort: resolve_profile(nyan, name)
                    .ok()
                    .and_then(|profile| profile.effort)
                    .unwrap_or_default(),
            }
        })
        .collect();
    let current = crate::bootstrap::state::get_session_profile().or_else(|| {
        nyan.selection
            .as_ref()
            .and_then(|selection| selection.main.clone())
    })?;
    let effort = profiles
        .iter()
        .find(|profile| profile.name == current)
        .map(|profile| profile.effort)?;
    ConfigOptions::new(profiles, &current, effort)
}

/// The SDK control bridge for one session. The engine's permission requests go through it,
/// as they do for `--permission-prompt-tool stdio`. This function translates the bridge's
/// `can_use_tool` control requests into `session/request_permission`, and carries the
/// client's answers back to the bridge. Other control messages are dropped.
fn permission_bridge(outbound: Outbound, session_id: String) -> SdkControlBridge {
    let pending = PendingControlResponses::default();
    // Bridge request id -> ACP request id, for the requests the agent still waits on.
    let acp_requests: Arc<Mutex<HashMap<String, String>>> = Arc::default();
    let answers_to = pending.clone();
    let emit = Arc::new(move |message: Value| {
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let request_id = message
            .get("request_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let subtype = message.pointer("/request/subtype").and_then(Value::as_str);
        if kind == "control_request" && subtype == Some("can_use_tool") {
            let (Some(request_id), Some(request)) = (request_id, message.get("request").cloned())
            else {
                return;
            };
            let params = permission_request_params(&session_id, &request);
            let answers_to = answers_to.clone();
            let requests = acp_requests.clone();
            let bridge_id = request_id.clone();
            let acp_id = outbound.request(
                CLIENT_METHOD_NAMES.session_request_permission,
                params,
                Box::new(move |answer: Result<Value, RpcError>| {
                    lock(&requests).remove(&bridge_id);
                    let payload = control_response_for(&request, answer);
                    let response = bridge_response(&bridge_id, &payload);
                    // Taken out of the table first, so no lock is held while answering.
                    let sender = lock(&answers_to).remove(&bridge_id);
                    if let Some(sender) = sender {
                        let _ = sender.try_send(response);
                    }
                }),
            );
            lock(&acp_requests).insert(request_id, acp_id);
        } else if kind == "control_cancel_request" {
            // The bridge stopped waiting for this answer, so the client's reply is unwanted.
            let acp_id = request_id.and_then(|id| lock(&acp_requests).remove(&id));
            if let Some(acp_id) = acp_id {
                outbound.forget(&acp_id);
            }
        } else {
            eprintln!("nyan acp: dropped SDK control message {kind:?}; ACP does not support it");
        }
    });
    SdkControlBridge::with_emit(pending, emit)
}

/// The `control_response` the bridge reads for `request_id`, built from the payload
/// [`control_response_for`] produced.
fn bridge_response(request_id: &str, payload: &Value) -> ControlResponseInput {
    ControlResponseInput {
        request_id: request_id.to_string(),
        subtype: payload
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or("error")
            .to_string(),
        response: payload.get("response").cloned(),
        error: payload
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// The engine's permission resolver under ACP. Each tool call that needs approval goes
/// through the bridge, the same path `print::run_stream_json` takes for stdio prompts.
fn permission_resolver(bridge: SdkControlBridge) -> QueryEnginePermissionResolver {
    Arc::new(
        move |request: PermissionRequest,
              abort: AbortController,
              agent_id: Option<String>,
              app_store: AppStoreRef| {
            let bridge = bridge.clone();
            Box::pin(async move {
                request_sdk_tool_permission(
                    &bridge,
                    &request,
                    &abort,
                    agent_id.as_deref(),
                    &app_store,
                )
                .await
            })
                as std::pin::Pin<
                    Box<dyn std::future::Future<Output = PermissionPromptResponse> + Send>,
                >
        },
    )
}

/// Locks a table, ignoring poisoning.
fn lock<T>(table: &Mutex<T>) -> MutexGuard<'_, T> {
    table
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether two paths name the same directory. Both are canonicalized first; a path that
/// cannot be canonicalized is compared as given.
fn same_dir(a: &Path, b: &Path) -> bool {
    let canonical =
        |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical(a) == canonical(b)
}

/// Turns the engine's output into ACP session updates for one session.
///
/// Assistant text becomes `agent_message_chunk`, thinking becomes `agent_thought_chunk`,
/// and a tool use becomes `tool_call`. A tool result in a user message becomes
/// `tool_call_update`. Everything else is ignored for now.
///
/// With partial messages on, text and thinking go out as their deltas stream in, each
/// chunk tagged with the API message id. The whole message the engine emits after each
/// block then adds only its tool calls, so nothing is sent twice.
struct EngineForwarder {
    sink: UpdateSink,
    /// Id of the model message being streamed, from its `message_start`.
    streaming: Option<String>,
    /// Ids of messages whose text or thinking already went out as deltas.
    streamed: HashSet<String>,
}

impl EngineForwarder {
    fn new(sink: UpdateSink) -> Self {
        Self {
            sink,
            streaming: None,
            streamed: HashSet::new(),
        }
    }

    /// Forwards one engine output value.
    fn forward(&mut self, value: &Value) {
        let kind = value.get("type").and_then(Value::as_str);
        if kind == Some("stream_event") {
            if let Some(event) = value.get("event") {
                self.forward_stream_event(event);
            }
            return;
        }
        let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        match kind {
            Some("assistant") => {
                let message_id = value.pointer("/message/id").and_then(Value::as_str);
                let streamed = message_id.is_some_and(|id| self.streamed.contains(id));
                for block in blocks {
                    forward_assistant_block(&self.sink, block, message_id, streamed);
                }
            }
            Some("user") => {
                for block in blocks {
                    forward_tool_result(&self.sink, block);
                }
            }
            _ => {}
        }
    }

    /// Replays one message of a resumed session's history. Unlike live output, a user
    /// message the user wrote goes out as `user_message_chunk`, tagged with its uuid.
    fn replay(&mut self, value: &Value) {
        if value.get("type").and_then(Value::as_str) != Some("user") {
            self.forward(value);
            return;
        }
        let synthetic = value
            .get("isSynthetic")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let message_id = value.get("uuid").and_then(Value::as_str);
        let content = value.pointer("/message/content");
        let blocks: Vec<Value> = match content {
            Some(Value::Array(blocks)) => blocks.clone(),
            Some(Value::String(text)) => vec![serde_json::json!({"type": "text", "text": text})],
            _ => return,
        };
        for block in &blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("tool_result") => forward_tool_result(&self.sink, block),
                Some("text") if !synthetic => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        replay_user_text(&self.sink, text, message_id);
                    }
                }
                _ => {}
            }
        }
    }

    /// Forwards one raw API stream event: a `message_start` names the message, and text
    /// and thinking deltas go out as chunks of it. Other events are ignored.
    fn forward_stream_event(&mut self, event: &Value) {
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                self.streaming = event
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("content_block_delta") => {
                let Some(delta) = event.get("delta") else {
                    return;
                };
                let message_id = self.streaming.as_deref();
                let sent = match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => non_empty(delta, "text")
                        .map(|text| self.sink.agent_message(text, message_id)),
                    Some("thinking_delta") => non_empty(delta, "thinking")
                        .map(|text| self.sink.agent_thought(text, message_id)),
                    _ => None,
                };
                if let (Some(()), Some(id)) = (sent, &self.streaming) {
                    self.streamed.insert(id.clone());
                }
            }
            _ => {}
        }
    }
}

/// Replays the text of a user message. A slash command, recorded with command tags, shows
/// as the `/name args` the user typed, and its recorded output as an agent message.
/// Reminders are dropped, and so is a message left empty.
fn replay_user_text(sink: &UpdateSink, text: &str, message_id: Option<&str>) {
    let text = crate::utils::query_helpers::strip_system_reminders(text);
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if let Some(output) = tag_content(text, "local-command-stdout") {
        if !output.trim().is_empty() {
            sink.agent_message(output.trim(), message_id);
        }
        return;
    }
    if let Some(name) = tag_content(text, "command-name") {
        let args = tag_content(text, "command-args").unwrap_or_default();
        let typed = if args.trim().is_empty() {
            name.trim().to_string()
        } else {
            format!("{} {}", name.trim(), args.trim())
        };
        sink.user_message(&typed, message_id);
        return;
    }
    sink.user_message(text, message_id);
}

/// The text between `<tag>` and `</tag>`, if both are present.
fn tag_content<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

/// The string at `key`, when present and not empty.
fn non_empty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// Forwards one content block of an assistant message. When the message's text and
/// thinking already streamed, only a tool use goes out.
fn forward_assistant_block(
    sink: &UpdateSink,
    block: &Value,
    message_id: Option<&str>,
    streamed: bool,
) {
    match block.get("type").and_then(Value::as_str) {
        Some("text") if !streamed => {
            if let Some(text) = non_empty(block, "text") {
                sink.agent_message(text, message_id);
            }
        }
        Some("thinking") if !streamed => {
            if let Some(text) = non_empty(block, "thinking") {
                sink.agent_thought(text, message_id);
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

    #[test]
    fn acp_engine_config_is_headless_stream_json_without_ask_user_question() {
        let config = engine_cli_config();
        assert!(config.print);
        assert_eq!(config.output_format.as_deref(), Some("stream-json"));
        assert_eq!(config.input_format.as_deref(), Some("stream-json"));
        assert!(config.prompt.is_none());
        assert!(config.include_partial_messages);
        assert_eq!(config.disallowed_tools, vec!["AskUserQuestion".to_string()]);
    }

    #[test]
    fn acp_replay_sends_user_text_commands_and_tool_results() {
        let (outbound, mut rx) = Outbound::channel();
        let mut forwarder = EngineForwarder::new(UpdateSink::new(outbound, "sess-4"));
        let user = |uuid: &str, synthetic: bool, content: Value| {
            json!({"type": "user", "uuid": uuid, "isSynthetic": synthetic,
                   "message": {"role": "user", "content": content}})
        };
        forwarder.replay(&user("u1", false, json!("fix the bug")));
        forwarder.replay(&user(
            "u2",
            true,
            json!([{"type": "text", "text": "meta note"}]),
        ));
        forwarder.replay(
            &json!({"type": "assistant", "message": {"id": "msg_1", "content": [
            {"type": "text", "text": "on it"},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}}),
        );
        forwarder.replay(&user(
            "u3",
            false,
            json!([
            {"type": "tool_result", "tool_use_id": "t1", "content": "a.txt"}]),
        ));
        forwarder.replay(&user("u4", false, json!([{"type": "text", "text":
            "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep tests</command-args>"}])));
        forwarder.replay(&user(
            "u5",
            false,
            json!([{"type": "text", "text":
            "<local-command-stdout>Compacted.</local-command-stdout>"}]),
        ));
        forwarder.replay(&user(
            "u6",
            false,
            json!([{"type": "text", "text":
            "<system-reminder>only for the model</system-reminder>"}]),
        ));
        drop(forwarder);

        let mut updates = Vec::new();
        while let Ok(message) = rx.try_recv() {
            let update = &message["params"]["update"];
            updates.push(format!(
                "{} {} {}",
                update["sessionUpdate"].as_str().unwrap(),
                update["content"]["text"]
                    .as_str()
                    .or(update["toolCallId"].as_str())
                    .unwrap_or_default(),
                update["messageId"].as_str().unwrap_or("-"),
            ));
        }
        assert_eq!(
            updates,
            [
                "user_message_chunk fix the bug u1",
                "agent_message_chunk on it msg_1",
                "tool_call t1 -",
                "tool_call_update t1 -",
                "user_message_chunk /compact keep tests u4",
                "agent_message_chunk Compacted. u5",
            ]
        );
    }

    #[test]
    fn acp_forwarder_streams_deltas_and_skips_the_repeated_text() {
        let (outbound, mut rx) = Outbound::channel();
        let mut forwarder = EngineForwarder::new(UpdateSink::new(outbound, "sess-3"));
        let event = |event: Value| json!({"type": "stream_event", "event": event});
        forwarder.forward(&event(
            json!({"type": "message_start", "message": {"id": "msg_a"}}),
        ));
        forwarder.forward(&event(json!({"type": "content_block_start", "index": 0,
            "content_block": {"type": "thinking", "thinking": ""}})));
        forwarder.forward(&event(json!({"type": "content_block_delta", "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "let me see"}})));
        forwarder.forward(&event(json!({"type": "content_block_delta", "index": 0,
            "delta": {"type": "signature_delta", "signature": "sig"}})));
        forwarder.forward(&event(json!({"type": "content_block_delta", "index": 1,
            "delta": {"type": "text_delta", "text": "Hel"}})));
        forwarder.forward(&event(json!({"type": "content_block_delta", "index": 1,
            "delta": {"type": "text_delta", "text": "lo"}})));
        // The engine then emits the whole message, one block at a time.
        forwarder.forward(
            &json!({"type": "assistant", "message": {"id": "msg_a", "content": [
            {"type": "thinking", "thinking": "let me see", "signature": "sig"}]}}),
        );
        forwarder.forward(
            &json!({"type": "assistant", "message": {"id": "msg_a", "content": [
            {"type": "text", "text": "Hello"}]}}),
        );
        forwarder.forward(&event(json!({"type": "content_block_delta", "index": 2,
            "delta": {"type": "input_json_delta", "partial_json": "{\"command\""}})));
        forwarder.forward(
            &json!({"type": "assistant", "message": {"id": "msg_a", "content": [
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}}),
        );
        // A message that did not stream (no deltas) still goes out whole.
        forwarder.forward(
            &json!({"type": "assistant", "message": {"id": "msg_b", "content": [
            {"type": "text", "text": "whole"}]}}),
        );
        drop(forwarder);

        let mut updates = Vec::new();
        while let Ok(message) = rx.try_recv() {
            let update = &message["params"]["update"];
            updates.push((
                update["sessionUpdate"].as_str().unwrap().to_string(),
                update["content"]["text"]
                    .as_str()
                    .or(update["toolCallId"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                update["messageId"].as_str().unwrap_or_default().to_string(),
            ));
        }
        let expected = [
            ("agent_thought_chunk", "let me see", "msg_a"),
            ("agent_message_chunk", "Hel", "msg_a"),
            ("agent_message_chunk", "lo", "msg_a"),
            ("tool_call", "t1", ""),
            ("agent_message_chunk", "whole", "msg_b"),
        ];
        let expected: Vec<(String, String, String)> = expected
            .iter()
            .map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string()))
            .collect();
        assert_eq!(updates, expected);
    }

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
        let mut forwarder = EngineForwarder::new(UpdateSink::new(outbound, "sess-1"));
        forwarder.forward(&json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "text", "text": "hi"},
                {"type": "thinking", "thinking": "hmm", "signature": "sig"},
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}},
                {"type": "text", "text": ""},
            ]},
        }));
        forwarder.forward(
            &json!({"type": "user", "message": {"content": [{"type": "text", "text": "x"}]}}),
        );
        forwarder.forward(&json!({"type": "system", "subtype": "init"}));
        forwarder.forward(&json!({"type": "result", "result": "done"}));
        drop(forwarder);

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
        let mut forwarder = EngineForwarder::new(UpdateSink::new(outbound, "sess-2"));
        forwarder.forward(&json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "text", "text": "reading"},
                {"type": "tool_use", "id": "toolu_1", "name": "Read",
                 "input": {"file_path": "/a.txt"}},
            ]},
        }));
        forwarder.forward(&json!({
            "type": "user",
            "message": {"content": [
                {"type": "tool_result", "tool_use_id": "toolu_1",
                 "content": "nope", "is_error": true},
            ]},
        }));
        forwarder.forward(&json!({"type": "user", "message": {"content": "plain string"}}));
        drop(forwarder);

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
