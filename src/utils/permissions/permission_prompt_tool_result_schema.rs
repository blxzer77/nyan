//! Maps to: CC `utils/permissions/PermissionPromptToolResultSchema.ts`.
//!
//! The official module validates SDK-host permission prompt tool results and
//! normalizes them into `PermissionDecision`s, applying/persisting permission
//! updates as a side effect. Nyan keeps the schema and normalization behavior
//! but returns parsed updates to the caller; it does not persist settings here.

use super::permission_result::{PermissionDecision, PermissionDecisionReason};
use super::permission_update_schema::{
    permission_update_from_official_json, permission_update_zod_schema,
};
use crate::types::permissions::PermissionUpdate;
use crate::types::tools::Tool;
use crate::utils::zod;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// Maps to: CC `decisionClassificationField`
/// (`PermissionPromptToolResultSchema.ts:37-42`) —
/// `z.enum(['user_temporary', 'user_permanent', 'user_reject'])
/// .optional().catch(undefined)`: a malformed value from the SDK host falls
/// through to `undefined` rather than rejecting the whole decision.
fn decision_classification_field() -> zod::Schema {
    zod::enumeration(vec!["user_temporary", "user_permanent", "user_reject"])
        .optional()
        .catch_undefined()
}

/// Maps to: CC's catch callback on `updatedPermissions`
/// (`PermissionPromptToolResultSchema.ts:53-59`): the swallowed error is
/// logged at warn level with its first issue's message, and the field
/// resolves to `undefined` (anthropics/claude-code#29440).
fn log_malformed_updated_permissions(error: &zod::ZodError) {
    crate::utils::debug::log_for_debugging_with_level(
        &format!(
            "Malformed updatedPermissions from SDK host ignored: {}",
            error
                .issues
                .first()
                .map(|issue| issue.message.as_str())
                .unwrap_or("unknown")
        ),
        crate::utils::debug::DebugLogLevel::Warn,
    );
}

/// Maps to: CC `outputSchema` (`PermissionPromptToolResultSchema.ts:75-77`) —
/// `z.union([PermissionAllowResultSchema(), PermissionDenyResultSchema()])`,
/// declared field for field with the CC line anchors inline. CC's
/// `lazySchema` wrapper is the `OnceLock` here.
fn output_schema() -> &'static zod::Schema {
    static SCHEMA: OnceLock<zod::Schema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        use serde_json::json;
        // CC `PermissionAllowResultSchema` (`:44-63`).
        let allow = zod::object(vec![
            // `:46` `behavior: z.literal('allow')`.
            ("behavior", zod::literal(json!("allow"))),
            // `:47` `updatedInput: z.record(z.string(), z.unknown())` — REQUIRED.
            ("updatedInput", zod::record(zod::any())),
            // `:50-59` `updatedPermissions: z.array(permissionUpdateSchema())
            // .optional().catch(ctx => { logForDebugging(...); return
            // undefined })` — the catch sits on the ARRAY, so one malformed
            // entry (or a non-array value) degrades the whole list, logged.
            (
                "updatedPermissions",
                zod::array(permission_update_zod_schema().clone())
                    .optional()
                    .catch_undefined_with(log_malformed_updated_permissions),
            ),
            // `:60` `toolUseID: z.string().optional()`.
            ("toolUseID", zod::string().optional()),
            // `:61` `decisionClassification: decisionClassificationField()`.
            ("decisionClassification", decision_classification_field()),
        ]);
        // CC `PermissionDenyResultSchema` (`:65-73`).
        let deny = zod::object(vec![
            // `:67` `behavior: z.literal('deny')`.
            ("behavior", zod::literal(json!("deny"))),
            // `:68` `message: z.string()` — REQUIRED.
            ("message", zod::string()),
            // `:69` `interrupt: z.boolean().optional()`.
            ("interrupt", zod::boolean().optional()),
            // `:70` `toolUseID: z.string().optional()`.
            ("toolUseID", zod::string().optional()),
            // `:71` `decisionClassification: decisionClassificationField()`.
            ("decisionClassification", decision_classification_field()),
        ]);
        zod::union(vec![allow, deny])
    })
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PermissionPromptToolInput {
    pub tool_name: String,
    pub input: serde_json::Map<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionDecisionClassification {
    #[serde(rename = "user_temporary")]
    UserTemporary,
    #[serde(rename = "user_permanent")]
    UserPermanent,
    #[serde(rename = "user_reject")]
    UserReject,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "behavior", rename_all = "lowercase")]
