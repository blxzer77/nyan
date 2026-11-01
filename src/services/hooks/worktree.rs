//! Worktree hook execution.
//! Maps to: CC utils/hooks.ts:4910-5004 (hasWorktreeCreateHook,
//! executeWorktreeCreateHook, executeWorktreeRemoveHook).

use super::exec::exec_command_hook;
use super::matching::get_matching_hooks;
use super::{HookEvent, RegisteredHooks};
use serde_json::Value;
use std::time::Duration;

const TOOL_HOOK_TIMEOUT_MS: u64 = 30_000;

/// Maps to: CC `executeWorktreeCreateHook(...)` return shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeCreateHookResult {
    pub worktree_path: String,
}

/// Maps to: CC `hasWorktreeCreateHook()` for settings-file hooks.
///
/// Registered plugin/SDK callback hooks are not yet present in Nyan; this
/// helper intentionally checks the same merged `HooksConfig` that execution
/// consumes, so it cannot return true for hooks that execution would filter out.
pub fn has_worktree_create_hook(config: &RegisteredHooks) -> bool {
    config
        .get(HookEvent::WorktreeCreate.as_str())
        .is_some_and(|entries| !entries.is_empty())
}

fn build_hook_input(mut base_input: Value, event_fields: &[(&str, Value)]) -> String {
    let mut object = base_input.as_object_mut().cloned().unwrap_or_default();
    for (key, value) in event_fields {
        object.insert((*key).to_string(), value.clone());
    }
    Value::Object(object).to_string()
}

/// Maps to: CC `executeWorktreeCreateHook(name)` (hooks.ts:4928-4966).
///
/// Official behavior executes all configured `WorktreeCreate` hooks via the
/// normal outside-REPL hook pipeline and returns the first successful hook with
/// non-empty stdout as the worktree path. Failing hooks are summarized in the
/// thrown error when no successful output exists.
pub async fn execute_worktree_create_hook(
    config: &RegisteredHooks,
    name: &str,
    base_input: Value,
    base_env: Vec<(String, String)>,
) -> Result<WorktreeCreateHookResult, String> {
    // Maps to: CC `hooks.ts:3016-3036`, reached through
    // `executeHooksOutsideREPL({hookInput, timeoutMs})` (`:4937-4940`) with no
    // `matchQuery`. A gated call gets `[]` back, finds no `successfulResult`,
    // and throws with an EMPTY `failedOutputs` — i.e. exactly the
    // "no successful output" text [`worktree_create_failure`] produces.
    if crate::services::hooks::should_skip_hook_execution(HookEvent::WorktreeCreate, "") {
        return Err(worktree_create_failure(&[]));
    }
    let matched = get_matching_hooks(config, HookEvent::WorktreeCreate, "", None);
    let input_str = build_hook_input(
        base_input,
        &[
            (
                "hook_event_name",
                Value::String("WorktreeCreate".to_string()),
            ),
            ("name", Value::String(name.to_string())),
        ],
    );

    let mut failed_outputs = Vec::new();
    for hook in &matched {
        // CC hooks.ts:2147 — callback hooks resolve via the SDK consumer.
        match &hook.hook {
            crate::schemas::hooks::RegisteredHook::Callback(callback) => {
                let json = super::exec::exec_callback_hook(callback, &input_str, None).await;
                // CC hooks.ts:3116-3123 — WorktreeCreate callbacks yield the
                // path via hookSpecificOutput.worktreePath, falling back to
                // systemMessage; a resolved callback never joins failedOutputs.
                let output = json
                    .hook_specific_output
                    .as_ref()
                    .filter(|specific| {
                        specific.hook_event_name.as_deref() == Some("WorktreeCreate")
                    })
                    .and_then(|specific| specific.worktree_path.clone())
                    .or_else(|| json.system_message.clone())
                    .unwrap_or_default();
                if !output.trim().is_empty() {
                    return Ok(WorktreeCreateHookResult {
                        worktree_path: output.trim().to_string(),
                    });
                }
            }
            crate::schemas::hooks::RegisteredHook::Command(command) => {
                let timeout = command.timeout.unwrap_or(TOOL_HOOK_TIMEOUT_MS / 1000) * 1000;
                let exec_result = exec_command_hook(
                    &command.command,
                    &input_str,
                    Duration::from_millis(timeout),
                    base_env.clone(),
                    hook.plugin_root.as_deref(),
                    hook.plugin_id.as_deref(),
                    None,
                )
                .await;

                if exec_result.status == 0 && !exec_result.stdout.trim().is_empty() {
                    return Ok(WorktreeCreateHookResult {
                        worktree_path: exec_result.stdout.trim().to_string(),
                    });
                }

                let stderr = exec_result.stderr.trim();
                let stdout = exec_result.stdout.trim();
                let output = if !stderr.is_empty() {
                    stderr
                } else if !stdout.is_empty() {
                    stdout
                } else {
                    "no output"
                };
                failed_outputs.push(format!("{}: {}", command.command, output));
            }
        }
    }

    Err(worktree_create_failure(&failed_outputs))
}

