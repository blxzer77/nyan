//! The part of `nyan acp` that runs before the first session.
//!
//! Process init reads settings from the working directory, and must run before the
//! runtime exists. The client names the working directory only in `session/new`, and
//! starts the agent wherever it likes (Paseo starts it in its own directory). So until
//! a `session/new` arrives, the process answers on the main thread, without a runtime:
//! `initialize` gets its usual reply and other requests get an error. The first
//! `session/new` with a usable `cwd` moves the process there and ends this phase; the
//! server then answers that request.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use agent_client_protocol_schema::v1::{AGENT_METHOD_NAMES, NewSessionRequest};
use serde_json::Value;

use super::server::initialize_result;
use super::transport::{
    INTERNAL_ERROR, INVALID_PARAMS, Incoming, METHOD_NOT_FOUND, RpcError, parse_line,
    response_message,
};

/// How the phase before the first session ended.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Startup {
    /// A `session/new` arrived and the process now works in its `cwd`. `line` is that
    /// request, not answered yet, and `id` its request id.
    Session { id: Value, line: String },
    /// Input ended (0) or could not be read (1) before any session.
    Ended(i32),
}

/// Answers requests from `reader` until a `session/new` names a directory that `enter`
/// accepts. `enter` moves the process there; when it fails, the request gets the error
/// and the phase goes on.
pub(super) fn await_first_session<R, W, E>(mut reader: R, writer: &mut W, mut enter: E) -> Startup
where
    R: BufRead,
    W: Write,
    E: FnMut(&Path) -> Result<(), String>,
{
    let mut buffer = String::new();
    loop {
        buffer.clear();
        match reader.read_line(&mut buffer) {
            Ok(0) => return Startup::Ended(0),
            Ok(_) => {}
            Err(err) => {
                eprintln!("nyan acp: failed to read stdin: {err}");
                return Startup::Ended(1);
            }
        }
        let line = buffer.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            continue;
        }
        let (id, result) = match parse_line(line) {
            Ok(Incoming::Request { id, method, params }) => {
                if method == AGENT_METHOD_NAMES.session_new {
                    match session_cwd(params).and_then(|cwd| {
                        enter(&cwd).map_err(|message| RpcError::new(INTERNAL_ERROR, message))
                    }) {
                        Ok(()) => {
                            return Startup::Session {
                                id,
                                line: line.to_string(),
                            };
                        }
                        Err(error) => (id, Err(error)),
                    }
                } else {
                    (id, sessionless_result(&method, params))
                }
            }
            // No request of the agent is waiting for an answer yet, and notifications
            // need no reply.
            Ok(Incoming::Response { .. } | Incoming::Notification { .. }) => continue,
            Err(error) => (Value::Null, Err(error)),
        };
        if write_message(writer, &response_message(id, result)).is_err() {
            // The client went away; nothing more can be answered.
            return Startup::Ended(0);
        }
    }
}

/// The reply to a request other than `session/new` while there is no session.
fn sessionless_result(method: &str, params: Value) -> Result<Value, RpcError> {
    if method == AGENT_METHOD_NAMES.initialize {
        initialize_result(params)
    } else if method == AGENT_METHOD_NAMES.session_prompt {
        Err(RpcError::new(
            INVALID_PARAMS,
            "No session yet: send session/new first",
        ))
    } else {
        Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("Method not found: {method}"),
        ))
    }
}

/// The `cwd` of a `session/new` request. ACP requires it to be absolute.
fn session_cwd(params: Value) -> Result<PathBuf, RpcError> {
    let request = serde_json::from_value::<NewSessionRequest>(params)
        .map_err(|err| RpcError::new(INVALID_PARAMS, format!("Invalid params: {err}")))?;
    if !request.cwd.is_absolute() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("cwd must be an absolute path: {}", request.cwd.display()),
        ));
    }
    Ok(request.cwd)
}

/// Writes one message as a JSON line and flushes it.
pub(super) fn write_message<W: Write>(writer: &mut W, message: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(message).map_err(std::io::Error::other)?;
    line.push(b'\n');
    writer.write_all(&line)?;
    writer.flush()
}

