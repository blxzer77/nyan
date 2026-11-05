//! Agent model and effort selection helpers.
//!
//! Per design §1 and §2:
//! - Subagent model resolution chain:
//!   tool_call parameter -> agent md -> selection.subagents.<type> -> selection.subagent -> inherit (parent model).
//! - Supported format: `ref[:effort]` where ref is profile name | @light | @heavy | @main | inherit | temporary provider/model.
//! - Default by agent type: general-purpose, plan = inherit; explore = @light; review = @heavy.
//! - Effort follows the layer that decides the model:
//!   - That layer has `:effort` -> use it.
//!   - Otherwise `inherit` -> parent session effort.
//!   - Otherwise profile/@tier -> that profile's configured effort (or Effort::Medium).
//!   - Otherwise temporary provider/model -> Effort::Medium.
//! - CC legacy aliases (haiku/sonnet/opus, alias_matches_parent_tier, Bedrock prefixing) are removed.

pub use crate::utils::effort::parse_model_ref_and_effort;
use crate::utils::effort::Effort;
use crate::utils::model::profile::{resolve_profile, resolve_selection_profile_name};
use crate::utils::settings::get_initial_settings;
use crate::utils::settings::nyan::NyanSettings;

/// Resolved model and effort for a subagent or utility task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAgentModel {
    pub model: String,
    pub effort: Effort,
    pub profile: Option<String>,
}

/// Default model reference used by displays that do not have an agent type.
pub fn get_default_subagent_model() -> &'static str {
    "inherit"
}

/// Default subagent spec string by agent type name.
pub fn default_subagent_spec(agent_type: &str) -> &'static str {
    match agent_type.trim().to_ascii_lowercase().as_str() {
        "explore" => "@light",
        "review" => "@heavy",
        "general-purpose" | "plan" | _ => "inherit",
    }
}

/// Default utility spec string by role name.
pub fn default_utility_spec(role: &str) -> &'static str {
    let lower = role.trim().to_ascii_lowercase();
    let norm = lower.replace('-', "_");
    match norm.as_str() {
        "compaction" | "classifier" | "permission_classifier" | "permissions" => "@main",
        _ => "@light",
    }
}

/// Helper to resolve a ref (`@light`, `@heavy`, `@main`, `inherit`, profile name, or `provider/model`)
/// into the wire model ID, effective effort, and profile name.
fn resolve_spec_to_agent_model(
    r_ref: &str,
    explicit_effort: Option<Effort>,
    parent_model: &str,
    parent_effort: Option<Effort>,
    nyan: Option<&NyanSettings>,
) -> ResolvedAgentModel {
    let default_effort = Effort::Medium;

    if r_ref == "inherit" {
        let effort = explicit_effort.or(parent_effort).unwrap_or(default_effort);
        return ResolvedAgentModel {
            model: parent_model.to_string(),
            effort,
            profile: None,
        };
    }

    let selection = nyan.and_then(|n| n.selection.as_ref());
    if selection.is_none() && r_ref.starts_with('@') {
        return ResolvedAgentModel {
            model: parent_model.to_string(),
            effort: explicit_effort.or(parent_effort).unwrap_or(default_effort),
            profile: None,
        };
    }
    let profile_name = if let Some(sel) = selection {
        resolve_selection_profile_name(sel, r_ref).unwrap_or(r_ref)
    } else {
        r_ref
    };

    if let Some(nyan_settings) = nyan {
        if let Ok(resolved) = resolve_profile(nyan_settings, profile_name) {
            let effort = explicit_effort
                .or(resolved.effort)
                .unwrap_or(default_effort);
            return ResolvedAgentModel {
                model: resolved.model,
                effort,
                profile: Some(profile_name.to_string()),
            };
        }
    }

    // Temporary provider/model (e.g. "openai/gpt-4o") or bare model name
    let effort = explicit_effort.unwrap_or(default_effort);
    ResolvedAgentModel {
        model: profile_name.to_string(),
        effort,
        profile: None,
    }
}

