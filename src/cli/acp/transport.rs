//! Protocol-method-independent JSON-RPC 2.0 I/O: parsing inbound lines and writing outbound
//! messages as one JSON line each.

use serde_json::{Value, json};
use std::io;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

pub(crate) const PARSE_ERROR: i64 = -32700;
pub(crate) const INVALID_REQUEST: i64 = -32600;
pub(crate) const METHOD_NOT_FOUND: i64 = -32601;
pub(crate) const INVALID_PARAMS: i64 = -32602;
pub(crate) const INTERNAL_ERROR: i64 = -32603;

/// A parsed inbound message.
// Fields of Notification / Response are not read yet; later tasks will use them.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: Value,
        result: Result<Value, RpcError>,
    },
}

/// JSON-RPC error object.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub(crate) fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// Parses one line of text into [`Incoming`].
pub(crate) fn parse_line(line: &str) -> Result<Incoming, RpcError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|err| RpcError::new(PARSE_ERROR, format!("Parse error: {err}")))?;
    let invalid = || RpcError::new(INVALID_REQUEST, "Invalid Request");
    let Some(obj) = value.as_object() else {
        return Err(invalid());
    };
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(invalid());
    }
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    match (obj.get("method"), obj.get("id")) {
        (Some(method), Some(id)) => {
            let method = method.as_str().ok_or_else(invalid)?.to_string();
            Ok(Incoming::Request {
                id: id.clone(),
                method,
                params,
            })
        }
        (Some(method), None) => {
            let method = method.as_str().ok_or_else(invalid)?.to_string();
            Ok(Incoming::Notification { method, params })
        }
        (None, Some(id)) => {
            if let Some(error) = obj.get("error") {
                let error = parse_rpc_error(error).ok_or_else(invalid)?;
                Ok(Incoming::Response {
                    id: id.clone(),
                    result: Err(error),
                })
            } else if let Some(result) = obj.get("result") {
                Ok(Incoming::Response {
                    id: id.clone(),
                    result: Ok(result.clone()),
                })
            } else {
                Err(invalid())
            }
        }
        (None, None) => Err(invalid()),
    }
}

fn parse_rpc_error(value: &Value) -> Option<RpcError> {
    let obj = value.as_object()?;
    let code = obj.get("code")?.as_i64()?;
    let message = obj.get("message")?.as_str()?.to_string();
    Some(RpcError {
        code,
        message,
        data: obj.get("data").cloned(),
    })
}

/// Ordered outbound queue. Cloneable and usable from sync code; a single
/// writer task drains it so messages reach stdout in enqueue order.
#[derive(Clone)]
pub(crate) struct Outbound {
    tx: UnboundedSender<Value>,
}

impl Outbound {
    /// Creates a queue handle and the receiver that [`write_loop`] drains.
    pub(crate) fn channel() -> (Outbound, UnboundedReceiver<Value>) {
        let (tx, rx) = unbounded_channel();
        (Outbound { tx }, rx)
    }

    /// Queues a successful response to request `id`.
    pub(crate) fn respond(&self, id: Value, result: Value) {
        self.enqueue(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    /// Queues an error response to request `id`. `data` is omitted when absent.
    pub(crate) fn respond_error(&self, id: Value, error: RpcError) {
        let mut error_obj = json!({"code": error.code, "message": error.message});
        if let Some(data) = error.data {
            error_obj["data"] = data;
        }
        self.enqueue(json!({"jsonrpc": "2.0", "id": id, "error": error_obj}));
    }

    /// Queues a notification, which carries no id.
    pub(crate) fn notify(&self, method: &str, params: Value) {
        self.enqueue(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    fn enqueue(&self, message: Value) {
        // A closed receiver means the writer has stopped, so the message cannot be delivered.
        let _ = self.tx.send(message);
    }
}

/// Writes each queued message as one JSON line, flushing after each. Returns
/// when every `Outbound` clone is dropped, or with the first write error.
pub(crate) async fn write_loop<W: AsyncWrite + Unpin>(
    mut rx: UnboundedReceiver<Value>,
    mut writer: W,
) -> io::Result<()> {
    while let Some(message) = rx.recv().await {
        let mut line = serde_json::to_vec(&message).map_err(io::Error::other)?;
        line.push(b'\n');
        writer.write_all(&line).await?;
        writer.flush().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_parse_line_classifies_request_notification_response() {
        let request = parse_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#,
        )
        .unwrap();
        assert_eq!(
            request,
            Incoming::Request {
                id: json!(1),
                method: "initialize".to_string(),
                params: json!({"protocolVersion": 1}),
            }
        );

        let notification = parse_line(
            r#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}"#,
        )
        .unwrap();
        assert_eq!(
            notification,
            Incoming::Notification {
                method: "session/cancel".to_string(),
                params: json!({"sessionId": "s1"}),
            }
        );

        let response = parse_line(r#"{"jsonrpc":"2.0","id":"x","result":{"ok":true}}"#).unwrap();
        assert_eq!(
            response,
            Incoming::Response {
                id: json!("x"),
                result: Ok(json!({"ok": true})),
            }
        );

        let error_response = parse_line(
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"boom","data":"x"}}"#,
        )
        .unwrap();
        assert_eq!(
            error_response,
            Incoming::Response {
                id: json!(2),
                result: Err(RpcError {
                    code: -32000,
                    message: "boom".to_string(),
                    data: Some(json!("x")),
                }),
            }
        );

        let without_params = parse_line(r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#).unwrap();
        assert_eq!(
            without_params,
            Incoming::Request {
                id: json!(3),
                method: "ping".to_string(),
                params: Value::Null,
            }
        );
    }

    #[test]
    fn acp_parse_line_rejects_bad_input() {
        assert_eq!(parse_line("{not json").unwrap_err().code, PARSE_ERROR);
        assert_eq!(
            parse_line(r#"{"jsonrpc":"1.0","id":1,"method":"x"}"#)
                .unwrap_err()
                .code,
            INVALID_REQUEST
        );
        assert_eq!(parse_line("[]").unwrap_err().code, INVALID_REQUEST);
    }

    #[tokio::test]
    async fn acp_outbound_writes_one_json_object_per_line() {
        let (out, rx) = Outbound::channel();
        out.respond(json!(1), json!({"ok": true}));
        out.respond_error(Value::Null, RpcError::new(PARSE_ERROR, "bad"));
        out.notify("session/update", json!({}));
        drop(out);

        let mut buf: Vec<u8> = Vec::new();
        write_loop(rx, &mut buf).await.unwrap();
        let text = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);

        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(
            first,
            json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}})
        );

        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["id"], Value::Null);
        assert_eq!(second["error"], json!({"code": -32700, "message": "bad"}));

        let third: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(
            third,
            json!({"jsonrpc": "2.0", "method": "session/update", "params": {}})
        );
    }
}
