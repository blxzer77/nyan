//! Decision-provider egress: credential redaction and state digests.
//!
//! @nyan: decision-provider.md §6 — the decision backend may see source code,
//! page bodies, conversations and tool output (effect before source privacy,
//! user 2026-10-27). One class is still blocked: **credentials**. A matched
//! span is replaced by `<redacted>` and the request continues; the decision
//! is still useful and the secret never leaves the machine.
//!
//! The scanner here is the decision path's compact rule set. Memory M3
//! (`memdir/write_guard.rs`) is un-gating the team-memory scanner in its own
//! slice; when that lands, this module should call it and keep only the
//! decision-specific names list. Until then the rules below must not be
//! weakened — they are the only line between a transcript and EMRank.
//!
//! Logs never receive state content: [`state_digest`] returns a SHA-256 and a
//! byte length, which is all a receipt is allowed to carry (decision-provider
//! §7).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const REDACTED: &str = "<redacted>";

struct Rules {
    private_key: Regex,
    token_prefixed: Regex,
    github_token: Regex,
    aws_access_key: Regex,
    jwt: Regex,
    bearer: Regex,
    assignment: Regex,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| Rules {
        // A PEM block, header to footer. Multiline because the body lives on
        // its own lines; `(?s)` is not needed since the body has no dots.
        private_key: Regex::new(
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        )
        .expect("private-key rule"),
        // sk-… (OpenAI/Anthropic style), rk-…, pk-…, plus the generic
        // `sk_live_` form. Long enough not to eat ordinary hyphenated words.
        token_prefixed: Regex::new(r"\b(?:sk|rk|pk)[-_](?:live_|test_|proj_)?[A-Za-z0-9_-]{16,}\b")
            .expect("prefixed-token rule"),
        github_token: Regex::new(
            r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b",
        )
        .expect("github-token rule"),
        aws_access_key: Regex::new(r"\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b")
            .expect("aws-key rule"),
        jwt: Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
            .expect("jwt rule"),
        bearer: Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*")
            .expect("bearer rule"),
        // `KEY=value`, `key: value`, `"api_key": "value"` where the key name
        // names a credential. The value run stops at whitespace, quotes, and
        // the usual punctuation so surrounding prose survives.
        assignment: Regex::new(
            r#"(?i)\b[A-Z0-9_.-]*(?:api[_-]?key|access[_-]?(?:key|token)|auth(?:orization)?[_-]?token|token|secret|pass(?:word|wd)?|credentials?|client[_-]?secret|private[_-]?key)[A-Z0-9_.-]*\b["']?\s*[=:]\s*["']?[^\s"',;]{8,}["']?"#,
        )
        .expect("assignment rule"),
    })
}

/// Replace every credential-shaped span in `text` with [`REDACTED`].
pub fn redact_text(text: &str) -> String {
    let rules = rules();
    let mut out = text.to_string();
    for rule in [
        &rules.private_key,
        &rules.token_prefixed,
        &rules.github_token,
        &rules.aws_access_key,
        &rules.jwt,
        &rules.bearer,
        &rules.assignment,
    ] {
        out = rule.replace_all(&out, REDACTED).into_owned();
    }
    out
}

/// Redact every string inside a JSON value, in place. Objects and arrays are
/// walked; an object entry whose *key* names a credential has its string value
/// replaced wholesale, because the key/value relationship is lost once the
/// value is visited on its own.
pub fn redact_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            let redacted = redact_text(text);
            if redacted != *text {
                *text = redacted;
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_value(item);
            }
        }
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if is_credential_key(key) && item.is_string() {
                    *item = Value::String(REDACTED.to_string());
                    continue;
                }
                redact_value(item);
            }
        }
        _ => {}
    }
}

/// Key names that mark their value as a credential
/// (decision-provider §6: "key 含 token / secret / password / api key 等").
pub fn is_credential_key(key: &str) -> bool {
    static KEY: OnceLock<Regex> = OnceLock::new();
    KEY.get_or_init(|| {
        Regex::new(
            r"(?i)(api[_-]?key|access[_-]?(key|token)|auth(?:orization)?[_-]?token|token|secret|pass(?:word|wd)|credentials?|client[_-]?secret|private[_-]?key)",
        )
        .expect("credential-key rule")
    })
    .is_match(key)
}

/// Redact the state and every question instruction/option of a request.
///
/// Directions to the model are not credentials, but callers sometimes splice
/// content into them (candidate bodies, retrieved snippets), so they take the
/// same pass.
pub fn redact_request_parts(
    state: &mut Value,
    questions: &mut std::collections::BTreeMap<String, super::Question>,
) {
    redact_value(state);
    use super::Question;
    for question in questions.values_mut() {
        match question {
            Question::Noul { instructions } => *instructions = redact_text(instructions),
            Question::Choice {
                instructions,
                options,
            } => {
                *instructions = redact_text(instructions);
                for option in options.values_mut() {
                    *option = redact_text(option);
                }
            }
            Question::Score {
                instructions,
                levels,
            } => {
                *instructions = redact_text(instructions);
                for level in levels.iter_mut() {
                    *level = redact_text(level);
                }
            }
        }
    }
}

/// SHA-256 (lowercase hex) of the canonical serialized state plus its byte
/// length. This is everything a receipt may record about the state.
pub fn state_digest(state: &Value) -> (String, usize) {
    let bytes = serde_json::to_vec(state).unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    (hex, bytes.len())
}

