//! Maps to CC `tools/AgentTool/constants.ts`.

pub const AGENT_TOOL_NAME: &str = "Agent";
pub const LEGACY_AGENT_TOOL_NAME: &str = "Task";
pub const REVIEW_AGENT_TYPE: &str = "review";

pub const DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH: usize = 3;
pub const DEFAULT_MAX_CONCURRENT_SUBAGENTS: usize = 20;

/// Returns the maximum subagent nesting depth (default 3, env NYAN_MAX_SUBAGENT_SPAWN_DEPTH).
pub fn max_subagent_spawn_depth() -> usize {
    crate::utils::process_env::var("NYAN_MAX_SUBAGENT_SPAWN_DEPTH")
        .and_then(|val| val.parse().ok())
        .unwrap_or(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH)
}

/// Returns the maximum concurrent running subagents limit (default 20, env NYAN_MAX_CONCURRENT_SUBAGENTS).
pub fn max_concurrent_subagents() -> usize {
    crate::utils::process_env::var("NYAN_MAX_CONCURRENT_SUBAGENTS")
        .and_then(|val| val.parse().ok())
        .unwrap_or(DEFAULT_MAX_CONCURRENT_SUBAGENTS)
}

/// Maps to CC `tools/AgentTool/constants.ts#ONE_SHOT_BUILTIN_AGENT_TYPES`.
pub const ONE_SHOT_BUILTIN_AGENT_TYPES: &[&str] = &["Explore", "Plan"];

/// Maps to CC `ONE_SHOT_BUILTIN_AGENT_TYPES.has(agentType)`.
pub fn is_one_shot_builtin_agent_type(agent_type: &str) -> bool {
    ONE_SHOT_BUILTIN_AGENT_TYPES.contains(&agent_type)
}
