//! Generic MCP tool boundary.
//!
//! Maps to: CC `tools/MCPTool/MCPTool.ts`.
//!
//! Dynamic MCP tools are created from live MCP client capabilities in
//! `services/mcp/client.ts#fetchToolsForClient`. In Nyan, live dynamic tool
//! execution is dispatched from `services/tools/tool_execution.rs` using the
//! same runtime MCP state. This module preserves the official generic
//! `MCPTool` ToolDef boundary plus transcript UI helpers; it does not start
//! clients or own MCP runtime state.

pub mod classify_for_collapse;
pub mod prompt;
pub mod ui;

/// Maps to: CC `tools/MCPTool/MCPTool.ts` `inputSchema` passthrough object.
/// Maps to: CC `MCPTool.ts:14` `inputSchema` — `z.object({}).passthrough()`.
///
/// The passthrough is the point: `mcpClient.ts` overrides name and args per
/// server tool, so the placeholder must admit any key. It projects
/// `additionalProperties: {}`, not `true` and not `false`.
pub fn input_schema() -> &'static crate::utils::zod::Schema {
    static SCHEMA: std::sync::OnceLock<crate::utils::zod::Schema> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| crate::utils::zod::passthrough_object(vec![]))
}

pub fn mcp_tool_schema() -> crate::types::tools::Tool {
    crate::types::tools::Tool {
        name: prompt::MCP_TOOL_NAME.to_string(),
        description: prompt::DESCRIPTION.to_string(),
        input_schema: crate::utils::zod_to_json_schema::zod_to_json_schema(input_schema()),
        is_mcp: true,
        ..Default::default()
    }
}

/// CC `tools/MCPTool/MCPTool.ts` outputSchema: string MCP tool execution result.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct McpOutput(pub(crate) String);

/// Behavioral half of CC `MCPTool` generic ToolDef. Dynamic server-specific
/// MCP tools override name/description/prompt/call in the MCP client layer.
pub(crate) struct McpTool;

/// Maps to: CC `services/mcp/client.ts:1814-1832` — the per-server override of
/// `MCPTool.checkPermissions`, which is what live MCP tools actually run. The
/// `passthrough` behavior hands the decision back to the rule engine instead of
/// allowing the call outright, and the suggestion lets the user persist an
/// allow-rule for the fully qualified tool name.
///
/// Awaiting the dynamic-tool dispatch seam: `find_tool_call` resolves by exact
/// name, so `mcp__server__tool` does not reach [`McpTool`] yet.
pub fn mcp_tool_check_permissions(
    fully_qualified_name: &str,
) -> crate::utils::permissions::permission_result::PermissionResult {
    use crate::types::permissions::{
        PermissionBehavior, PermissionRuleValue, PermissionUpdate, PermissionUpdateDestination,
    };

    crate::utils::permissions::permission_result::PermissionResult::Passthrough {
        message: MCP_TOOL_PERMISSION_MESSAGE.to_string(),
        decision_reason: None,
        suggestions: vec![PermissionUpdate::AddRules {
            destination: PermissionUpdateDestination::LocalSettings,
            behavior: PermissionBehavior::Allow,
            rules: vec![PermissionRuleValue::new(fully_qualified_name, None)],
        }],
        blocked_path: None,
        pending_classifier_check: None,
    }
}

/// Maps to: CC `MCPTool.ts:59` / `client.ts:1817`.
const MCP_TOOL_PERMISSION_MESSAGE: &str = "MCPTool requires permission.";

