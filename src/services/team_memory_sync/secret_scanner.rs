//! Curated memory secret scanner.
//!
//! Maps to: CC `services/teamMemorySync/secretScanner.ts`.
//!
//! @nyan: The scanner is compiled for every build because auto-memory is a
//! local feature, not an internal-only team-memory feature. Team-memory
//! callers still apply their own path gate.

use regex::{Captures, Regex, RegexBuilder};
use std::sync::LazyLock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretMatch {
    pub rule_id: String,
    pub label: String,
}

struct SecretRule {
    id: &'static str,
    regex: Regex,
}

fn rule(id: &'static str, source: &str, case_insensitive: bool) -> SecretRule {
    SecretRule {
        id,
        // JavaScript RegExp without the `u` flag gives `\\w`/`\\b` ASCII
        // semantics. Disabling Rust regex Unicode mode is both exact and avoids
        // enormous DFAs for bounded `\\w{50,1000}` rules.
        regex: RegexBuilder::new(source)
            .unicode(id == "private-key")
            .case_insensitive(case_insensitive)
            .build()
            .unwrap_or_else(|error| panic!("official secret rule {id} must compile: {error}")),
    }
}

static SECRET_RULES: LazyLock<Vec<SecretRule>> = LazyLock::new(|| {
    let ant_key_prefix = ["sk", "ant", "api"].join("-");
    vec![
        rule(
            "aws-access-token",
            r"\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b",
            false,
        ),
        rule(
            "gcp-api-key",
            r#"\b(AIza[\w-]{35})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "azure-ad-client-secret",
            r#"(?:^|[\\'"\x60\s>=:(,)])([a-zA-Z0-9_~.]{3}\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\'"\x60\s<),])"#,
            false,
        ),
        rule(
            "digitalocean-pat",
            r#"\b(dop_v1_[a-f0-9]{64})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "digitalocean-access-token",
            r#"\b(doo_v1_[a-f0-9]{64})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "anthropic-api-key",
            &format!(r#"\b({ant_key_prefix}03-[a-zA-Z0-9_\-]{{93}}AA)(?:[\x60'"\s;]|\\[nr]|$)"#),
            false,
        ),
        rule(
            "anthropic-admin-api-key",
            r#"\b(sk-ant-admin01-[a-zA-Z0-9_\-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "openai-api-key",
            r#"\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "huggingface-access-token",
            r#"\b(hf_[a-zA-Z]{34})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule("github-pat", r"ghp_[0-9a-zA-Z]{36}", false),
        rule("github-fine-grained-pat", r"github_pat_\w{82}", false),
        rule("github-app-token", r"(?:ghu|ghs)_[0-9a-zA-Z]{36}", false),
        rule("github-oauth", r"gho_[0-9a-zA-Z]{36}", false),
        rule("github-refresh-token", r"ghr_[0-9a-zA-Z]{36}", false),
        rule("gitlab-pat", r"glpat-[\w-]{20}", false),
        rule("gitlab-deploy-token", r"gldt-[0-9a-zA-Z_\-]{20}", false),
        rule(
            "slack-bot-token",
            r"xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",
            false,
        ),
        rule(
            "slack-user-token",
            r"xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}",
            false,
        ),
        rule("slack-app-token", r"xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+", true),
        rule("twilio-api-key", r"SK[0-9a-fA-F]{32}", false),
        rule(
            "sendgrid-api-token",
            r#"\b(SG\.[a-zA-Z0-9=_\-.]{66})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "npm-access-token",
            r#"\b(npm_[a-zA-Z0-9]{36})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "pypi-upload-token",
            r"pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}",
            false,
        ),
        rule(
            "databricks-api-token",
            r#"\b(dapi[a-f0-9]{32}(?:-\d)?)(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "hashicorp-tf-api-token",
            r"[a-zA-Z0-9]{14}\.atlasv1\.[a-zA-Z0-9\-_=]{60,70}",
            false,
        ),
        rule(
            "pulumi-api-token",
            r#"\b(pul-[a-f0-9]{40})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "postman-api-token",
            r#"\b(PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "grafana-api-key",
            r#"\b(eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "grafana-cloud-api-token",
            r#"\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "grafana-service-account-token",
            r#"\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "sentry-user-token",
            r#"\b(sntryu_[a-f0-9]{64})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule(
            "sentry-org-token",
            r"\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}",
            false,
        ),
        rule(
            "stripe-access-token",
            r#"\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\x60'"\s;]|\\[nr]|$)"#,
            false,
        ),
        rule("shopify-access-token", r"shpat_[a-fA-F0-9]{32}", false),
        rule("shopify-shared-secret", r"shpss_[a-fA-F0-9]{32}", false),
        // Rust regex's `(?s:.)` is the exact any-character projection of the
        // JS source's `[\\s\\S-]` without constructing a huge Unicode DFA.
        rule(
            "private-key",
            r"-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?s:.{64,}?)-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----",
            true,
        ),
        // @nyan: These text heuristics cover credentials that do not have a
        // provider-specific prefix. They intentionally reject the whole
        // memory entry; the scanner never returns the matched value.
        rule(
            "private-key-marker",
            r"(?i)-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----",
            true,
        ),
        rule(
            "authorization-header",
            r"(?i)\bauthorization\s*:\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{4,}",
            false,
        ),
        rule(
            "bearer-token",
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}",
            false,
        ),
        rule(
            "sensitive-assignment",
            r#"(?i)\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[\"']?[A-Za-z0-9._~+/=-]{4,}"#,
            false,
        ),
    ]
});

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

/// Maps to CC `ruleIdToLabel(...)` / `getSecretLabel(...)`.
pub fn get_secret_label(rule_id: &str) -> String {
    rule_id
        .split('-')
        .map(|part| match part {
            "aws" => "AWS".to_string(),
            "gcp" => "GCP".to_string(),
            "api" => "API".to_string(),
            "pat" => "PAT".to_string(),
            "ad" => "AD".to_string(),
            "tf" => "TF".to_string(),
            "oauth" => "OAuth".to_string(),
            "npm" => "NPM".to_string(),
            "pypi" => "PyPI".to_string(),
            "jwt" => "JWT".to_string(),
            "github" => "GitHub".to_string(),
            "gitlab" => "GitLab".to_string(),
            "openai" => "OpenAI".to_string(),
            "digitalocean" => "DigitalOcean".to_string(),
            "huggingface" => "HuggingFace".to_string(),
            "hashicorp" => "HashiCorp".to_string(),
            "sendgrid" => "SendGrid".to_string(),
            other => capitalize(other),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Maps to CC `scanForSecrets(content)` — one match per rule, with no secret
/// value returned.
pub fn scan_for_secrets(content: &str) -> Vec<SecretMatch> {
    SECRET_RULES
        .iter()
        .filter(|rule| rule.regex.is_match(content))
        .map(|rule| SecretMatch {
            rule_id: rule.id.to_string(),
            label: get_secret_label(rule.id),
        })
        .collect()
}

/// Maps to CC `redactSecrets(content)`. Only capture group 1 is replaced when
/// present so boundary characters survive.
pub fn redact_secrets(content: &str) -> String {
    let mut redacted = content.to_string();
    for rule in SECRET_RULES.iter() {
        redacted = rule
            .regex
            .replace_all(&redacted, |captures: &Captures<'_>| {
                let entire = captures
                    .get(0)
                    .map(|value| value.as_str())
                    .unwrap_or_default();
                captures
                    .get(1)
                    .map(|secret| entire.replacen(secret.as_str(), "[REDACTED]", 1))
                    .unwrap_or_else(|| "[REDACTED]".to_string())
            })
            .into_owned();
    }
    redacted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_uses_official_rule_ids_labels_and_deduplication() {
        let github = format!("ghp_{}", "a".repeat(36));
        let matches = scan_for_secrets(&format!("{github}\n{github}\n"));
        assert_eq!(
            matches,
            vec![SecretMatch {
                rule_id: "github-pat".to_string(),
                label: "GitHub PAT".to_string(),
            }]
        );
    }

    #[test]
    fn redact_replaces_capture_but_preserves_boundary() {
        let token = format!("npm_{}", "a".repeat(36));
        assert_eq!(redact_secrets(&format!("'{token}';")), "'[REDACTED]';");
    }

    #[test]
    fn unknown_label_falls_back_to_title_case() {
        assert_eq!(get_secret_label("custom-secret"), "Custom Secret");
    }

    #[test]
    fn public_build_scans_text_credential_heuristics_without_returning_values() {
        let matches = scan_for_secrets(
            "authorization: Bearer abcdefgh\napi_key = \"not-a-real-provider-key\"\n",
        );
        assert_eq!(
            matches
                .iter()
                .map(|secret| secret.rule_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "authorization-header",
                "bearer-token",
                "sensitive-assignment"
            ]
        );
        assert!(
            matches
                .iter()
                .all(|secret| !secret.label.contains("abcdefgh"))
        );
    }
}
