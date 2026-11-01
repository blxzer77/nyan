//! Single LSP server instance lifecycle boundary.
//!
//! Maps to: CC `services/lsp/LSPServerInstance.ts`.
//!
//! This module owns the official per-server state machine, process lifecycle,
//! initialization parameters, health checks, transient request retries, and
//! request/notification forwarding. Raw stdio JSON-RPC transport remains in the
//! sibling `client.rs` boundary, matching CC `LSPClient.ts`.

use crate::services::lsp::client::{JsonRpcResponseError, LspClient, create_lsp_client};
use crate::services::lsp::server_manager::path_to_file_url;
use crate::services::lsp::types::{LspServerState, ScopedLspServerConfig};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Maps to: CC `LSP_ERROR_CONTENT_MODIFIED`.
const LSP_ERROR_CONTENT_MODIFIED: i64 = -32801;
/// Maps to: CC `MAX_RETRIES_FOR_TRANSIENT_ERRORS`.
const MAX_RETRIES_FOR_TRANSIENT_ERRORS: u32 = 3;
/// Maps to: CC `RETRY_BASE_DELAY_MS`.
const RETRY_BASE_DELAY_MS: u64 = 500;

/// The closure variables CC keeps per instance (`LSPServerInstance.ts:113-117`)
/// and exposes through getters. They are readable while a request is in flight,
/// so they live behind their own short-lived lock rather than inside whatever
/// the request path holds.
#[derive(Debug, Default)]
struct LspServerInstanceStatus {
    state: LspServerState,
    start_time: Option<DateTime<Utc>>,
    last_error: Option<String>,
    restart_count: u64,
    crash_recovery_count: u64,
}

/// Maps to the public `LSPServerInstance` interface in CC
/// `services/lsp/LSPServerInstance.ts`.
///
/// Every method takes `&self`: CC's factory returns an object with getters over
/// closure state, and the manager hands the same object to every caller.
#[derive(Debug)]
pub struct LspServerInstance {
    pub name: String,
    pub config: ScopedLspServerConfig,
    status: Arc<Mutex<LspServerInstanceStatus>>,
    client: Arc<LspClient>,
}

impl LspServerInstance {
    /// Maps to: CC `createLSPServerInstance(name, config)`.
    pub fn new(name: impl Into<String>, config: ScopedLspServerConfig) -> Self {
        let name = name.into();
        let status = Arc::new(Mutex::new(LspServerInstanceStatus::default()));
        // Maps to: CC `LSPServerInstance.ts:118-125` — "Propagate crash state so
        // ensureServerStarted can restart on next use. Without this, state stays
        // 'running' after crash and the server is never restarted (zombie
        // state)."
        let crash_status = Arc::clone(&status);
        let client = create_lsp_client(
            name.clone(),
            Some(Arc::new(move |error: String| {
                let mut status = crash_status.lock().unwrap();
                status.state = LspServerState::Error;
                status.last_error = Some(error);
                status.crash_recovery_count = status.crash_recovery_count.saturating_add(1);
            })),
        );
        Self {
            client: Arc::new(client),
            name,
            config,
            status,
        }
    }

    /// Maps to: CC `LSPServerInstance.state` getter.
    pub fn state(&self) -> LspServerState {
        self.status.lock().unwrap().state
    }

    /// Maps to: CC `LSPServerInstance.startTime` getter.
    pub fn start_time(&self) -> Option<DateTime<Utc>> {
        self.status.lock().unwrap().start_time
    }

    /// Maps to: CC `LSPServerInstance.lastError` getter.
    pub fn last_error(&self) -> Option<String> {
        self.status.lock().unwrap().last_error.clone()
    }

    /// Maps to: CC `LSPServerInstance.restartCount` getter.
    pub fn restart_count(&self) -> u64 {
        self.status.lock().unwrap().restart_count
    }

