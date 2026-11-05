//! Built-in agent registry.
//!
//! Individual built-in agent definitions live under `built_in/*`.
//! Nyan keeps four built-in agents: general-purpose, explore, plan, review.

use super::built_in::{
    explore_agent::explore_agent, general_purpose_agent::general_purpose_agent,
    plan_agent::plan_agent, review_agent::review_agent,
};
use super::load_agents_dir::AgentDefinition;

/// Maps to CC `areExplorePlanAgentsEnabled()`.
pub fn are_explore_plan_agents_enabled() -> bool {
    true
}

/// Whether review agent is enabled (always true as a core built-in agent in nyan).
pub fn is_review_agent_enabled() -> bool {
    true
}

/// Returns the built-in agents: general-purpose, explore, plan, review.
pub fn get_built_in_agents() -> Vec<AgentDefinition> {
    // Maps to official SDK/non-interactive escape hatch.
    if crate::utils::env_utils::is_env_truthy(
        crate::utils::process_env::var("CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS").as_deref(),
    ) && crate::bootstrap::state::get_is_non_interactive_session()
    {
        return Vec::new();
    }

    vec![
        general_purpose_agent(),
        explore_agent(),
        plan_agent(),
        review_agent(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bootstrap::state::IsInteractiveGuard;
    use crate::utils::test_env::{EnvVarGuard, TEST_ENV_LOCK};

    fn pin_inputs(
        entrypoint: Option<&str>,
        disable_built_in_agents: Option<&str>,
        non_interactive: bool,
    ) -> (Vec<EnvVarGuard>, IsInteractiveGuard) {
        let pin = |key, value: Option<&str>| match value {
            Some(value) => EnvVarGuard::set(key, value),
            None => EnvVarGuard::unset(key),
        };
        let env = vec![
            pin("CLAUDE_CODE_ENTRYPOINT", entrypoint),
            pin(
                "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS",
                disable_built_in_agents,
            ),
            EnvVarGuard::unset("CLAUDE_CODE_NON_INTERACTIVE"),
            EnvVarGuard::unset("NYAN_NON_INTERACTIVE"),
            EnvVarGuard::unset("NYAN_NON_INTERACTIVE_SESSION"),
        ];
        let interactive = IsInteractiveGuard::capture();
        crate::bootstrap::state::set_is_interactive(!non_interactive);
        (env, interactive)
    }

    #[test]
    fn built_in_agents_returns_four_nyan_builtins() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let agents = {
            let _inputs = pin_inputs(None, None, false);
            get_built_in_agents()
        };
        assert_eq!(
            agents
                .iter()
                .map(|agent| agent.agent_type.as_str())
                .collect::<Vec<_>>(),
            vec!["general-purpose", "Explore", "Plan", "review"]
        );
    }

    #[test]
    fn built_in_agents_honor_noninteractive_sdk_disable_gate() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let disabled = {
            let _inputs = pin_inputs(None, Some("true"), true);
            get_built_in_agents()
        };
        assert!(disabled.is_empty());

        let interactive = {
            let _inputs = pin_inputs(None, Some("true"), false);
            get_built_in_agents()
        };
        assert_eq!(interactive.len(), 4);
    }

    #[test]
    fn built_in_agent_registry_assembles_expected_agent_modules() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let agents = {
            let _inputs = pin_inputs(None, None, false);
            get_built_in_agents()
        };
        let review = agents.iter().find(|agent| agent.agent_type == "review").unwrap();
        assert_eq!(review.color.as_deref(), Some("red"));
        assert!(review.background);

        let general = agents.iter().find(|agent| agent.agent_type == "general-purpose").unwrap();
        assert_eq!(general.agent_type, "general-purpose");
    }
}
