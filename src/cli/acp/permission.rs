//! Translates between the SDK permission bridge and ACP `session/request_permission`.
//!
//! The bridge in `crate::cli::structured_io` asks for approval with a `can_use_tool`
//! control request and takes the answer back as a `control_response`. The functions here
//! only convert those two shapes. The bridge keeps the hooks, the normalization of the
//! answer and the persisted "always allow" rules.

use agent_client_protocol_schema::v1::{
    Diff, PermissionOption, PermissionOptionKind, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SessionId, ToolCallContent, ToolCallId,
    ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields,
};
use serde_json::{Value, json};

use super::tools::describe_tool_call;
use super::transport::RpcError;

/// Option ids offered to the client. The client answers with one of them.
const ALLOW_ONCE: &str = "allow_once";
const ALLOW_ALWAYS: &str = "allow_always";
const REJECT_ONCE: &str = "reject_once";

const REJECTED_MESSAGE: &str = "The user rejected this tool call.";
const CANCELLED_MESSAGE: &str = "The permission request was cancelled.";
const UNRECOGNIZED_MESSAGE: &str = "Unrecognized permission response from client";

/// Builds the `session/request_permission` params for one `can_use_tool` control request.
/// `request` is the `request` object of the bridge's `control_request`. The tool call is
/// described the same way as the tool call updates, and `allow_always` is offered only
/// when the bridge sent permission suggestions.
pub(super) fn permission_request_params(session_id: &str, request: &Value) -> Value {
    let tool_use_id = request
        .get("tool_use_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool_name = request
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let call = describe_tool_call(tool_use_id, tool_name, &input);

    let mut fields = ToolCallUpdateFields::new()
        .title(Some(call.title))
        .kind(Some(call.kind))
        .status(Some(ToolCallStatus::Pending))
        .locations(Some(
            call.locations
                .into_iter()
                .map(ToolCallLocation::new)
                .collect(),
        ))
        .raw_input(Some(call.raw_input));
    if let Some((path, old_text, new_text)) = call.diff {
        let diff = Diff::new(path, new_text).old_text(old_text);
        fields = fields.content(Some(vec![ToolCallContent::Diff(diff)]));
    }

    let mut options = vec![PermissionOption::new(
        ALLOW_ONCE,
        "Allow once",
        PermissionOptionKind::AllowOnce,
    )];
    if suggestions(request).is_some() {
        options.push(PermissionOption::new(
            ALLOW_ALWAYS,
            "Always allow",
            PermissionOptionKind::AllowAlways,
        ));
    }
    options.push(PermissionOption::new(
        REJECT_ONCE,
        "Reject",
        PermissionOptionKind::RejectOnce,
    ));

    let params = RequestPermissionRequest::new(
        SessionId::new(session_id.to_string()),
        ToolCallUpdate::new(ToolCallId::new(tool_use_id.to_string()), fields),
        options,
    );
    serde_json::to_value(params).unwrap_or(Value::Null)
}

/// Translates the client's answer into the `control_response` payload the bridge expects
/// for this `can_use_tool` request. A success carries the permission tool output as its
/// `response`; a failure carries an `error` message. The bridge turns either into the
/// decision for the tool call.
pub(super) fn control_response_for(request: &Value, answer: Result<Value, RpcError>) -> Value {
    let value = match answer {
        Ok(value) => value,
        Err(error) => return control_error(&error.message),
    };
    let Ok(response) = serde_json::from_value::<RequestPermissionResponse>(value) else {
        return control_error(UNRECOGNIZED_MESSAGE);
    };
    let output = match response.outcome {
        RequestPermissionOutcome::Cancelled => Some(deny(CANCELLED_MESSAGE, true)),
        RequestPermissionOutcome::Selected(selected) => match selected.option_id.0.as_ref() {
            ALLOW_ONCE => Some(allow(request, None)),
            ALLOW_ALWAYS => suggestions(request).map(|updates| allow(request, Some(updates))),
            REJECT_ONCE => Some(deny(REJECTED_MESSAGE, false)),
            _ => None,
        },
        _ => None,
    };
    match output {
        Some(output) => json!({"subtype": "success", "response": output}),
        None => control_error(UNRECOGNIZED_MESSAGE),
    }
}

/// The permission suggestions the bridge sent with the request, when there are any.
fn suggestions(request: &Value) -> Option<Value> {
    request
        .get("permission_suggestions")
        .filter(|updates| {
            updates
                .as_array()
                .is_some_and(|updates| !updates.is_empty())
        })
        .cloned()
}

/// The permission tool output that allows the tool call with its input unchanged, and
/// with `updated_permissions` persisted when given.
fn allow(request: &Value, updated_permissions: Option<Value>) -> Value {
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let mut output = json!({"behavior": "allow", "updatedInput": input});
    if let Some(updates) = updated_permissions {
        output["updatedPermissions"] = updates;
    }
    output
}

/// The permission tool output that denies the tool call. `interrupt` also stops the turn.
fn deny(message: &str, interrupt: bool) -> Value {
    let mut output = json!({"behavior": "deny", "message": message});
    if interrupt {
        output["interrupt"] = json!(true);
    }
    output
}

/// A `control_response` that reports a failure to the bridge.
fn control_error(message: &str) -> Value {
    json!({"subtype": "error", "error": message})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::permissions::permission_prompt_tool_result_schema::{
        PermissionPromptToolOutput, permission_prompt_tool_output_from_official_json,
    };

    /// An `Edit` `can_use_tool` request, with permission suggestions unless `suggest` is false.
    fn edit_request(suggest: bool) -> Value {
        let mut request = json!({
            "subtype": "can_use_tool",
            "tool_name": "Edit",
            "input": {
                "file_path": "/work/src/lib.rs",
                "old_string": "a",
                "new_string": "b"
            },
            "tool_use_id": "toolu_1",
        });
        if suggest {
            request["permission_suggestions"] = json!([{
                "type": "addRules",
                "destination": "session",
                "behavior": "allow",
                "rules": [{"toolName": "Edit"}]
            }]);
        }
        request
    }

    #[test]
    fn acp_permission_request_params_describes_the_tool_and_offers_options() {
        let params = permission_request_params("sess-1", &edit_request(true));
        assert_eq!(params["sessionId"], json!("sess-1"));
        assert_eq!(params["toolCall"]["toolCallId"], json!("toolu_1"));
        assert_eq!(params["toolCall"]["title"], json!("Edit /work/src/lib.rs"));
        assert_eq!(params["toolCall"]["kind"], json!("edit"));
        assert_eq!(params["toolCall"]["status"], json!("pending"));

        let options: Vec<(&str, &str)> = params["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|option| {
                (
                    option["optionId"].as_str().unwrap(),
                    option["kind"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            options,
            vec![
                ("allow_once", "allow_once"),
                ("allow_always", "allow_always"),
                ("reject_once", "reject_once"),
            ]
        );

        // Without suggestions, "always allow" is not offered.
        let params = permission_request_params("sess-1", &edit_request(false));
        let options: Vec<&str> = params["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|option| option["optionId"].as_str().unwrap())
            .collect();
        assert_eq!(options, vec!["allow_once", "reject_once"]);
    }

    #[test]
    fn acp_control_response_for_maps_each_outcome() {
        let request = edit_request(true);
        let input = request["input"].clone();
        let suggestions = request["permission_suggestions"].clone();
        let selected = |option: &str| -> Result<Value, RpcError> {
            Ok(json!({"outcome": {"outcome": "selected", "optionId": option}}))
        };

        let allow_once = control_response_for(&request, selected("allow_once"));
        assert_eq!(
            allow_once,
            json!({"subtype": "success", "response": {"behavior": "allow", "updatedInput": input}})
        );
        let allow_always = control_response_for(&request, selected("allow_always"));
        assert_eq!(
            allow_always,
            json!({
                "subtype": "success",
                "response": {
                    "behavior": "allow",
                    "updatedInput": input,
                    "updatedPermissions": suggestions
                }
            })
        );
        let reject = control_response_for(&request, selected("reject_once"));
        assert_eq!(
            reject,
            json!({
                "subtype": "success",
                "response": {"behavior": "deny", "message": REJECTED_MESSAGE}
            })
        );
        let cancelled =
            control_response_for(&request, Ok(json!({"outcome": {"outcome": "cancelled"}})));
        assert_eq!(
            cancelled,
            json!({
                "subtype": "success",
                "response": {
                    "behavior": "deny",
                    "message": CANCELLED_MESSAGE,
                    "interrupt": true
                }
            })
        );

        let unrecognized = json!({"subtype": "error", "error": UNRECOGNIZED_MESSAGE});
        assert_eq!(
            control_response_for(&request, selected("maybe")),
            unrecognized
        );
        assert_eq!(
            control_response_for(&request, Ok(json!({"outcome": {"outcome": "bogus"}}))),
            unrecognized
        );
        // "Always allow" was not offered for a request without suggestions.
        assert_eq!(
            control_response_for(&edit_request(false), selected("allow_always")),
            unrecognized
        );
        assert_eq!(
            control_response_for(&request, Err(RpcError::new(-32000, "client broke"))),
            json!({"subtype": "error", "error": "client broke"})
        );

        // Every success payload must parse with the bridge's own permission output parser.
        let parsed = permission_prompt_tool_output_from_official_json(&allow_once["response"]);
        assert!(matches!(
            parsed,
            Some(PermissionPromptToolOutput::Allow { ref updated_permissions, .. })
                if updated_permissions.is_empty()
        ));
        let parsed = permission_prompt_tool_output_from_official_json(&allow_always["response"]);
        assert!(matches!(
            parsed,
            Some(PermissionPromptToolOutput::Allow { ref updated_permissions, .. })
                if updated_permissions.len() == 1
        ));
        let parsed = permission_prompt_tool_output_from_official_json(&reject["response"]);
        assert!(matches!(
            parsed,
            Some(PermissionPromptToolOutput::Deny { ref message, interrupt: false, .. })
                if message == REJECTED_MESSAGE
        ));
        let parsed = permission_prompt_tool_output_from_official_json(&cancelled["response"]);
        assert!(matches!(
            parsed,
            Some(PermissionPromptToolOutput::Deny {
                interrupt: true,
                ..
            })
        ));
    }
}