/// Maps to: CC `hooks.ts:4948-4953` — the thrown message, whose
/// `failedOutputs.join('; ') || 'no successful output'` falls back on an empty
/// list. Extracted so the gated early return and the exhausted-loop return
/// cannot drift apart.
fn worktree_create_failure(failed_outputs: &[String]) -> String {
    format!(
        "WorktreeCreate hook failed: {}",
        if failed_outputs.is_empty() {
            "no successful output".to_string()
        } else {
            failed_outputs.join("; ")
        }
    )
}

/// Maps to: CC `executeWorktreeRemoveHook(worktreePath)` (hooks.ts:4967-5004).
///
/// Returns true when `WorktreeRemove` hooks are configured and executed, false
/// when no hooks are configured. Individual failing hook outputs are ignored at
/// this boundary just like CC, which logs failures and still returns true after
/// attempting the configured hooks.
pub async fn execute_worktree_remove_hook(
    config: &RegisteredHooks,
    worktree_path: &str,
    base_input: Value,
    base_env: Vec<(String, String)>,
) -> bool {
    // Maps to: CC `hooks.ts:3016-3036`, reached through
    // `executeHooksOutsideREPL({hookInput, timeoutMs})` (`:4984-4987`) with no
    // `matchQuery`. A gated call gets `[]`, which CC turns into `false` at
    // `:4989-4991` — the same answer the empty-matched branch below gives.
    if crate::services::hooks::should_skip_hook_execution(HookEvent::WorktreeRemove, "") {
        return false;
    }
    let matched = get_matching_hooks(config, HookEvent::WorktreeRemove, "", None);
    if matched.is_empty() {
        return false;
    }

    let input_str = build_hook_input(
        base_input,
        &[
            (
                "hook_event_name",
                Value::String("WorktreeRemove".to_string()),
            ),
            ("worktree_path", Value::String(worktree_path.to_string())),
        ],
    );

    for hook in &matched {
        // CC hooks.ts:2147 — callback hooks resolve via the SDK consumer.
        match &hook.hook {
            crate::schemas::hooks::RegisteredHook::Callback(callback) => {
                let _ = super::exec::exec_callback_hook(callback, &input_str, None).await;
            }
            crate::schemas::hooks::RegisteredHook::Command(command) => {
                let timeout = command.timeout.unwrap_or(TOOL_HOOK_TIMEOUT_MS / 1000) * 1000;
                let _ = exec_command_hook(
                    &command.command,
                    &input_str,
                    Duration::from_millis(timeout),
                    base_env.clone(),
                    hook.plugin_root.as_deref(),
                    hook.plugin_id.as_deref(),
                    None,
                )
                .await;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(value: serde_json::Value) -> RegisteredHooks {
        let config: crate::services::hooks::HooksConfig = serde_json::from_value(value).unwrap();
        crate::services::hooks::test_support::registered_config(&config)
    }

    #[tokio::test]
    async fn worktree_create_hook_returns_first_successful_stdout_path() {
        let _trust = crate::services::hooks::test_support::SessionTrustGuard::accepted();
        let config = config(serde_json::json!({
            "WorktreeCreate": [
                { "hooks": [
                    { "command": "sh -c 'echo failed >&2; exit 1'", "timeout": 5 },
                    { "command": "printf '/tmp/nyan-hook-worktree\\n'", "timeout": 5 }
                ] }
            ]
        }));

        assert!(has_worktree_create_hook(&config));
        let result = execute_worktree_create_hook(
            &config,
            "agent-1234",
            serde_json::json!({ "session_id": "s1" }),
            vec![],
        )
        .await
        .unwrap();
        assert_eq!(result.worktree_path, "/tmp/nyan-hook-worktree");
    }

    #[tokio::test]
    async fn worktree_remove_hook_matches_remove_event_not_create_event() {
        let _trust = crate::services::hooks::test_support::SessionTrustGuard::accepted();
        let marker = std::env::temp_dir().join(format!(
            "nyan-worktree-remove-hook-{}",
            uuid::Uuid::new_v4()
        ));
        let command = format!("printf removed > {}", marker.display());
        let config = config(serde_json::json!({
            "WorktreeCreate": [
                { "hooks": [{ "command": "sh -c 'exit 42'", "timeout": 5 }] }
            ],
            "WorktreeRemove": [
                { "hooks": [{ "command": command, "timeout": 5 }] }
            ]
        }));

        let ran = execute_worktree_remove_hook(
            &config,
            "/tmp/worktree-to-remove",
            serde_json::json!({ "session_id": "s1" }),
            vec![],
        )
        .await;
        assert!(ran);
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "removed");
        let _ = std::fs::remove_file(marker);
    }
}
