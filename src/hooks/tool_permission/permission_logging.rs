//! Maps to: CC `hooks/toolPermission/permissionLogging.ts`.
//!
//! Official code fans out to analytics, OTel, and code-edit counters. Telemetry
//! is intentionally disabled in Nyan; this module preserves the official
//! decision/source/event/attribute shaping as pure records.

use super::permission_context::{
    PermissionApprovalSource, PermissionDecisionLogArgs, PermissionRejectionSource,
};
use crate::types::tools::Tool;
use std::collections::BTreeMap;

pub const CODE_EDITING_TOOLS: &[&str] = &["Edit", "Write", "NotebookEdit"];

#[derive(Clone, Debug, PartialEq)]
pub struct PermissionLogContext {
    pub tool: Tool,
    pub input: serde_json::Value,
    pub message_id: String,
    pub tool_use_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionDecisionLogRecord {
    pub analytics_event: String,
    pub decision: String,
    pub source: String,
    pub tool_name: String,
    pub message_id: String,
    pub tool_use_id: String,
    pub waiting_for_user_permission_ms: Option<i64>,
    pub sandbox_enabled: bool,
    pub code_edit_attributes: Option<BTreeMap<String, String>>,
    pub telemetry_sent: bool,
}

/// Maps to: CC `isCodeEditingTool(...)`.
pub fn is_code_editing_tool(tool_name: &str) -> bool {
    CODE_EDITING_TOOLS.contains(&tool_name)
}

/// Maps to: CC `sourceToString(...)`.
pub fn approval_source_to_string(source: &PermissionApprovalSource) -> &'static str {
    match source {
        PermissionApprovalSource::Classifier => "classifier",
        PermissionApprovalSource::Hook { .. } => "hook",
        PermissionApprovalSource::User { permanent } => {
            if *permanent {
                "user_permanent"
            } else {
                "user_temporary"
            }
        }
    }
}

/// Maps to: CC `sourceToString(...)` rejection cases.
pub fn rejection_source_to_string(source: &PermissionRejectionSource) -> &'static str {
    match source {
        PermissionRejectionSource::Hook => "hook",
        PermissionRejectionSource::UserAbort => "user_abort",
        PermissionRejectionSource::UserReject { .. } => "user_reject",
    }
}

fn analytics_event_for_decision(args: &PermissionDecisionLogArgs) -> &'static str {
    match args {
        PermissionDecisionLogArgs::AcceptConfig => "tengu_tool_use_granted_in_config",
        PermissionDecisionLogArgs::Accept(PermissionApprovalSource::Classifier) => {
            "tengu_tool_use_granted_by_classifier"
        }
        PermissionDecisionLogArgs::Accept(PermissionApprovalSource::User { permanent }) => {
            if *permanent {
                "tengu_tool_use_granted_in_prompt_permanent"
            } else {
                "tengu_tool_use_granted_in_prompt_temporary"
            }
        }
        PermissionDecisionLogArgs::Accept(PermissionApprovalSource::Hook { .. }) => {
            "tengu_tool_use_granted_by_permission_hook"
        }
        PermissionDecisionLogArgs::RejectConfig => "tengu_tool_use_denied_in_config",
        PermissionDecisionLogArgs::Reject(_) => "tengu_tool_use_rejected_in_prompt",
    }
}

fn decision_and_source(args: &PermissionDecisionLogArgs) -> (&'static str, &'static str) {
    match args {
        PermissionDecisionLogArgs::Accept(source) => ("accept", approval_source_to_string(source)),
        PermissionDecisionLogArgs::AcceptConfig => ("accept", "config"),
        PermissionDecisionLogArgs::Reject(source) => ("reject", rejection_source_to_string(source)),
        PermissionDecisionLogArgs::RejectConfig => ("reject", "config"),
    }
}