/// Moves the process into `cwd` for its one session: the working directory, the
/// startup directory that project settings and history hang off, and a fresh settings
/// cache.
pub(super) fn enter_session_dir(cwd: &Path) -> Result<(), String> {
    std::env::set_current_dir(cwd)
        .map_err(|err| format!("cannot work in {}: {err}", cwd.display()))?;
    let resolved = std::env::current_dir()
        .map_err(|err| format!("failed to read the working directory: {err}"))?;
    let resolved = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    crate::bootstrap::state::set_original_cwd(resolved);
    crate::utils::settings::settings_cache::reset_settings_cache();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn input(messages: &[Value]) -> Cursor<Vec<u8>> {
        let mut text = String::new();
        for message in messages {
            text.push_str(&message.to_string());
            text.push('\n');
        }
        Cursor::new(text.into_bytes())
    }

    fn output(written: &[u8]) -> Vec<Value> {
        String::from_utf8_lossy(written)
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn new_session(id: i64, cwd: &str) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "session/new",
               "params": {"cwd": cwd, "mcpServers": []}})
    }

    #[test]
    fn acp_startup_answers_initialize_then_hands_over_session_new() {
        let request = new_session(2, "/work/project");
        let reader = input(&[
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": 1}}),
            request.clone(),
            json!({"jsonrpc": "2.0", "id": 3, "method": "later"}),
        ]);
        let mut written = Vec::new();
        let mut entered = Vec::new();
        let outcome = await_first_session(reader, &mut written, |cwd: &Path| {
            entered.push(cwd.to_path_buf());
            Ok(())
        });

        let Startup::Session { id, line } = outcome else {
            panic!("expected a session, got {outcome:?}");
        };
        assert_eq!(id, json!(2));
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), request);
        assert_eq!(entered, vec![PathBuf::from("/work/project")]);
        let replies = output(&written);
        assert_eq!(replies.len(), 1, "only initialize is answered: {replies:?}");
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[0]["result"]["protocolVersion"], 1);
        assert_eq!(replies[0]["result"]["agentInfo"]["name"], "nyan");
    }

    #[test]
    fn acp_startup_refuses_other_requests_before_a_session() {
        let reader = input(&[
            json!({"jsonrpc": "2.0", "id": 1, "method": "session/list", "params": {}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "session/prompt",
                   "params": {"sessionId": "s", "prompt": []}}),
            json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "s"}}),
            json!({"jsonrpc": "2.0", "id": "nyan-1", "result": {}}),
        ]);
        let mut written = Vec::new();
        let outcome = await_first_session(reader, &mut written, |_: &Path| Ok(()));

        assert_eq!(outcome, Startup::Ended(0));
        let replies = output(&written);
        assert_eq!(replies.len(), 2, "notifications and responses get no reply");
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[0]["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(replies[1]["id"], 2);
        assert_eq!(replies[1]["error"]["code"], INVALID_PARAMS);
    }

    #[test]
    fn acp_startup_keeps_waiting_after_an_unusable_cwd() {
        let mut text = String::from("not json\n");
        for message in [
            new_session(1, "relative/dir"),
            new_session(2, "/missing"),
            new_session(3, "/ok"),
        ] {
            text.push_str(&message.to_string());
            text.push('\n');
        }
        let mut written = Vec::new();
        let mut tried = Vec::new();
        let outcome = await_first_session(
            Cursor::new(text.into_bytes()),
            &mut written,
            |cwd: &Path| {
                tried.push(cwd.to_path_buf());
                if cwd == Path::new("/missing") {
                    Err("cannot work in /missing".to_string())
                } else {
                    Ok(())
                }
            },
        );

        assert!(matches!(outcome, Startup::Session { .. }));
        assert_eq!(tried, vec![PathBuf::from("/missing"), PathBuf::from("/ok")]);
        let replies = output(&written);
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["id"], Value::Null);
        assert_eq!(replies[1]["id"], 1);
        assert_eq!(replies[1]["error"]["code"], INVALID_PARAMS);
        assert_eq!(replies[2]["id"], 2);
        assert_eq!(replies[2]["error"]["code"], INTERNAL_ERROR);
        assert_eq!(replies[2]["error"]["message"], "cannot work in /missing");
    }
}
