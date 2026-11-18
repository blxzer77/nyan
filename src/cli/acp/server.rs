//! ACP request dispatch. Only `initialize` is implemented; other requests get Method not found.

use agent_client_protocol_schema::ProtocolVersion;
use agent_client_protocol_schema::v1::{
    AGENT_METHOD_NAMES, Implementation, InitializeRequest, InitializeResponse,
};
use serde_json::Value;
use std::io;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite};

use super::transport::{
    INTERNAL_ERROR, INVALID_PARAMS, Incoming, METHOD_NOT_FOUND, Outbound, RpcError, parse_line,
};
use crate::constants::product::VERSION;

/// Reads and handles ACP messages line by line. Returns 0 on end of input or when the output
/// has closed; returns 1 on a read failure.
pub(crate) async fn serve<R, W>(reader: R, writer: W) -> i32
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send,
{
    let outbound = Outbound::new(writer);
    let mut lines = reader.lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => return 0,
            Err(err) => {
                eprintln!("nyan acp: failed to read stdin: {err}");
                return 1;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let written = match parse_line(&line) {
            Ok(Incoming::Request { id, method, params }) => {
                handle_request(&outbound, id, &method, params).await
            }
            Ok(Incoming::Notification { .. } | Incoming::Response { .. }) => Ok(()),
            Err(error) => outbound.respond_error(Value::Null, error).await,
        };
        if written.is_err() {
            // The client has disconnected; exit normally.
            return 0;
        }
    }
}

async fn handle_request<W>(
    outbound: &Outbound<W>,
    id: Value,
    method: &str,
    params: Value,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin + Send,
{
    if method != AGENT_METHOD_NAMES.initialize {
        let error = RpcError::new(METHOD_NOT_FOUND, format!("Method not found: {method}"));
        return outbound.respond_error(id, error).await;
    }
    if let Err(err) = serde_json::from_value::<InitializeRequest>(params) {
        let error = RpcError::new(INVALID_PARAMS, format!("Invalid params: {err}"));
        return outbound.respond_error(id, error).await;
    }
    let response = InitializeResponse::new(ProtocolVersion::V1)
        .agent_info(Implementation::new("nyan", VERSION));
    match serde_json::to_value(response) {
        Ok(result) => outbound.respond(id, result).await,
        Err(err) => {
            let error = RpcError::new(INTERNAL_ERROR, format!("Internal error: {err}"));
            outbound.respond_error(id, error).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Runs serve once on the given input, returning the exit code and each output line as JSON.
    async fn run_session(input: &str) -> (i32, Vec<Value>) {
        let mut out: Vec<u8> = Vec::new();
        let code = serve(tokio::io::BufReader::new(input.as_bytes()), &mut out).await;
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
        let (code, lines) = run_session(
            "{\"jsonrpc\":\"2.0\",\"id\":\"req-7\",\"method\":\"session/new\",\"params\":{\"cwd\":\"/tmp\",\"mcpServers\":[]}}\n",
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
}
