//! Maps to CC `tools/RemoteTriggerTool/prompt.ts`.

pub const REMOTE_TRIGGER_TOOL_NAME: &str = "RemoteTrigger";

pub const DESCRIPTION: &str = "Manage scheduled remote Claude Code agents (triggers) via the claude.ai CCR API. Auth is handled in-process — the token never reaches the shell.";

pub const PROMPT: &str = r#"Call the claude.ai remote-trigger API. Use this instead of curl — the OAuth token is added automatically in-process and never exposed.

Actions:
- list: GET /v1/code/triggers
- get: GET /v1/code/triggers/{trigger_id}
- create: POST /v1/code/triggers (requires body)
- update: POST /v1/code/triggers/{trigger_id} (requires body, partial update)
- run: POST /v1/code/triggers/{trigger_id}/run

The response is the raw JSON from the API."#;

/// Maps to CC `RemoteTriggerTool.isEnabled()` (`RemoteTriggerTool.ts:57-62`).
/// Nyan reads the hardcoded feature-switch collection instead of GrowthBook;
/// the enterprise policy gate resolves through the ported on-disk policy cache.
pub fn is_remote_trigger_tool_enabled() -> bool {
    crate::utils::feature_flags::feature_enabled(
        crate::utils::feature_flags::FeatureFlag::RemoteTrigger,
    ) && crate::services::policy_limits::is_policy_allowed("allow_remote_sessions")
}