fn file_path_from_code_edit_input(tool_name: &str, input: &serde_json::Value) -> Option<String> {
    match tool_name {
        "Edit" | "Write" => input
            .get("file_path")
            .or_else(|| input.get("path"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        "NotebookEdit" => input
            .get("notebook_path")
            .or_else(|| input.get("file_path"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

/// Maps to: CC `buildCodeEditToolAttributes(...)`.
pub fn build_code_edit_tool_attributes(
    tool: &Tool,
    input: &serde_json::Value,
    decision: &str,
    source: &str,
) -> BTreeMap<String, String> {
    let mut attributes = BTreeMap::new();
    attributes.insert("decision".to_string(), decision.to_string());
    attributes.insert("source".to_string(), source.to_string());
    attributes.insert("tool_name".to_string(), tool.name.clone());
    if let Some(file_path) = file_path_from_code_edit_input(&tool.name, input) {
        let language = crate::utils::cli_highlight::get_language_name(&file_path);
        if language != "unknown" {
            attributes.insert("language".to_string(), language);
        }
    }
    attributes
}

/// Maps to: CC `logPermissionDecision(...)`.
///
/// Safety behavior: telemetry/analytics/counters are not emitted. The returned
/// record includes `telemetry_sent=false` and can be stored by the caller if it
/// needs the official `toolDecisions` equivalent.
pub fn log_permission_decision_record(
    ctx: &PermissionLogContext,
    args: PermissionDecisionLogArgs,
    permission_prompt_start_time_ms: Option<i64>,
    now_ms: i64,
    sandbox_enabled: bool,
) -> PermissionDecisionLogRecord {
    let (decision, source) = decision_and_source(&args);
    let wait = permission_prompt_start_time_ms.map(|start| now_ms.saturating_sub(start));
    PermissionDecisionLogRecord {
        analytics_event: analytics_event_for_decision(&args).to_string(),
        decision: decision.to_string(),
        source: source.to_string(),
        tool_name: ctx.tool.name.clone(),
        message_id: ctx.message_id.clone(),
        tool_use_id: ctx.tool_use_id.clone(),
        waiting_for_user_permission_ms: wait,
        sandbox_enabled,
        code_edit_attributes: is_code_editing_tool(&ctx.tool.name)
            .then(|| build_code_edit_tool_attributes(&ctx.tool, &ctx.input, decision, source)),
        telemetry_sent: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str) -> Tool {
        Tool {
            name: name.to_string(),
            input_schema: serde_json::json!({"type":"object"}),
            ..Default::default()
        }
    }

    #[test]
    fn permission_logging_source_and_event_names_match_official() {
        let ctx = PermissionLogContext {
            tool: tool("Bash"),
            input: serde_json::json!({"command":"echo hi"}),
            message_id: "msg_1".to_string(),
            tool_use_id: "toolu_1".to_string(),
        };
        let record = log_permission_decision_record(
            &ctx,
            PermissionDecisionLogArgs::Accept(PermissionApprovalSource::User { permanent: true }),
            Some(100),
            175,
            true,
        );
        assert_eq!(
            record.analytics_event,
            "tengu_tool_use_granted_in_prompt_permanent"
        );
        assert_eq!(record.decision, "accept");
        assert_eq!(record.source, "user_permanent");
        assert_eq!(record.waiting_for_user_permission_ms, Some(75));
        assert!(record.sandbox_enabled);
        assert!(!record.telemetry_sent);

        let reject = log_permission_decision_record(
            &ctx,
            PermissionDecisionLogArgs::Reject(PermissionRejectionSource::UserReject {
                has_feedback: true,
            }),
            None,
            200,
            false,
        );
        assert_eq!(reject.analytics_event, "tengu_tool_use_rejected_in_prompt");
        assert_eq!(reject.source, "user_reject");
    }

    #[test]
    fn code_edit_attributes_include_language_when_path_is_available() {
        let ctx = PermissionLogContext {
            tool: tool("Edit"),
            input: serde_json::json!({"file_path":"src/main.rs"}),
            message_id: "msg_2".to_string(),
            tool_use_id: "toolu_2".to_string(),
        };
        let record = log_permission_decision_record(
            &ctx,
            PermissionDecisionLogArgs::Accept(PermissionApprovalSource::Hook {
                permanent: Some(false),
            }),
            None,
            0,
            false,
        );
        let attrs = record.code_edit_attributes.expect("code edit attrs");
        assert_eq!(attrs.get("decision").map(String::as_str), Some("accept"));
        assert_eq!(attrs.get("source").map(String::as_str), Some("hook"));
        assert_eq!(attrs.get("tool_name").map(String::as_str), Some("Edit"));
        assert_eq!(attrs.get("language").map(String::as_str), Some("Rust"));
    }
}