/// Resolves a subagent's model and effort along the priority chain:
/// 1. tool_specified_model (`RunAgentInput.model_override`)
/// 2. agent_md_model (`AgentDefinition.model`)
/// 3. `selection.subagents.<agent_type>`
/// 4. `selection.subagent`
/// 5. default for agent type (explore=@light, review=@heavy, general-purpose/plan=inherit)
pub fn resolve_subagent_model_and_effort(
    tool_specified_model: Option<&str>,
    agent_md_model: Option<&str>,
    agent_type: &str,
    parent_model: &str,
    parent_effort: Option<Effort>,
    nyan: Option<&NyanSettings>,
) -> ResolvedAgentModel {
    let selection = nyan.and_then(|n| n.selection.as_ref());

    // 1. Tool-specified model parameter
    if let Some(spec) = tool_specified_model.filter(|s| !s.trim().is_empty()) {
        let (r_ref, effort) = parse_model_ref_and_effort(spec);
        return resolve_spec_to_agent_model(r_ref, effort, parent_model, parent_effort, nyan);
    }

    // 2. Agent definition frontmatter model:
    if let Some(spec) = agent_md_model.filter(|s| !s.trim().is_empty()) {
        let (r_ref, effort) = parse_model_ref_and_effort(spec);
        return resolve_spec_to_agent_model(r_ref, effort, parent_model, parent_effort, nyan);
    }

    // 3. selection.subagents.<agent_type>
    if let Some(spec) = selection
        .and_then(|s| s.subagents.as_ref())
        .and_then(|map| map.get(agent_type))
        .filter(|s| !s.trim().is_empty())
    {
        let (r_ref, effort) = parse_model_ref_and_effort(spec);
        return resolve_spec_to_agent_model(r_ref, effort, parent_model, parent_effort, nyan);
    }

    // 4. selection.subagent
    if let Some(spec) = selection
        .and_then(|s| s.subagent.as_deref())
        .filter(|s| !s.trim().is_empty())
    {
        let (r_ref, effort) = parse_model_ref_and_effort(spec);
        return resolve_spec_to_agent_model(r_ref, effort, parent_model, parent_effort, nyan);
    }

    // 5. Default by agent type
    let spec = default_subagent_spec(agent_type);
    let (r_ref, effort) = parse_model_ref_and_effort(spec);
    resolve_spec_to_agent_model(r_ref, effort, parent_model, parent_effort, nyan)
}

/// Resolves a utility role's model and effort along the priority chain:
/// 1. `selection.utility.<role>`
/// 2. default for utility role (compaction/classifier=@main, all others=@light)
pub fn resolve_utility_model_and_effort(
    role: &str,
    parent_model: &str,
    parent_effort: Option<Effort>,
    nyan: Option<&NyanSettings>,
) -> ResolvedAgentModel {
    let selection = nyan.and_then(|n| n.selection.as_ref());

    // Try finding the role in selection.utility with loose name matching
    let configured_spec = selection.and_then(|s| s.utility.as_ref()).and_then(|map| {
        let normalized = role.trim().to_ascii_lowercase().replace('-', "_");
        map.iter().find_map(|(k, v)| {
            let k_norm = k.trim().to_ascii_lowercase().replace('-', "_");
            if k_norm == normalized {
                Some(v.as_str())
            } else {
                None
            }
        })
    });

    let spec = configured_spec.unwrap_or_else(|| default_utility_spec(role));
    let (r_ref, effort) = parse_model_ref_and_effort(spec);
    resolve_spec_to_agent_model(r_ref, effort, parent_model, parent_effort, nyan)
}

/// Backward-compatible wrapper for agent model resolution.
pub fn get_agent_model(
    agent_model: Option<&str>,
    parent_model: &str,
    tool_specified_model: Option<&str>,
    agent_type: Option<&str>,
) -> String {
    let settings = get_initial_settings();
    let nyan = settings.nyan.as_deref();
    resolve_subagent_model_and_effort(
        tool_specified_model,
        agent_model,
        agent_type.unwrap_or("general-purpose"),
        parent_model,
        None,
        nyan,
    )
    .model
}