pub enum PermissionPromptToolOutput {
    Allow {
        #[serde(rename = "updatedInput")]
        updated_input: serde_json::Map<String, serde_json::Value>,
        #[serde(rename = "updatedPermissions", default)]
        updated_permissions: Vec<PermissionUpdate>,
        #[serde(rename = "toolUseID", default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        #[serde(
            rename = "decisionClassification",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        decision_classification: Option<PermissionDecisionClassification>,
    },
    Deny {
        message: String,
        #[serde(default)]
        interrupt: bool,
        #[serde(rename = "toolUseID", default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        #[serde(
            rename = "decisionClassification",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        decision_classification: Option<PermissionDecisionClassification>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct PermissionPromptToolNormalization {
    pub decision: PermissionDecision,
    pub updated_permissions: Vec<PermissionUpdate>,
    pub persisted_permissions: bool,
    pub abort_requested: bool,
}

/// Maps to: CC `outputSchema.parse(...)` consumption — the declared schema
/// above IS the per-field strictness table; see the line anchors on each
/// field. `None` is CC's `schema.parse` throwing
/// (`cli/structuredIO.ts:416-421` rejects the pending request): the caller
/// (CC `createCanUseTool`'s catch, `cli/structuredIO.ts:639-649`) turns it
/// into a `Tool permission request failed: …` deny.
///
/// The zod-port semantics carry CC exactly: `.optional()` admits ABSENCE,
/// never a wrong type (a PRESENT wrong-typed value, including `null`, fails
/// the WHOLE parse); only `.catch(...)` fields degrade in place (to an absent
/// key in the validated data); unknown extra keys are stripped, not rejected.
/// The body below only projects the already-validated `data` into the
/// existing output type.
pub fn permission_prompt_tool_output_from_official_json(
    value: &serde_json::Value,
) -> Option<PermissionPromptToolOutput> {
    let data = zod::safe_parse(output_schema(), value).ok()?;
    let object = data.as_object()?;
    let tool_use_id = object
        .get("toolUseID")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let decision_classification = object
        .get("decisionClassification")
        .and_then(serde_json::Value::as_str)
        .and_then(decision_classification_from_str);
    match object.get("behavior")?.as_str()? {
        "allow" => Some(PermissionPromptToolOutput::Allow {
            updated_input: object
                .get("updatedInput")
                .and_then(serde_json::Value::as_object)?
                .clone(),
            updated_permissions: match object.get("updatedPermissions") {
                // Absent, or degraded to undefined by the catch.
                None => Vec::new(),
                // Every entry passed `permission_update_zod_schema()` (the six
                // arms match the projection's accepted sets member for member:
                // behavior 3, destination 5, external mode 5, toolName
                // string), so each projects; a `None` here would be a
                // schema/projection divergence and fails the whole parse
                // closed.
                Some(updates) => updates
                    .as_array()?
                    .iter()
                    .map(permission_update_from_official_json)
                    .collect::<Option<Vec<_>>>()?,
            },
            tool_use_id,
            decision_classification,
        }),
        "deny" => Some(PermissionPromptToolOutput::Deny {
            message: object.get("message")?.as_str()?.to_string(),
            // CC's absent `interrupt?` is modelled as false — the only reader
            // is a falsy check (`:117`).
            interrupt: object
                .get("interrupt")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            tool_use_id,
            decision_classification,
        }),
        _ => None,
    }
}

fn decision_classification_from_str(value: &str) -> Option<PermissionDecisionClassification> {
    match value {
        "user_temporary" => Some(PermissionDecisionClassification::UserTemporary),
        "user_permanent" => Some(PermissionDecisionClassification::UserPermanent),
        "user_reject" => Some(PermissionDecisionClassification::UserReject),
        _ => None,
    }
}

/// Maps to: CC `permissionPromptToolResultToPermissionDecision(...)`.
pub fn permission_prompt_tool_result_to_permission_decision(
    result: PermissionPromptToolOutput,
    tool: &Tool,
    original_input: &serde_json::Value,
) -> PermissionPromptToolNormalization {
    let decision_reason = PermissionDecisionReason::PermissionPromptTool {
        permission_prompt_tool_name: tool.name.clone(),
        tool_result: serde_json::to_value(&result).unwrap_or(serde_json::Value::Null),
    };

    match result {
        PermissionPromptToolOutput::Allow {
            updated_input,
            updated_permissions,
            tool_use_id,
            ..
        } => {
            let input = if updated_input.is_empty() {
                original_input.clone()
            } else {
                serde_json::Value::Object(updated_input)
            };
            PermissionPromptToolNormalization {
                decision: PermissionDecision::Allow {
                    updated_input: Some(input),
                    user_modified: None,
                    decision_reason: Some(decision_reason),
                    tool_use_id,
                    accept_feedback: None,
                    content_blocks: Vec::new(),
                },
                updated_permissions,
                persisted_permissions: false,
                abort_requested: false,
            }
        }
        PermissionPromptToolOutput::Deny {
            message,
            interrupt,
            tool_use_id,
            ..
        } => PermissionPromptToolNormalization {
            decision: PermissionDecision::Deny {
                message,
                decision_reason,
                tool_use_id,
            },
            updated_permissions: Vec::new(),
            persisted_permissions: false,
            abort_requested: interrupt,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool() -> Tool {
        Tool {
            name: "PermissionPrompt".to_string(),
            input_schema: serde_json::json!({"type":"object"}),
            ..Default::default()
        }
    }

    #[test]
    fn permission_prompt_tool_output_ignores_malformed_updated_permissions() {
        let output = permission_prompt_tool_output_from_official_json(&serde_json::json!({
            "behavior": "allow",
            "updatedInput": {},
            "updatedPermissions": [{"type":"not-real"}],
            "decisionClassification": "not-real"
        }))
        .expect("allow output");
        let PermissionPromptToolOutput::Allow {
            updated_permissions,
            decision_classification,
            ..
        } = output
        else {
            panic!("expected allow");
        };
        assert!(updated_permissions.is_empty());
        assert_eq!(decision_classification, None);
    }

    /// CC's `.catch(undefined)` sits on the ARRAY: one malformed entry drops
    /// the whole list. Entry-by-entry filtering would keep the valid
    /// `setMode` update here — that is the divergence this test pins.
    #[test]
    fn permission_prompt_tool_output_drops_partly_illegal_updates_wholesale() {
        let output = permission_prompt_tool_output_from_official_json(&serde_json::json!({
            "behavior": "allow",
            "updatedInput": {},
            "updatedPermissions": [
                {"type":"setMode","mode":"acceptEdits","destination":"session"},
                {"type":"not-real"}
            ]
        }))
        .expect("allow output");
        let PermissionPromptToolOutput::Allow {
            updated_permissions,
            ..
        } = output
        else {
            panic!("expected allow");
        };
        assert!(
            updated_permissions.is_empty(),
            "a partly-illegal list must degrade wholesale, not filter entry-by-entry"
        );
    }

    /// CC's `updatedInput` is a REQUIRED `z.record`: a missing or non-object
    /// value fails `schema.parse` (→ the caller's catch denies). It must NOT
    /// fall back to the original input — only a PRESENT empty object does
    /// that, later, in the normalizer.
    #[test]
    fn permission_prompt_tool_output_requires_updated_input_on_allow() {
        assert_eq!(
            permission_prompt_tool_output_from_official_json(&serde_json::json!({
                "behavior": "allow"
            })),
            None
        );
        assert_eq!(
            permission_prompt_tool_output_from_official_json(&serde_json::json!({
                "behavior": "allow",
                "updatedInput": "not-an-object"
            })),
            None
        );
    }

    /// CC Zod `.optional()` admits absence, never a wrong type
    /// (`PermissionPromptToolResultSchema.ts:60`/`:70` `toolUseID:
    /// z.string().optional()`, `:69` `interrupt: z.boolean().optional()`,
    /// `:68` `message: z.string()`, `:47` `updatedInput: z.record(...)`,
    /// `:46`/`:67` `behavior: z.literal(...)`): a PRESENT wrong-typed field
    /// fails the WHOLE parse, which the caller maps to a synthetic deny.
    /// Regression pins: `toolUseID: 7` and `interrupt: "yes"` used to read
    /// as absent/false, so a malformed SDK allow proceeded to execution.
    #[test]
    fn permission_prompt_tool_output_rejects_wrong_typed_present_optional_fields() {
        let cases: &[(&str, serde_json::Value)] = &[
            // toolUseID — allow arm (`:60`); `7` is the regression shape.
            (
                "allow toolUseID number",
                serde_json::json!({"behavior":"allow","updatedInput":{},"toolUseID":7}),
            ),
            (
                "allow toolUseID null",
                serde_json::json!({"behavior":"allow","updatedInput":{},"toolUseID":null}),
            ),
            (
                "allow toolUseID bool",
                serde_json::json!({"behavior":"allow","updatedInput":{},"toolUseID":true}),
            ),
            (
                "allow toolUseID object",
                serde_json::json!({"behavior":"allow","updatedInput":{},"toolUseID":{"id":"x"}}),
            ),
            // toolUseID — deny arm (`:70`).
            (
                "deny toolUseID number",
                serde_json::json!({"behavior":"deny","message":"no","toolUseID":7}),
            ),
            (
                "deny toolUseID array",
                serde_json::json!({"behavior":"deny","message":"no","toolUseID":["x"]}),
            ),
            // interrupt — deny arm (`:69`); `"yes"` is the regression shape.
            (
                "deny interrupt string",
                serde_json::json!({"behavior":"deny","message":"no","interrupt":"yes"}),
            ),
            (
                "deny interrupt number",
                serde_json::json!({"behavior":"deny","message":"no","interrupt":1}),
            ),
            (
                "deny interrupt null",
                serde_json::json!({"behavior":"deny","message":"no","interrupt":null}),
            ),
            // message — REQUIRED string on deny (`:68`).
            (
                "deny message missing",
                serde_json::json!({"behavior":"deny"}),
            ),
            (
                "deny message number",
                serde_json::json!({"behavior":"deny","message":42}),
            ),
            (
                "deny message null",
                serde_json::json!({"behavior":"deny","message":null}),
            ),
            // updatedInput — REQUIRED record on allow (`:47`).
            (
                "allow updatedInput array",
                serde_json::json!({"behavior":"allow","updatedInput":[]}),
            ),
            (
                "allow updatedInput null",
                serde_json::json!({"behavior":"allow","updatedInput":null}),
            ),
            // behavior — the union literals (`:46`/`:67`).
            ("behavior unknown", serde_json::json!({"behavior":"ask"})),
            ("behavior number", serde_json::json!({"behavior":7})),
            ("behavior missing", serde_json::json!({"message":"no"})),
            ("non-object response", serde_json::json!("allow")),
        ];
        for (name, value) in cases {
            assert_eq!(
                permission_prompt_tool_output_from_official_json(value),
                None,
                "case `{name}` must fail the whole parse like CC `schema.parse`"
            );
        }
    }

    /// CC `.catch(undefined)` fields degrade in place and never reject:
    /// `decisionClassification` (`:37-42`, both arms — enum mismatch, wrong
    /// type, and `null` all fall through to `undefined`) and
    /// `updatedPermissions` (`:50-59`, allow arm — non-array values drop the
    /// whole list). A valid classification still parses.
    #[test]
    fn permission_prompt_tool_output_catch_fields_degrade_without_rejecting() {
        for bad in [
            serde_json::json!(5),
            serde_json::json!("not-real"),
            serde_json::json!(null),
            serde_json::json!({"k":1}),
        ] {
            let allow = permission_prompt_tool_output_from_official_json(&serde_json::json!({
                "behavior":"allow",
                "updatedInput":{},
                "decisionClassification": bad,
            }))
            .expect("catch degrades, never rejects (allow arm)");
            assert!(matches!(
                allow,
                PermissionPromptToolOutput::Allow {
                    decision_classification: None,
                    ..
                }
            ));
            let deny = permission_prompt_tool_output_from_official_json(&serde_json::json!({
                "behavior":"deny",
                "message":"no",
                "decisionClassification": bad,
            }))
            .expect("catch degrades, never rejects (deny arm)");
            assert!(matches!(
                deny,
                PermissionPromptToolOutput::Deny {
                    decision_classification: None,
                    ..
                }
            ));
        }
        for bad in [
            serde_json::json!("nope"),
            serde_json::json!(null),
            serde_json::json!(7),
        ] {
            let output = permission_prompt_tool_output_from_official_json(&serde_json::json!({
                "behavior":"allow",
                "updatedInput":{},
                "updatedPermissions": bad,
            }))
            .expect("updatedPermissions catch degrades, never rejects");
            assert!(matches!(
                output,
                PermissionPromptToolOutput::Allow {
                    ref updated_permissions,
                    ..
                } if updated_permissions.is_empty()
            ));
        }
        let valid = permission_prompt_tool_output_from_official_json(&serde_json::json!({
            "behavior":"deny",
            "message":"no",
            "decisionClassification":"user_permanent",
        }))
        .expect("valid classification parses");
        assert!(matches!(
            valid,
            PermissionPromptToolOutput::Deny {
                decision_classification: Some(PermissionDecisionClassification::UserPermanent),
                ..
            }
        ));
    }

    /// Zod objects STRIP unknown keys rather than rejecting; a well-typed
    /// response with extra keys must still parse.
    #[test]
    fn permission_prompt_tool_output_strips_unknown_keys() {
        assert!(
            permission_prompt_tool_output_from_official_json(&serde_json::json!({
                "behavior":"allow",
                "updatedInput":{},
                "someFutureKey":{"nested":true},
            }))
            .is_some()
        );
    }

    #[test]
    fn permission_prompt_tool_result_uses_original_input_for_empty_allow_input() {
        let output = permission_prompt_tool_output_from_official_json(&serde_json::json!({
            "behavior": "allow",
            "updatedInput": {},
            "toolUseID": "toolu_1"
        }))
        .unwrap();
        let normalized = permission_prompt_tool_result_to_permission_decision(
            output,
            &tool(),
            &serde_json::json!({"command":"echo hi"}),
        );
        let PermissionDecision::Allow {
            updated_input,
            tool_use_id,
            decision_reason,
            ..
        } = normalized.decision
        else {
            panic!("expected allow decision");
        };
        assert_eq!(
            updated_input,
            Some(serde_json::json!({"command":"echo hi"}))
        );
        assert_eq!(tool_use_id.as_deref(), Some("toolu_1"));
        assert!(matches!(
            decision_reason,
            Some(PermissionDecisionReason::PermissionPromptTool { .. })
        ));
        assert!(!normalized.persisted_permissions);
    }

    #[test]
    fn permission_prompt_tool_deny_interrupt_requests_abort_without_aborting_here() {
        let output = permission_prompt_tool_output_from_official_json(&serde_json::json!({
            "behavior": "deny",
            "message": "no",
            "interrupt": true
        }))
        .unwrap();
        let normalized = permission_prompt_tool_result_to_permission_decision(
            output,
            &tool(),
            &serde_json::json!({}),
        );
        assert!(normalized.abort_requested);
        assert!(matches!(
            normalized.decision,
            PermissionDecision::Deny { .. }
        ));
    }
}
