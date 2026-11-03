//! Minimal API-key access for the Anthropic adapter.
//!
//! @nyan: PR 3 introduces the credential owner (`provider_auth`). Until it
//! lands, the adapter needs only one thing from it: an API key for a provider
//! profile. This file is that seam; swapping in the owner replaces
//! [`resolve_api_key`] and nothing else.
//!
//! Anthropic accepts API keys only (decision 16). OAuth references are
//! rejected here, and `file` references are rejected until the owner can
//! verify owner-only permissions (decision 12/17) instead of reading an
//! unchecked path.

use std::fmt;

use crate::utils::settings::nyan::CredentialReference;

/// An API key. `Debug` and `Display` never print the value.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(<redacted>)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialGateError {
    /// The provider has no `credential` block.
    NotConfigured { provider: String },
    /// The provider names more than one credential source.
    Ambiguous { provider: String },
    /// `credential.env` names a variable that is unset or empty.
    EnvUnset { provider: String, variable: String },
    /// The source is valid configuration but not usable for Anthropic.
    Unsupported {
        provider: String,
        source: &'static str,
        reason: &'static str,
    },
}

impl fmt::Display for CredentialGateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured { provider } => write!(
                f,
                "Provider {provider:?} has no credential. Set settings.nyan.providers.{provider}.credential to {{\"env\": \"ANTHROPIC_API_KEY\"}} or another environment variable holding the API key."
            ),
            Self::Ambiguous { provider } => write!(
                f,
                "Provider {provider:?} names more than one credential source; keep exactly one of env, optionalEnv, none."
            ),
            Self::EnvUnset { provider, variable } => write!(
                f,
                "Provider {provider:?} reads its API key from {variable}, which is unset or empty."
            ),
            Self::Unsupported {
                provider,
                source,
                reason,
            } => write!(
                f,
                "Provider {provider:?} uses credential source {source:?}, which Anthropic does not support: {reason}"
            ),
        }
    }
}

impl std::error::Error for CredentialGateError {}

/// Where the adapter reads environment variables from. A trait so tests do not
/// touch the process environment.
pub trait EnvSource {
    fn var(&self, name: &str) -> Option<String>;
}

