//! Maps to: CC `utils/toolPool.ts`.
//!
//! The React-free half of tool-pool assembly. CC keeps `mergeAndFilterTools`
//! here (not in `hooks/useMergedTools.ts`) so `cli/print.ts` can import it
//! without pulling react/ink into the SDK module graph (`toolPool.ts:47-50`);
//! the port mirrors that split so both the REPL and the headless
//! `QueryEngine` path share one sort/dedupe/coordinator-filter routine.

use crate::constants::tools::COORDINATOR_MODE_ALLOWED_TOOLS;
use crate::types::permissions::PermissionMode;
use crate::types::tools::Tool;

/// Maps to: CC `utils/toolPool.ts:11-14` `PR_ACTIVITY_TOOL_SUFFIXES`.
///
/// "MCP tool name suffixes for PR activity subscription. These are lightweight
/// orchestration actions the coordinator calls directly rather than delegating
/// to workers. Matched by suffix since the MCP server name prefix may vary."
const PR_ACTIVITY_TOOL_SUFFIXES: &[&str] = &["subscribe_pr_activity", "unsubscribe_pr_activity"];

/// Maps to: CC `utils/toolPool.ts:16-18` `isPrActivitySubscriptionTool`.
pub fn is_pr_activity_subscription_tool(name: &str) -> bool {
    PR_ACTIVITY_TOOL_SUFFIXES
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

/// Maps to: CC `utils/toolPool.ts:35-41` `applyCoordinatorToolFilter`.
///
/// "Filters a tool array to the set allowed in coordinator mode. Shared
/// between the REPL path (mergeAndFilterTools) and the headless path
/// (main.tsx) so both stay in sync. PR activity subscription tools are always
/// allowed since subscription management is orchestration."
pub fn apply_coordinator_tool_filter(tools: Vec<Tool>) -> Vec<Tool> {
    tools
        .into_iter()
        .filter(|tool| {
            COORDINATOR_MODE_ALLOWED_TOOLS.contains(tool.name.as_str())
                || is_pr_activity_subscription_tool(&tool.name)
        })
        .collect()
}

/// Maps to: CC `utils/toolPool.ts:55-78` `mergeAndFilterTools`.
///
/// "Pure function that merges tool pools and applies coordinator mode
/// filtering."
///
/// * `initial_tools` — CC `initialTools`: extra tools to include (built-in +
///   startup MCP from props / the headless `tools` argument). They "take
///   precedence in deduplication" (`:64-66`) — `uniqBy` keeps the first
///   occurrence, and `initialTools` come first in the concatenation.
/// * `assembled` — CC `assembled`: the `assembleToolPool` output (built-in +
///   deny-filtered MCP, deduped).
/// * `mode` — CC `mode: ToolPermissionContext['mode']`. Declared in the
///   signature and never read in the body (`:59-78`); kept for parity so call
///   sites line up with `print.ts:1480-1484` and `useMergedTools.ts`.
///
/// The sort is a partition-sort, NOT a flat sort (`:67-70`): built-ins must
/// stay a contiguous prefix for the Anthropic server-side policy named
/// `claude_code_system_cache_policy` (`tools.ts:354-359`). That lets a generic
/// prefix cache place one global breakpoint after the prefix and reuse all
/// downstream built-in keys; an MCP tool sorting between two built-ins would
/// invalidate those keys. Both halves use CC's `byName` (`:69`, `localeCompare`)
/// via [`crate::tools::compare_tool_names`].
pub fn merge_and_filter_tools(
    initial_tools: &[Tool],
    assembled: Vec<Tool>,
    _mode: PermissionMode,
) -> Vec<Tool> {
    // Maps to `:65-66` `uniqBy([...initialTools, ...assembled], 'name')`.
    let mut seen = std::collections::HashSet::new();
    let merged = initial_tools
        .iter()
        .cloned()
        .chain(assembled)
        .filter(|tool| seen.insert(tool.name.clone()))
        .collect::<Vec<_>>();
    // Maps to `:64-70` `partition(..., isMcpTool)` + `[...builtIn.sort(byName),
    // ...mcp.sort(byName)]`.
    let (mcp, mut built_in): (Vec<Tool>, Vec<Tool>) = merged
        .into_iter()
        .partition(crate::services::mcp::utils::is_mcp_tool);
    let mut mcp = mcp;
    built_in.sort_by(|left, right| crate::tools::compare_tool_names(&left.name, &right.name));
    mcp.sort_by(|left, right| crate::tools::compare_tool_names(&left.name, &right.name));
    let tools = built_in.into_iter().chain(mcp).collect::<Vec<_>>();

    // Maps to `:72-76`: `feature('COORDINATOR_MODE') && isCoordinatorMode()` —
    // `is_coordinator_mode` already folds the build-audience gate in.
    if crate::coordinator::coordinator_mode::is_coordinator_mode() {
        return apply_coordinator_tool_filter(tools);
    }

    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn built_in(name: &str) -> Tool {
        Tool {
            name: name.to_string(),
            description: format!("{name} description"),
            ..Default::default()
        }
    }

    fn mcp(name: &str) -> Tool {
        Tool {
            is_mcp: true,
            ..built_in(name)
        }
    }

    fn names(tools: &[Tool]) -> Vec<&str> {
        tools.iter().map(|tool| tool.name.as_str()).collect()
    }

    #[test]
    fn pr_activity_suffix_match_ignores_server_prefix() {
        assert!(is_pr_activity_subscription_tool(
            "mcp__github__subscribe_pr_activity"
        ));
        assert!(is_pr_activity_subscription_tool(
            "mcp__other__unsubscribe_pr_activity"
        ));
        assert!(!is_pr_activity_subscription_tool(
            "mcp__github__pr_activity"
        ));
        assert!(!is_pr_activity_subscription_tool("Bash"));
    }

    #[test]
    fn coordinator_filter_keeps_allowlist_and_pr_activity_tools() {
        let filtered = apply_coordinator_tool_filter(vec![
            built_in("Bash"),
            built_in(crate::tools::agent_tool::constants::AGENT_TOOL_NAME),
            built_in(crate::tools::task_stop_tool::prompt::TASK_STOP_TOOL_NAME),
            mcp("mcp__github__subscribe_pr_activity"),
            mcp("mcp__github__list_prs"),
        ]);
        assert_eq!(
            names(&filtered),
            vec![
                crate::tools::agent_tool::constants::AGENT_TOOL_NAME,
                crate::tools::task_stop_tool::prompt::TASK_STOP_TOOL_NAME,
                "mcp__github__subscribe_pr_activity",
            ]
        );
    }

    #[test]
    fn merge_keeps_built_ins_as_sorted_contiguous_prefix() {
        // CC `toolPool.ts:64-70`: partition by isMcpTool, sort each half, built-ins first.
        let initial = vec![built_in("Read"), mcp("mcp__zeta__tool"), built_in("Bash")];
        let assembled = vec![
            built_in("Agent"),
            built_in("Bash"),
            mcp("mcp__alpha__tool"),
            built_in("Glob"),
        ];
        let merged = merge_and_filter_tools(&initial, assembled, PermissionMode::Default);
        assert_eq!(
            names(&merged),
            vec![
                "Agent",
                "Bash",
                "Glob",
                "Read",
                "mcp__alpha__tool",
                "mcp__zeta__tool",
            ]
        );
    }

    #[test]
    fn merge_dedupes_by_name_with_initial_tools_winning() {
        // CC `toolPool.ts:64-66`: `uniqBy([...initialTools, ...assembled], 'name')`.
        let mut initial_bash = built_in("Bash");
        initial_bash.description = "from initialTools".to_string();
        let mut assembled_bash = built_in("Bash");
        assembled_bash.description = "from assembleToolPool".to_string();
        let merged = merge_and_filter_tools(
            &[initial_bash],
            vec![assembled_bash],
            PermissionMode::Default,
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].description, "from initialTools");
    }
}