/// Whether a path is credential-bearing and must never enter `state`
/// (decision-provider §6, retrieval 4.5). Callers that read files should
/// check this before attaching content.
pub fn is_credential_path(path: &str) -> bool {
    let file_name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    file_name == ".env"
        || file_name.starts_with(".env.")
        || file_name.ends_with(".pem")
        || file_name.ends_with(".key")
        || file_name.starts_with("id_rsa")
        || file_name.starts_with("id_ed25519")
        || file_name.starts_with("id_ecdsa")
        || file_name.starts_with("credentials")
        || file_name == ".netrc"
        || file_name == ".npmrc"
        || file_name == ".pypirc"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prefixed_tokens_aws_keys_and_jwts_are_redacted() {
        for secret in [
            "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
            "AKIAIOSFODNN7EXAMPLE",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", // gitleaks:allow -- RFC 7519 sample token
        ] {
            let text = format!("before {secret} after");
            let redacted = redact_text(&text);
            assert!(
                !redacted.contains(secret),
                "secret survived redaction: {redacted}"
            );
            assert!(redacted.contains(REDACTED), "{redacted}");
            assert!(redacted.starts_with("before "), "context preserved");
            assert!(redacted.ends_with(" after"), "context preserved");
        }
    }

    #[test]
    fn private_key_blocks_are_redacted_as_a_whole() {
        let text = "key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAbbbbCCCC\nddddEEEE\n-----END OPENSSH PRIVATE KEY-----\ndone";
        let redacted = redact_text(text);
        assert!(!redacted.contains("AAAAbbbbCCCC"));
        assert!(!redacted.contains("BEGIN OPENSSH"));
        assert_eq!(redacted, format!("key:\n{REDACTED}\ndone"));
    }

    #[test]
    fn bearer_headers_and_assignments_are_redacted() {
        let text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\nexport GITHUB_TOKEN=supersecretvalue123\n{\"api_key\": \"abcdef1234567890\"}";
        let redacted = redact_text(text);
        assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(!redacted.contains("supersecretvalue123"));
        assert!(!redacted.contains("abcdef1234567890"));
        assert!(redacted.contains(REDACTED));
    }

    #[test]
    fn ordinary_prose_and_codes_are_left_alone() {
        for text in [
            "The token bucket refills every second.",
            "fn get_token(&self) -> Option<String> { self.token.clone() }",
            "sk-learn is a Python library",
            "password reset flow is broken",
            "const API_KEY_ENV: &str = \"ANTHROPIC_API_KEY\";",
        ] {
            assert_eq!(redact_text(text), text, "changed: {text}");
        }
    }

    #[test]
    fn values_are_redacted_recursively_but_keys_are_kept() {
        let mut value = json!({
            "messages": [
                {"text": "use sk-proj-abcdefghijklmnopqrstuvwxyz012345 here"},
                {"token": "plain"},
            ],
            "api_key": "abcdef1234567890", // gitleaks:allow -- synthetic redaction fixture
        });
        redact_value(&mut value);
        assert!(
            !value
                .to_string()
                .contains("abcdefghijklmnopqrstuvwxyz012345")
        );
        assert!(!value.to_string().contains("abcdef1234567890"));
        assert_eq!(value["api_key"], REDACTED);
    }

    #[test]
    fn question_instructions_are_redacted_too() {
        use crate::services::decision::Question;
        let mut questions = std::collections::BTreeMap::new();
        questions.insert(
            "q".to_string(),
            Question::Choice {
                instructions: "Is sk-proj-abcdefghijklmnopqrstuvwxyz012345 sensitive?".into(),
                options: [("a".to_string(), "AKIAIOSFODNN7EXAMPLE".to_string())]
                    .into_iter()
                    .collect(),
            },
        );
        let mut state = json!({"text": "hello"});
        redact_request_parts(&mut state, &mut questions);
        let Question::Choice {
            instructions,
            options,
        } = &questions["q"]
        else {
            panic!("choice");
        };
        assert!(!instructions.contains("sk-proj-"));
        assert!(!options["a"].contains("AKIA"));
    }

    #[test]
    fn the_digest_is_stable_hex_and_records_only_hash_and_length() {
        let state = json!({"query": "find the auth middleware", "n": 3});
        let (hash, bytes) = state_digest(&state);
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!((hash.clone(), bytes), state_digest(&state));
        // Same content, different key order -> serde_json's preserve_order
        // feature means the digest follows insertion order; callers must build
        // state deterministically. Documented here so the expectation is
        // explicit rather than a surprise.
        let reordered = json!({"n": 3, "query": "find the auth middleware"});
        let (other, other_bytes) = state_digest(&reordered);
        assert_eq!(bytes, other_bytes);
        assert_ne!(hash, other);
    }

    #[test]
    fn credential_paths_are_recognized() {
        for path in [
            "/repo/.env",
            "/repo/.env.local",
            "/home/u/.ssh/id_rsa",
            "/home/u/.ssh/id_ed25519.pub",
            "/repo/certs/server.pem",
            "/home/u/.aws/credentials",
            "/home/u/.netrc",
            "/repo/.npmrc",
            // The design names `credentials*` as a whole family.
            "/repo/credentials.json",
        ] {
            assert!(is_credential_path(path), "{path}");
        }
        for path in [
            "/repo/src/main.rs",
            "/repo/environment.md",
            "/home/u/.ssh/config",
            "/repo/certs/README.md",
        ] {
            assert!(!is_credential_path(path), "{path}");
        }
    }
}
