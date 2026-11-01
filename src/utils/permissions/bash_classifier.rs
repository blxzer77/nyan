//! Maps to: CC `utils/permissions/bashClassifier.ts`.
//!
//! In the external Claude Code build this module is an explicit disabled stub
//! (`classifier permissions feature is ANT-ONLY`). Nyan follows that safe
//! behavior for now: prompt-rule helpers preserve the public string shape, but
//! no classifier API call is made and classifier permission gates report
//! disabled. A future ant/internal classifier port should replace only the
//! disabled call path, not BashTool permission logic.

pub const PROMPT_PREFIX: &str = "prompt:";

/// Maps to: CC `ClassifierResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassifierResult {
    pub matches: bool,
    pub matched_description: Option<String>,
    pub confidence: ClassifierConfidence,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClassifierConfidence {
    High,
    Medium,
    Low,
}

/// Maps to: CC `ClassifierBehavior`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClassifierBehavior {
    Deny,
    Ask,
    Allow,
}

/// Maps to: CC `extractPromptDescription(...)` in the external stub.
pub fn extract_prompt_description(_rule_content: Option<&str>) -> Option<String> {
    None
}

/// Maps to: CC `createPromptRuleContent(description)`.
pub fn create_prompt_rule_content(description: &str) -> String {
    format!("{PROMPT_PREFIX} {}", description.trim())
}

/// Maps to: CC `isClassifierPermissionsEnabled()` in the external stub.
pub fn is_classifier_permissions_enabled() -> bool {
    false
}

/// Maps to: CC `getBashPromptDenyDescriptions(context)` in the external stub.
pub fn get_bash_prompt_deny_descriptions<T>(_context: T) -> Vec<String> {
    Vec::new()
}

/// Maps to: CC `getBashPromptAskDescriptions(context)` in the external stub.
pub fn get_bash_prompt_ask_descriptions<T>(_context: T) -> Vec<String> {
    Vec::new()
}

/// Maps to: CC `getBashPromptAllowDescriptions(context)` in the external stub.
pub fn get_bash_prompt_allow_descriptions<T>(_context: T) -> Vec<String> {
    Vec::new()
}

/// Maps to: CC `classifyBashCommand(...)` in the external stub.
pub async fn classify_bash_command(
    _command: &str,
    _cwd: &str,
    _descriptions: &[String],
    _behavior: ClassifierBehavior,
    _is_non_interactive_session: bool,
) -> ClassifierResult {
    ClassifierResult {
        matches: false,
        matched_description: None,
        confidence: ClassifierConfidence::High,
        reason: "This feature is disabled".to_string(),
    }
}

/// Maps to: CC `generateGenericDescription(...)` in the external stub.
pub async fn generate_generic_description(
    _command: &str,
    specific_description: Option<&str>,
) -> Option<String> {
    specific_description.map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bash_classifier_stub_preserves_prompt_rule_shape_and_disabled_gate() {
        assert_eq!(
            create_prompt_rule_content("  run tests  "),
            "prompt: run tests"
        );
        assert_eq!(extract_prompt_description(Some("prompt: run tests")), None);
        assert!(!is_classifier_permissions_enabled());
        assert!(get_bash_prompt_deny_descriptions(()).is_empty());
        assert!(get_bash_prompt_ask_descriptions(()).is_empty());
        assert!(get_bash_prompt_allow_descriptions(()).is_empty());
    }

    #[tokio::test]
    async fn classify_bash_command_matches_external_disabled_stub() {
        let result = classify_bash_command(
            "rm -rf target",
            ".",
            &["dangerous command".to_string()],
            ClassifierBehavior::Deny,
            false,
        )
        .await;
        assert!(!result.matches);
        assert_eq!(result.confidence, ClassifierConfidence::High);
        assert_eq!(result.reason, "This feature is disabled");

        assert_eq!(
            generate_generic_description("cargo test", Some("run tests")).await,
            Some("run tests".to_string())
        );
        assert_eq!(generate_generic_description("cargo test", None).await, None);
    }
}