/// The process environment carrier.
pub struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn var(&self, name: &str) -> Option<String> {
        crate::utils::process_env::var(name)
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Resolve the API key a provider profile points at.
///
/// `Ok(None)` means the profile explicitly asks for no key (`none` or an
/// unset `optionalEnv`), which suits an Anthropic-compatible gateway that
/// authenticates some other way.
pub fn resolve_api_key(
    provider: &str,
    credential: Option<&CredentialReference>,
    env: &dyn EnvSource,
) -> Result<Option<ApiKey>, CredentialGateError> {
    let not_configured = || CredentialGateError::NotConfigured {
        provider: provider.to_string(),
    };
    let credential = credential.ok_or_else(not_configured)?;

    let named = [
        credential.env.is_some(),
        credential.optional_env.is_some(),
        credential.file.is_some(),
        credential.oauth.is_some(),
        credential.none == Some(true),
    ];
    match named.iter().filter(|set| **set).count() {
        0 => return Err(not_configured()),
        1 => {}
        _ => {
            return Err(CredentialGateError::Ambiguous {
                provider: provider.to_string(),
            });
        }
    }

    if credential.oauth.is_some() {
        return Err(CredentialGateError::Unsupported {
            provider: provider.to_string(),
            source: "oauth",
            reason: "Anthropic accepts API keys only",
        });
    }
    if credential.file.is_some() {
        return Err(CredentialGateError::Unsupported {
            provider: provider.to_string(),
            source: "file",
            reason: "key files need the owner-only permission check from the credential owner; use an environment variable for now",
        });
    }
    if let Some(variable) = credential.env.as_deref() {
        return non_empty(env.var(variable))
            .map(|key| Some(ApiKey(key)))
            .ok_or_else(|| CredentialGateError::EnvUnset {
                provider: provider.to_string(),
                variable: variable.to_string(),
            });
    }
    if let Some(variable) = credential.optional_env.as_deref() {
        return Ok(non_empty(env.var(variable)).map(ApiKey));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeEnv(HashMap<&'static str, &'static str>);

    impl EnvSource for FakeEnv {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).map(|v| v.to_string())
        }
    }

    fn env(pairs: &[(&'static str, &'static str)]) -> FakeEnv {
        FakeEnv(pairs.iter().copied().collect())
    }

    fn reference(configure: impl FnOnce(&mut CredentialReference)) -> CredentialReference {
        let mut reference = CredentialReference::default();
        configure(&mut reference);
        reference
    }

    #[test]
    fn env_reference_returns_the_trimmed_key() {
        let credential = reference(|r| r.env = Some("K".into()));
        let key = resolve_api_key("a", Some(&credential), &env(&[("K", "  sk-1 \n")]))
            .unwrap()
            .unwrap();
        assert_eq!(key.expose(), "sk-1");
    }

    #[test]
    fn missing_credential_block_is_a_gate_error() {
        assert_eq!(
            resolve_api_key("a", None, &env(&[])).unwrap_err(),
            CredentialGateError::NotConfigured {
                provider: "a".into()
            }
        );
        assert!(matches!(
            resolve_api_key("a", Some(&CredentialReference::default()), &env(&[])),
            Err(CredentialGateError::NotConfigured { .. })
        ));
    }

    #[test]
    fn unset_or_blank_env_is_rejected_and_names_the_variable() {
        let credential = reference(|r| r.env = Some("K".into()));
        for environment in [env(&[]), env(&[("K", "   ")])] {
            let error = resolve_api_key("a", Some(&credential), &environment).unwrap_err();
            assert_eq!(
                error,
                CredentialGateError::EnvUnset {
                    provider: "a".into(),
                    variable: "K".into()
                }
            );
            assert!(error.to_string().contains("K"));
        }
    }

    #[test]
    fn oauth_and_file_sources_are_refused() {
        let oauth = reference(|r| r.oauth = Some("anthropic".into()));
        assert!(matches!(
            resolve_api_key("a", Some(&oauth), &env(&[])),
            Err(CredentialGateError::Unsupported {
                source: "oauth",
                ..
            })
        ));
        let file = reference(|r| r.file = Some("/home/u/key".into()));
        assert!(matches!(
            resolve_api_key("a", Some(&file), &env(&[])),
            Err(CredentialGateError::Unsupported { source: "file", .. })
        ));
    }

    #[test]
    fn optional_env_and_none_allow_a_keyless_request() {
        let optional = reference(|r| r.optional_env = Some("K".into()));
        assert_eq!(
            resolve_api_key("a", Some(&optional), &env(&[])).unwrap(),
            None
        );
        assert_eq!(
            resolve_api_key("a", Some(&optional), &env(&[("K", "x")]))
                .unwrap()
                .unwrap()
                .expose(),
            "x"
        );
        let none = reference(|r| r.none = Some(true));
        assert_eq!(resolve_api_key("a", Some(&none), &env(&[])).unwrap(), None);
    }

    #[test]
    fn two_sources_at_once_are_ambiguous() {
        let credential = reference(|r| {
            r.env = Some("K".into());
            r.optional_env = Some("J".into());
        });
        assert!(matches!(
            resolve_api_key("a", Some(&credential), &env(&[("K", "x")])),
            Err(CredentialGateError::Ambiguous { .. })
        ));
    }

    #[test]
    fn debug_output_never_contains_the_key() {
        let credential = reference(|r| r.env = Some("K".into()));
        let key = resolve_api_key("a", Some(&credential), &env(&[("K", "sk-secret")]))
            .unwrap()
            .unwrap();
        assert!(!format!("{key:?}").contains("sk-secret"));
    }
}