    /// Maps to: CC `LSPServerInstance.start()`.
    pub async fn start(&self) -> anyhow::Result<()> {
        let max_restarts = self.config.config.max_restarts.unwrap_or(3);
        {
            // CC flips `state = 'starting'` synchronously before its first
            // await (`:136-154`), so a second caller arriving mid-start sees
            // `'starting'` and returns. Doing the check and the flip in one
            // critical section is that same guard with real threads.
            let mut status = self.status.lock().unwrap();
            if matches!(
                status.state,
                LspServerState::Running | LspServerState::Starting
            ) {
                return Ok(());
            }

            // DEVIATION(port): CC rejects `restartOnCrash`/`shutdownTimeout` in
            // `createLSPServerInstance` (`:95-104`), so no instance exists at
            // all; the port has no fallible constructor and validates on the
            // first start instead. State stays `stopped`, as it would if the
            // instance had never been created.
            if let Some(error) = Self::unsupported_config_error(&self.name, &self.config) {
                status.last_error = Some(error.clone());
                anyhow::bail!(error);
            }

            if status.state == LspServerState::Error && status.crash_recovery_count > max_restarts {
                let error = format!(
                    "LSP server '{}' exceeded max crash recovery attempts ({max_restarts})",
                    self.name
                );
                status.last_error = Some(error.clone());
                anyhow::bail!(error);
            }

            status.state = LspServerState::Starting;
        }

        let init_result = self.start_inner().await;
        match init_result {
            Ok(()) => {
                let mut status = self.status.lock().unwrap();
                status.state = LspServerState::Running;
                status.start_time = Some(Utc::now());
                status.last_error = None;
                status.crash_recovery_count = 0;
                Ok(())
            }
            Err(error) => {
                // Maps to: CC `:256` `client.stop().catch(() => {})` — the
                // cleanup is NOT awaited, so a wedged server cannot hold up the
                // start() error the tool call is waiting for.
                self.stop_client_after_failed_start().await;
                let mut status = self.status.lock().unwrap();
                status.state = LspServerState::Error;
                status.start_time = None;
                status.last_error = Some(error.to_string());
                drop(status);
                Err(error)
            }
        }
    }

    /// Maps to: CC `:256` — fire-and-forget child cleanup after a failed start.
    /// `stop()` has no timeout on either side, so this must not be awaited on
    /// the caller's path; it is only awaited when no process runtime has been
    /// published (unit tests, embedded callers), where leaking the child would
    /// be worse than blocking.
    async fn stop_client_after_failed_start(&self) {
        let client = Arc::clone(&self.client);
        if let Some(handle) = crate::utils::process_runtime::runtime_handle_for_detached_work() {
            handle.spawn(async move {
                let _ = client.stop().await;
            });
            return;
        }
        let _ = client.stop().await;
    }

