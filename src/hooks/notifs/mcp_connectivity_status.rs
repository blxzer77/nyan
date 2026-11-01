//! Maps to: CC `hooks/notifs/useMcpConnectivityStatus.tsx`.
//!
//! Nyan keeps this as a pure producer seam. It consumes an already-known MCP
//! connection snapshot and emits main-screen runtime notifications; it never
//! starts MCP clients, performs auth, contacts claude.ai, or writes settings.

use crate::context::notifications::{
    Notification, NotificationColor, NotificationPriority, NotificationSegment,
};

pub const MCP_FAILED_KEY: &str = "mcp-failed";
pub const MCP_CLAUDEAI_FAILED_KEY: &str = "mcp-claudeai-failed";
pub const MCP_NEEDS_AUTH_KEY: &str = "mcp-needs-auth";
pub const MCP_CLAUDEAI_NEEDS_AUTH_KEY: &str = "mcp-claudeai-needs-auth";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpConnectionStatus {
    Connected,
    Failed,
    NeedsAuth,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpConfigType {
    Local,
    SseIde,
    WsIde,
    ClaudeAiProxy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpConnectivityClient {
    pub name: String,
    pub status: McpConnectionStatus,
    pub config_type: McpConfigType,
    /// Official `hasClaudeAiMcpEverConnected(name)` gate for claude.ai proxy
    /// failures/auth prompts. Local servers do not use this flag.
    pub claude_ai_ever_connected: bool,
}

impl McpConnectivityClient {
    pub fn new(
        name: impl Into<String>,
        status: McpConnectionStatus,
        config_type: McpConfigType,
    ) -> Self {
        Self {
            name: name.into(),
            status,
            config_type,
            claude_ai_ever_connected: false,
        }
    }

    pub fn with_claude_ai_ever_connected(mut self, connected: bool) -> Self {
        self.claude_ai_ever_connected = connected;
        self
    }
}

pub fn mcp_connectivity_notifications(
    clients: &[McpConnectivityClient],
    is_remote_mode: bool,
) -> Vec<Notification> {
    if is_remote_mode {
        return Vec::new();
    }

    let failed_local = clients
        .iter()
        .filter(|client| {
            client.status == McpConnectionStatus::Failed
                && !matches!(
                    client.config_type,
                    McpConfigType::SseIde | McpConfigType::WsIde | McpConfigType::ClaudeAiProxy
                )
        })
        .count();
    let failed_claude_ai = clients
        .iter()
        .filter(|client| {
            client.status == McpConnectionStatus::Failed
                && client.config_type == McpConfigType::ClaudeAiProxy
                && client.claude_ai_ever_connected
        })
        .count();
    let needs_auth_local = clients
        .iter()
        .filter(|client| {
            client.status == McpConnectionStatus::NeedsAuth
                && client.config_type != McpConfigType::ClaudeAiProxy
        })
        .count();
    let needs_auth_claude_ai = clients
        .iter()
        .filter(|client| {
            client.status == McpConnectionStatus::NeedsAuth
                && client.config_type == McpConfigType::ClaudeAiProxy
                && client.claude_ai_ever_connected
        })
        .count();

    let mut notifications = Vec::new();
    if failed_local > 0 {
        let noun = if failed_local == 1 {
            "server"
        } else {
            "servers"
        };
        notifications.push(mcp_segment_notification(
            MCP_FAILED_KEY,
            format!("{failed_local} MCP {noun} failed"),
            NotificationColor::Error,
        ));
    }
    if failed_claude_ai > 0 {
        let noun = if failed_claude_ai == 1 {
            "connector"
        } else {
            "connectors"
        };
        notifications.push(mcp_segment_notification(
            MCP_CLAUDEAI_FAILED_KEY,
            format!("{failed_claude_ai} claude.ai {noun} unavailable"),
            NotificationColor::Error,
        ));
    }
    if needs_auth_local > 0 {
        let auth_copy = if needs_auth_local == 1 {
            "server needs auth"
        } else {
            "servers need auth"
        };
        notifications.push(mcp_segment_notification(
            MCP_NEEDS_AUTH_KEY,
            format!("{needs_auth_local} MCP {auth_copy}"),
            NotificationColor::Warning,
        ));
    }
    if needs_auth_claude_ai > 0 {
        let auth_copy = if needs_auth_claude_ai == 1 {
            "connector needs auth"
        } else {
            "connectors need auth"
        };
        notifications.push(mcp_segment_notification(
            MCP_CLAUDEAI_NEEDS_AUTH_KEY,
            format!("{needs_auth_claude_ai} claude.ai {auth_copy}"),
            NotificationColor::Warning,
        ));
    }

    notifications
}

fn mcp_segment_notification(
    key: &'static str,
    heading: String,
    color: NotificationColor,
) -> Notification {
    let text = format!("{heading} · /mcp");
    Notification::text(key, text, NotificationPriority::Medium).with_segments(vec![
        NotificationSegment::text(heading).with_color(color),
        NotificationSegment::text(" · /mcp").with_dim(true),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_connectivity_notifications_match_official_failed_local_payload() {
        let notifications = mcp_connectivity_notifications(
            &[
                McpConnectivityClient::new(
                    "local-a",
                    McpConnectionStatus::Failed,
                    McpConfigType::Local,
                ),
                McpConnectivityClient::new(
                    "local-b",
                    McpConnectionStatus::Failed,
                    McpConfigType::Local,
                ),
                McpConnectivityClient::new(
                    "ide",
                    McpConnectionStatus::Failed,
                    McpConfigType::SseIde,
                ),
            ],
            false,
        );

        assert_eq!(notifications.len(), 1);
        let notification = &notifications[0];
        assert_eq!(notification.key, MCP_FAILED_KEY);
        assert_eq!(notification.text, "2 MCP servers failed · /mcp");
        assert_eq!(notification.priority, NotificationPriority::Medium);
        assert_eq!(notification.color, None);
        assert_eq!(notification.segments.len(), 2);
        assert_eq!(notification.segments[0].text, "2 MCP servers failed");
        assert_eq!(
            notification.segments[0].color,
            Some(NotificationColor::Error)
        );
        assert_eq!(notification.segments[1].text, " · /mcp");
        assert!(notification.segments[1].dim);
    }

    #[test]
    fn mcp_connectivity_notifications_gate_claudeai_failures_on_prior_connection() {
        let notifications = mcp_connectivity_notifications(
            &[
                McpConnectivityClient::new(
                    "claude-old",
                    McpConnectionStatus::Failed,
                    McpConfigType::ClaudeAiProxy,
                )
                .with_claude_ai_ever_connected(true),
                McpConnectivityClient::new(
                    "claude-new",
                    McpConnectionStatus::Failed,
                    McpConfigType::ClaudeAiProxy,
                ),
            ],
            false,
        );

        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].key, MCP_CLAUDEAI_FAILED_KEY);
        assert_eq!(
            notifications[0].text,
            "1 claude.ai connector unavailable · /mcp"
        );
        assert_eq!(
            notifications[0].segments[0].color,
            Some(NotificationColor::Error)
        );
    }

    #[test]
    fn mcp_connectivity_notifications_match_official_auth_copy_and_order() {
        let notifications = mcp_connectivity_notifications(
            &[
                McpConnectivityClient::new(
                    "needs-a",
                    McpConnectionStatus::NeedsAuth,
                    McpConfigType::Local,
                ),
                McpConnectivityClient::new(
                    "needs-b",
                    McpConnectionStatus::NeedsAuth,
                    McpConfigType::WsIde,
                ),
                McpConnectivityClient::new(
                    "claude-auth",
                    McpConnectionStatus::NeedsAuth,
                    McpConfigType::ClaudeAiProxy,
                )
                .with_claude_ai_ever_connected(true),
            ],
            false,
        );

        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0].key, MCP_NEEDS_AUTH_KEY);
        assert_eq!(notifications[0].text, "2 MCP servers need auth · /mcp");
        assert_eq!(
            notifications[0].segments[0].color,
            Some(NotificationColor::Warning)
        );
        assert_eq!(notifications[1].key, MCP_CLAUDEAI_NEEDS_AUTH_KEY);
        assert_eq!(
            notifications[1].text,
            "1 claude.ai connector needs auth · /mcp"
        );
        assert_eq!(
            notifications[1].segments[0].color,
            Some(NotificationColor::Warning)
        );
    }

    #[test]
    fn mcp_connectivity_notifications_suppress_remote_and_clean_states() {
        let clients = [McpConnectivityClient::new(
            "ok",
            McpConnectionStatus::Connected,
            McpConfigType::Local,
        )];
        assert!(mcp_connectivity_notifications(&clients, false).is_empty());
        assert!(
            mcp_connectivity_notifications(
                &[McpConnectivityClient::new(
                    "bad",
                    McpConnectionStatus::Failed,
                    McpConfigType::Local,
                )],
                true,
            )
            .is_empty()
        );
    }
}