impl crate::tool::ToolCall for McpTool {
    fn name(&self) -> &'static str {
        prompt::MCP_TOOL_NAME
    }

    /// Maps to: CC `MCPTool.ts:41-43` `async prompt() { return PROMPT }` —
    /// the generic template tool only. Real per-server MCP tool instances
    /// spread this base and REPLACE `prompt()` with the server description
    /// (`services/mcp/client.ts:1770-1794`); those never dispatch here (their
    /// wire names are `mcp__server__tool` / the unprefixed server name, not
    /// `MCP_TOOL_NAME`) and are read from `Tool.description` at the
    /// serialization site instead.
    fn prompt(
        &self,
        _tool: &crate::types::tools::Tool,
        _options: &crate::tool::ToolPromptOptions<'_>,
    ) -> String {
        prompt::DESCRIPTION.to_string()
    }

    /// Maps to: CC `MCPTool.maxResultSizeChars` (MCPTool.ts:35).
    fn max_result_size_chars(&self) -> usize {
        100_000
    }

    /// Maps to: CC `MCPTool.isOpenWorld()` (MCPTool.ts:30-32) — the generic
    /// placeholder; live tools override it from `annotations.openWorldHint`.
    fn is_open_world(&self, _args: &serde_json::Value) -> bool {
        false
    }

    /// Maps to: CC `MCPTool.userFacingName()` (MCPTool.ts:64).
    fn user_facing_name(&self, _args: Option<&serde_json::Value>) -> String {
        prompt::MCP_TOOL_NAME.to_string()
    }

    /// Maps to: CC `MCPTool.checkPermissions()` (MCPTool.ts:56-61) — the
    /// generic boundary carries no suggestions; see
    /// [`mcp_tool_check_permissions`] for the per-server override.
    fn check_permissions(
        &self,
        _args: &serde_json::Value,
        _context: &crate::tool::ToolUseContext,
    ) -> crate::utils::permissions::permission_result::PermissionResult {
        crate::utils::permissions::permission_result::PermissionResult::Passthrough {
            message: MCP_TOOL_PERMISSION_MESSAGE.to_string(),
            decision_reason: None,
            suggestions: Vec::new(),
            blocked_path: None,
            pending_classifier_check: None,
        }
    }

    fn call<'a>(
        &'a self,
        _args: &'a serde_json::Value,
        _request: &'a crate::types::permissions::PermissionRequest,
        _context: &'a crate::tool::ToolUseContext,
        _can_use_tool: Option<crate::tool::CanUseToolFn<'a>>,
        _parent_message: Option<&'a crate::types::message::AssistantMessage>,
        _on_progress: Option<crate::tool::ToolCallProgressFn<'a>>,
    ) -> futures::future::BoxFuture<'a, crate::tool::ToolResult> {
        Box::pin(async move {
            crate::tool::ToolResult {
                data: crate::tool::ToolOutput::Mcp(McpOutput(String::new())),
                new_messages: Vec::new(),
            }
        })
    }

    /// Maps to: CC `MCPTool.mapToolResultToToolResultBlockParam(content, id)`.
    fn map_tool_result_to_tool_result_block_param(
        &self,
        data: &crate::tool::ToolOutput,
        _tool_use_id: &str,
    ) -> (String, crate::types::message::ToolResultStatus) {
        match data {
            crate::tool::ToolOutput::Mcp(output) => (
                output.0.clone(),
                crate::types::message::ToolResultStatus::Success,
            ),
            crate::tool::ToolOutput::Composed {
                content, status, ..
            } => (content.clone(), *status),
            _ => (
                "<tool_use_error>MCP returned an unexpected output variant</tool_use_error>"
                    .to_string(),
                crate::types::message::ToolResultStatus::Error,
            ),
        }
    }

    /// Maps to: CC `MCPTool.isResultTruncated(output)` (MCPTool.ts:67-69) —
    /// `isOutputLineTruncated` imported from `utils/terminal.js` (`MCPTool.ts:5`),
    /// i.e. the shared probe, not a private copy.
    fn is_result_truncated(&self, data: &crate::tool::ToolOutput) -> bool {
        match data {
            crate::tool::ToolOutput::Mcp(output) => {
                crate::utils::terminal::is_output_line_truncated(&output.0)
            }
            _ => false,
        }
    }

    /// Maps to: CC recording the MCP `call()` data as the message's
    /// `toolUseResult` — the fallback MCPTool's data is a bare string
    /// (`MCPTool.ts:51-55`); live dynamic tools record the content-blocks
    /// value at the execution seam.
    fn tool_use_result(&self, data: &crate::tool::ToolOutput) -> Option<serde_json::Value> {
        match data {
            crate::tool::ToolOutput::Mcp(output) => {
                Some(serde_json::Value::String(output.0.clone()))
            }
            crate::tool::ToolOutput::Composed {
                content,
                status: crate::types::message::ToolResultStatus::Error,
                ..
            } => {
                let message = crate::utils::messages::extract_tag(content, "tool_use_error")
                    .unwrap_or_else(|| content.clone());
                Some(serde_json::Value::String(message))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::tool::ToolCall;

    #[test]
    fn mcp_tool_schema_matches_official_generic_passthrough_shape() {
        let schema = super::mcp_tool_schema();
        assert_eq!(schema.name, "mcp");
        assert!(schema.is_mcp);
        assert_eq!(schema.description, "");
        // `z.object({}).passthrough()` — `additionalProperties` is an empty
        // schema, not `true`, and `properties` is present but empty.
        assert_eq!(
            schema.input_schema,
            serde_json::json!({
                "$schema": crate::utils::zod::JSON_SCHEMA_DRAFT,
                "type": "object",
                "properties": {},
                "additionalProperties": {},
            })
        );
    }

    #[test]
    fn mcp_output_truncation_uses_the_shared_terminal_probe() {
        // `MCPTool.ts:5,68` imports `isOutputLineTruncated` from
        // `utils/terminal.js`; the probe itself is covered by that module's own
        // test. This pins the wiring through `MCPTool.isResultTruncated`.
        let truncated = super::McpTool.is_result_truncated(&crate::tool::ToolOutput::Mcp(
            super::McpOutput("a\nb\nc\nd\ne".to_string()),
        ));
        let not_truncated = super::McpTool.is_result_truncated(&crate::tool::ToolOutput::Mcp(
            super::McpOutput("a\nb\nc\nd\n".to_string()),
        ));
        assert!(truncated);
        assert!(!not_truncated);
    }

    #[test]
    fn mcp_tool_check_permissions_passes_through_instead_of_allowing() {
        use crate::types::permissions::{
            PermissionBehavior, PermissionUpdate, PermissionUpdateDestination,
        };
        use crate::utils::permissions::permission_result::PermissionResult;

        let generic = super::McpTool.check_permissions(
            &serde_json::json!({}),
            &crate::tool::ToolUseContext::default(),
        );
        match generic {
            PermissionResult::Passthrough {
                message,
                suggestions,
                ..
            } => {
                assert_eq!(message, "MCPTool requires permission.");
                assert!(suggestions.is_empty());
            }
            other => panic!("MCPTool must not allow outright: {other:?}"),
        }

        match super::mcp_tool_check_permissions("mcp__github__create_issue") {
            PermissionResult::Passthrough {
                message,
                suggestions,
                ..
            } => {
                assert_eq!(message, "MCPTool requires permission.");
                let [
                    PermissionUpdate::AddRules {
                        destination,
                        behavior,
                        rules,
                    },
                ] = suggestions.as_slice()
                else {
                    panic!("expected a single addRules suggestion");
                };
                assert_eq!(*destination, PermissionUpdateDestination::LocalSettings);
                assert_eq!(*behavior, PermissionBehavior::Allow);
                assert_eq!(rules.len(), 1);
                assert_eq!(rules[0].tool_name, "mcp__github__create_issue");
                assert_eq!(rules[0].rule_content, None);
            }
            other => panic!("live MCP tools must pass through: {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn generic_mcp_tool_call_returns_official_empty_string_default() {
        let args = serde_json::json!({ "anything": true });
        let request = crate::utils::permissions::permissions::mock_permission_request_with_input(
            "perm-mcp".to_string(),
            "toolu_mcp".to_string(),
            "mcp".to_string(),
            "mcp".to_string(),
            args.clone(),
            crate::types::permissions::PermissionMode::Default,
        );
        let tool = super::McpTool;
        let result = tool
            .call(
                &args,
                &request,
                &crate::tool::ToolUseContext::default(),
                None,
                None,
                None,
            )
            .await;
        let crate::tool::ToolOutput::Mcp(output) = result.data else {
            panic!("MCPTool should return typed MCP output");
        };
        assert_eq!(output.0, "");
        let data = crate::tool::ToolOutput::Mcp(output);
        let (content, status) = tool.map_tool_result_to_tool_result_block_param(&data, "toolu_mcp");
        assert_eq!(content, "");
        assert_eq!(status, crate::types::message::ToolResultStatus::Success);
        // No display shape — the trait projects the raw string output.
        assert_eq!(
            tool.tool_use_result(&data),
            Some(serde_json::Value::String(String::new()))
        );
    }
}