    async fn start_inner(&self) -> anyhow::Result<()> {
        self.client
            .start(
                &self.config.config.command,
                &self.config.config.args,
                Some(crate::services::lsp::client::LspClientStartOptions {
                    env: self.config.config.env.clone(),
                    cwd: self.config.config.workspace_folder.clone(),
                }),
            )
            .await?;

        let init_params = self.initialize_params();
        let init_future = self.client.initialize(init_params);
        if let Some(timeout_ms) = self.config.config.startup_timeout {
            tokio::time::timeout(Duration::from_millis(timeout_ms), init_future)
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "LSP server '{}' timed out after {timeout_ms}ms during initialization",
                        self.name
                    )
                })??;
        } else {
            init_future.await?;
        }
        Ok(())
    }

    pub(crate) fn unsupported_config_error(
        name: &str,
        config: &ScopedLspServerConfig,
    ) -> Option<String> {
        if config.config.restart_on_crash.is_some() {
            return Some(format!(
                "LSP server '{name}': restartOnCrash is not yet implemented. Remove this field from the configuration."
            ));
        }
        if config.config.shutdown_timeout.is_some() {
            return Some(format!(
                "LSP server '{name}': shutdownTimeout is not yet implemented. Remove this field from the configuration."
            ));
        }
        None
    }

    fn initialize_params(&self) -> Value {
        let workspace_folder = self
            .config
            .config
            .workspace_folder
            .clone()
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."))
                    .display()
                    .to_string()
            });
        let workspace_uri = path_to_file_url(Path::new(&workspace_folder));
        let workspace_name = Path::new(&workspace_folder)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(&workspace_folder)
            .to_string();

        serde_json::json!({
            "processId": std::process::id(),
            "initializationOptions": self.config.config.initialization_options.clone().unwrap_or_else(|| serde_json::json!({})),
            "workspaceFolders": [{
                "uri": workspace_uri,
                "name": workspace_name,
            }],
            "rootPath": workspace_folder,
            "rootUri": workspace_uri,
            "capabilities": {
                "workspace": {
                    "configuration": false,
                    "workspaceFolders": false,
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "willSave": false,
                        "willSaveWaitUntil": false,
                        "didSave": true,
                    },
                    "publishDiagnostics": {
                        "relatedInformation": true,
                        "tagSupport": { "valueSet": [1, 2] },
                        "versionSupport": false,
                        "codeDescriptionSupport": true,
                        "dataSupport": false,
                    },
                    "hover": {
                        "dynamicRegistration": false,
                        "contentFormat": ["markdown", "plaintext"],
                    },
                    "definition": {
                        "dynamicRegistration": false,
                        "linkSupport": true,
                    },
                    "references": {
                        "dynamicRegistration": false,
                    },
                    "documentSymbol": {
                        "dynamicRegistration": false,
                        "hierarchicalDocumentSymbolSupport": true,
                    },
                    "callHierarchy": {
                        "dynamicRegistration": false,
                    },
                },
                "general": {
                    "positionEncodings": ["utf-16"],
                },
            },
        })
    }

    /// Maps to: CC `LSPServerInstance.stop()`.
    pub async fn stop(&self) -> anyhow::Result<()> {
        {
            let mut status = self.status.lock().unwrap();
            if matches!(
                status.state,
                LspServerState::Stopped | LspServerState::Stopping
            ) {
                return Ok(());
            }
            status.state = LspServerState::Stopping;
        }

        match self.client.stop().await {
            Ok(()) => {
                let mut status = self.status.lock().unwrap();
                status.state = LspServerState::Stopped;
                status.start_time = None;
                Ok(())
            }
            Err(error) => {
                let mut status = self.status.lock().unwrap();
                status.state = LspServerState::Error;
                status.last_error = Some(error.to_string());
                drop(status);
                Err(error)
            }
        }
    }

    /// Maps to: CC `LSPServerInstance.restart()`.
    pub async fn restart(&self) -> anyhow::Result<()> {
        if let Err(error) = self.stop().await {
            anyhow::bail!(
                "Failed to stop LSP server '{}' during restart: {error}",
                self.name
            );
        }

        let max_restarts = self.config.config.max_restarts.unwrap_or(3);
        let restart_count = {
            let mut status = self.status.lock().unwrap();
            status.restart_count = status.restart_count.saturating_add(1);
            status.restart_count
        };
        if restart_count > max_restarts {
            let error = format!(
                "Max restart attempts ({max_restarts}) exceeded for server '{}'",
                self.name
            );
            self.status.lock().unwrap().last_error = Some(error.clone());
            anyhow::bail!(error);
        }

        self.start().await.map_err(|error| {
            anyhow::anyhow!(
                "Failed to start LSP server '{}' during restart (attempt {restart_count}/{max_restarts}): {error}",
                self.name,
            )
        })
    }

    /// Maps to: CC `LSPServerInstance.isHealthy()`.
    pub fn is_healthy(&self) -> bool {
        self.state() == LspServerState::Running && self.client.is_initialized()
    }

    /// Maps to: CC `LSPServerInstance.sendRequest(...)`.
    pub async fn send_request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        if !self.is_healthy() {
            let (state, last_error) = {
                let status = self.status.lock().unwrap();
                (
                    status.state,
                    status
                        .last_error
                        .as_ref()
                        .map(|error| format!(", last error: {error}"))
                        .unwrap_or_default(),
                )
            };
            // CC interpolates the state LITERAL (`:358`), i.e. `server is
            // stopped`; `{:?}` would emit the Rust variant name instead.
            anyhow::bail!(
                "Cannot send request to LSP server '{}': server is {state}{last_error}",
                self.name,
            );
        }

        let mut last_attempt_error: Option<anyhow::Error> = None;
        for attempt in 0..=MAX_RETRIES_FOR_TRANSIENT_ERRORS {
            match self.client.send_request(method, params.clone()).await {
                Ok(value) => return Ok(value),
                Err(error) => {
                    let is_content_modified = error
                        .downcast_ref::<JsonRpcResponseError>()
                        .and_then(|error| error.code)
                        == Some(LSP_ERROR_CONTENT_MODIFIED);
                    if is_content_modified && attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS {
                        let delay_ms = RETRY_BASE_DELAY_MS * 2_u64.pow(attempt);
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        last_attempt_error = Some(error);
                        continue;
                    }
                    last_attempt_error = Some(error);
                    break;
                }
            }
        }

        // CC does not inspect crash state here (`:404-409` only wraps the
        // error): the client's `onCrash` callback has already moved this
        // instance to `error`.
        anyhow::bail!(
            "LSP request '{method}' failed for server '{}': {}",
            self.name,
            last_attempt_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        )
    }

    /// Maps to: CC `LSPServerInstance.sendNotification(...)`.
    pub async fn send_notification(&self, method: &str, params: Value) -> anyhow::Result<()> {
        if !self.is_healthy() {
            anyhow::bail!(
                "Cannot send notification to LSP server '{}': server is {}",
                self.name,
                self.state()
            );
        }
        self.client
            .send_notification(method, params)
            .await
            .map_err(|error| {
                anyhow::anyhow!(
                    "LSP notification '{method}' failed for server '{}': {error}",
                    self.name
                )
            })
    }

    /// Maps to: CC `LSPServerInstance.onNotification(...)`.
    pub fn on_notification<F>(&self, method: &str, handler: F)
    where
        F: Fn(Value) + Send + Sync + 'static,
    {
        self.client.on_notification(method, handler);
    }

    /// Maps to: CC `LSPServerInstance.onRequest(...)`.
    pub fn on_request<F>(&self, method: &str, handler: F)
    where
        F: Fn(Value) -> Value + Send + Sync + 'static,
    {
        self.client.on_request(method, handler);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::lsp::types::LspServerConfig;

    fn instance_with_command(command: &str) -> LspServerInstance {
        LspServerInstance::new(
            "rust",
            ScopedLspServerConfig {
                config: LspServerConfig {
                    command: command.to_string(),
                    ..LspServerConfig::default()
                },
                server_name: Some("rust".to_string()),
                scope: None,
                source: None,
            },
        )
    }

    #[tokio::test]
    async fn start_records_process_start_error_on_official_server_boundary() {
        let server = instance_with_command("definitely-not-a-nyan-lsp-server");
        let error = server.start().await.unwrap_err().to_string();
        assert!(error.contains("failed to start") || error.contains("No such file"));
        assert_eq!(server.state(), LspServerState::Error);
        assert!(server.last_error().is_some());
    }

    #[tokio::test]
    async fn stop_moves_server_to_stopped_like_official_lifecycle() {
        let server = instance_with_command("definitely-not-a-nyan-lsp-server");
        let _ = server.start().await;
        server.stop().await.unwrap();
        assert_eq!(server.state(), LspServerState::Stopped);
    }

    /// H4: the state that reaches the model is CC's lowercase literal
    /// (`LSPServerInstance.ts:358`), not the Rust variant name. The string
    /// travels `send_request` → `LspServerManager::send_request` →
    /// `lsp_error_output` → `Error performing hover: ...`.
    #[tokio::test]
    async fn unhealthy_send_request_uses_the_official_lowercase_state_literal() {
        let server = instance_with_command("definitely-not-a-nyan-lsp-server");
        let error = server
            .send_request("textDocument/hover", serde_json::json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "Cannot send request to LSP server 'rust': server is stopped"
        );

        let _ = server.start().await;
        let error = server
            .send_request("textDocument/hover", serde_json::json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.starts_with(
                "Cannot send request to LSP server 'rust': server is error, last error: "
            ),
            "unexpected error: {error}"
        );

        let notification_error = server
            .send_notification("textDocument/didSave", serde_json::json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            notification_error,
            "Cannot send notification to LSP server 'rust': server is error"
        );
    }

    #[tokio::test]
    async fn unimplemented_restart_on_crash_config_fails_like_official_validation() {
        let server = LspServerInstance::new(
            "rust",
            ScopedLspServerConfig {
                config: LspServerConfig {
                    command: "rust-analyzer".to_string(),
                    restart_on_crash: Some(true),
                    ..LspServerConfig::default()
                },
                server_name: Some("rust".to_string()),
                scope: None,
                source: None,
            },
        );
        let error = server.start().await.unwrap_err().to_string();
        assert!(error.contains("restartOnCrash is not yet implemented"));
        assert_eq!(server.state(), LspServerState::Stopped);
    }

    #[tokio::test]
    async fn ordinary_start_failures_do_not_consume_crash_recovery_budget() {
        let server = LspServerInstance::new(
            "rust",
            ScopedLspServerConfig {
                config: LspServerConfig {
                    command: "definitely-not-a-nyan-lsp-server".to_string(),
                    max_restarts: Some(0),
                    ..LspServerConfig::default()
                },
                server_name: Some("rust".to_string()),
                scope: None,
                source: None,
            },
        );

        let first = server.start().await.unwrap_err().to_string();
        let second = server.start().await.unwrap_err().to_string();
        assert!(first.contains("failed to start") || first.contains("No such file"));
        assert!(second.contains("failed to start") || second.contains("No such file"));
        assert!(!second.contains("exceeded max crash recovery attempts"));
    }
}