pub fn get_agent_model_display(model: Option<&str>) -> String {
    match model {
        None | Some("inherit") => "Inherit from parent (default)".to_string(),
        Some(value) => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use crate::utils::settings::nyan::{
        ModelCapabilities, ModelProfileSettings, ProviderKind, ProviderProtocol, ProviderSettings,
        SelectionSettings,
    };

    fn test_nyan_settings() -> NyanSettings {
        let mut providers = BTreeMap::new();
        providers.insert(
            "anthropic".to_string(),
            ProviderSettings {
                kind: Some(ProviderKind::Anthropic),
                protocol: Some(ProviderProtocol::AnthropicMessages),
                ..Default::default()
            },
        );
        let mut models = BTreeMap::new();
        models.insert(
            "main-profile".to_string(),
            ModelProfileSettings {
                provider: Some("anthropic".to_string()),
                model: Some("claude-sonnet-4-6".to_string()),
                protocol: Some(ProviderProtocol::AnthropicMessages),
                capabilities: Some(ModelCapabilities {
                    context_window: Some(200_000),
                    max_output_tokens: Some(8192),
                    thinking: Some("adaptive".to_string()),
                    ..Default::default()
                }),
                effort: Some(Effort::High),
                ..Default::default()
            },
        );
        models.insert(
            "fast-profile".to_string(),
            ModelProfileSettings {
                provider: Some("anthropic".to_string()),
                model: Some("claude-haiku-4-5".to_string()),
                protocol: Some(ProviderProtocol::AnthropicMessages),
                capabilities: Some(ModelCapabilities {
                    context_window: Some(200_000),
                    max_output_tokens: Some(4096),
                    thinking: Some("adaptive".to_string()),
                    ..Default::default()
                }),
                effort: Some(Effort::Off),
                ..Default::default()
            },
        );
        models.insert(
            "deep-profile".to_string(),
            ModelProfileSettings {
                provider: Some("anthropic".to_string()),
                model: Some("claude-opus-4-6".to_string()),
                protocol: Some(ProviderProtocol::AnthropicMessages),
                capabilities: Some(ModelCapabilities {
                    context_window: Some(200_000),
                    max_output_tokens: Some(16384),
                    thinking: Some("adaptive".to_string()),
                    ..Default::default()
                }),
                effort: Some(Effort::Max),
                ..Default::default()
            },
        );

        let selection = SelectionSettings {
            main: Some("main-profile".to_string()),
            light: Some("fast-profile".to_string()),
            heavy: Some("deep-profile".to_string()),
            subagents: Some(BTreeMap::from([
                ("review".to_string(), "deep-profile:high".to_string()),
            ])),
            utility: Some(BTreeMap::from([
                ("title".to_string(), "fast-profile:off".to_string()),
            ])),
            ..Default::default()
        };

        NyanSettings {
            providers: Some(providers),
            models: Some(models),
            selection: Some(selection),
            ..Default::default()
        }
    }

    #[test]
    fn subagent_defaults_by_type() {
        assert_eq!(default_subagent_spec("general-purpose"), "inherit");
        assert_eq!(default_subagent_spec("plan"), "inherit");
        assert_eq!(default_subagent_spec("explore"), "@light");
        assert_eq!(default_subagent_spec("review"), "@heavy");
        assert_eq!(default_subagent_spec("other"), "inherit");
    }

    #[test]
    fn utility_defaults_by_role() {
        assert_eq!(default_utility_spec("compaction"), "@main");
        assert_eq!(default_utility_spec("classifier"), "@main");
        assert_eq!(default_utility_spec("permission_classifier"), "@main");
        assert_eq!(default_utility_spec("title"), "@light");
        assert_eq!(default_utility_spec("summary"), "@light");
        assert_eq!(default_utility_spec("commit_message"), "@light");
        assert_eq!(default_utility_spec("webfetch"), "@light");
        assert_eq!(default_utility_spec("bash_prefix"), "@light");
        assert_eq!(default_utility_spec("prompt_suggestions"), "@light");
        assert_eq!(default_utility_spec("memory"), "@light");
        assert_eq!(default_utility_spec("side_query"), "@light");
    }

    #[test]
    fn resolve_subagent_priority_chain() {
        let nyan = test_nyan_settings();
        let parent_model = "claude-sonnet-4-6";
        let parent_effort = Some(Effort::Medium);

        // 1. Tool call parameter wins
        let r1 = resolve_subagent_model_and_effort(
            Some("fast-profile:max"),
            Some("deep-profile"),
            "explore",
            parent_model,
            parent_effort,
            Some(&nyan),
        );
        assert_eq!(r1.model, "claude-haiku-4-5");
        assert_eq!(r1.effort, Effort::Max);

        // 2. Agent md wins over settings
        let r2 = resolve_subagent_model_and_effort(
            None,
            Some("@heavy:medium"),
            "explore",
            parent_model,
            parent_effort,
            Some(&nyan),
        );
        assert_eq!(r2.model, "claude-opus-4-6");
        assert_eq!(r2.effort, Effort::Medium);

        // 3. selection.subagents.<type> wins over selection.subagent / default
        // "review" is configured as "deep-profile:high" in test_nyan_settings
        let r3 = resolve_subagent_model_and_effort(
            None,
            None,
            "review",
            parent_model,
            parent_effort,
            Some(&nyan),
        );
        assert_eq!(r3.model, "claude-opus-4-6");
        assert_eq!(r3.effort, Effort::High);

        // 4. Default for explore is @light, which resolves to fast-profile (with its configured effort Effort::Off)
        let r4 = resolve_subagent_model_and_effort(
            None,
            None,
            "explore",
            parent_model,
            parent_effort,
            Some(&nyan),
        );
        assert_eq!(r4.model, "claude-haiku-4-5");
        assert_eq!(r4.effort, Effort::Off); // fast-profile effort is Off

        // 5. Default for general-purpose is inherit -> inherits parent model and effort
        let r5 = resolve_subagent_model_and_effort(
            None,
            None,
            "general-purpose",
            parent_model,
            parent_effort,
            Some(&nyan),
        );
        assert_eq!(r5.model, parent_model);
        assert_eq!(r5.effort, Effort::Medium);

        // 6. Inherit with explicit :max
        let r6 = resolve_subagent_model_and_effort(
            Some(":max"),
            None,
            "general-purpose",
            parent_model,
            parent_effort,
            Some(&nyan),
        );
        assert_eq!(r6.model, parent_model);
        assert_eq!(r6.effort, Effort::Max);

        // 7. Temporary provider/model
        let r7 = resolve_subagent_model_and_effort(
            Some("openai/gpt-4o:high"),
            None,
            "explore",
            parent_model,
            parent_effort,
            Some(&nyan),
        );
        assert_eq!(r7.model, "openai/gpt-4o");
        assert_eq!(r7.effort, Effort::High);
    }

    #[test]
    fn resolve_utility_chain() {
        let nyan = test_nyan_settings();
        let parent_model = "claude-sonnet-4-6";
        let parent_effort = Some(Effort::Medium);

        // Configured in test_nyan_settings: title -> fast-profile:off
        let title = resolve_utility_model_and_effort("title", parent_model, parent_effort, Some(&nyan));
        assert_eq!(title.model, "claude-haiku-4-5");
        assert_eq!(title.effort, Effort::Off);

        // Unconfigured compaction -> default @main -> main-profile (with its configured effort Effort::High)
        let compaction = resolve_utility_model_and_effort("compaction", parent_model, parent_effort, Some(&nyan));
        assert_eq!(compaction.model, "claude-sonnet-4-6");
        assert_eq!(compaction.effort, Effort::High);

        // Unconfigured summary -> default @light -> fast-profile (with its configured effort Effort::Off)
        let summary = resolve_utility_model_and_effort("summary", parent_model, parent_effort, Some(&nyan));
        assert_eq!(summary.model, "claude-haiku-4-5");
        assert_eq!(summary.effort, Effort::Off);
    }
}
