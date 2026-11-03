//! Pinned model metadata snapshot imported from Pi Agent and models.dev.
//!
//! Maps to docs/nyan/provider-redesign.md §3.3 and decisions 13–15:
//! - Checked-in JSON metadata snapshot
//! - Schema version & content hash verification
//! - Filtering: models missing contextWindow, maxTokens, input, reasoning, or api
//!   are excluded from runnable snapshot
//! - Purely offline / no network calls at runtime

use std::collections::BTreeMap;
use std::fmt;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::utils::settings::nyan::ModelCapabilities;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostEntry {
    pub input: f64,
    pub output: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMetadataEntry {
    pub provider: String,
    pub model: String,
    pub display_name: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub capabilities: ModelCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCostEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input: Vec<String>,
}

impl ModelMetadataEntry {
    pub fn validate(&self, key: &str) -> Result<(), MetadataValidationError> {
        if self.provider.trim().is_empty() {
            return Err(MetadataValidationError::InvalidEntry {
                key: key.to_string(),
                reason: "missing provider".to_string(),
            });
        }
        if self.model.trim().is_empty() {
            return Err(MetadataValidationError::InvalidEntry {
                key: key.to_string(),
                reason: "missing model id".to_string(),
            });
        }
        if self.context_window == 0 {
            return Err(MetadataValidationError::InvalidEntry {
                key: key.to_string(),
                reason: "missing contextWindow".to_string(),
            });
        }
        if self.max_output_tokens == 0 {
            return Err(MetadataValidationError::InvalidEntry {
                key: key.to_string(),
                reason: "missing maxOutputTokens".to_string(),
            });
        }
        if self.input.is_empty() {
            return Err(MetadataValidationError::InvalidEntry {
                key: key.to_string(),
                reason: "missing input modalities".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMetadataSnapshot {
    pub schema_version: u32,
    pub pi_commit: String,
    pub models_dev_version: String,
    pub generated_at: String,
    pub hash: String,
    pub models: BTreeMap<String, ModelMetadataEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataValidationError {
    UnsupportedSchemaVersion(u32),
    HashMismatch { expected: String, actual: String },
    InvalidEntry { key: String, reason: String },
    SerializationError(String),
}

impl fmt::Display for MetadataValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion(version) => {
                write!(
                    f,
                    "Unsupported metadata schema version {version}; expected 1"
                )
            }
            Self::HashMismatch { expected, actual } => {
                write!(
                    f,
                    "Metadata hash mismatch: expected {expected}, computed {actual}"
                )
            }
            Self::InvalidEntry { key, reason } => {
                write!(f, "Invalid metadata entry for {key:?}: {reason}")
            }
            Self::SerializationError(err) => {
                write!(f, "Metadata serialization error: {err}")
            }
        }
    }
}

impl std::error::Error for MetadataValidationError {}

/// Compute SHA-256 hash of the canonical JSON representation of models.
pub fn compute_models_hash(
    models: &BTreeMap<String, ModelMetadataEntry>,
) -> Result<String, MetadataValidationError> {
    let json = serde_json::to_string(models)
        .map_err(|e| MetadataValidationError::SerializationError(e.to_string()))?;
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    let hash = hasher.finalize();
    let mut hex = String::with_capacity(hash.len() * 2);
    for b in hash {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
    }
    Ok(hex)
}

impl ModelMetadataSnapshot {
    /// Validates the snapshot's schema version, hash, and entries.
    pub fn verify(&self) -> Result<(), MetadataValidationError> {
        if self.schema_version != 1 {
            return Err(MetadataValidationError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        let computed = compute_models_hash(&self.models)?;
        if computed != self.hash {
            return Err(MetadataValidationError::HashMismatch {
                expected: self.hash.clone(),
                actual: computed,
            });
        }
        for (key, entry) in &self.models {
            entry.validate(key)?;
        }
        Ok(())
    }
}

pub static BUILTIN_METADATA_SNAPSHOT: LazyLock<ModelMetadataSnapshot> = LazyLock::new(|| {
    let raw = include_str!("model_metadata.json");
    let snapshot: ModelMetadataSnapshot =
        serde_json::from_str(raw).expect("valid model_metadata.json checked into tree");
    snapshot
});

/// Returns a reference to the checked-in model metadata snapshot.
pub fn get_builtin_metadata_snapshot() -> &'static ModelMetadataSnapshot {
    &BUILTIN_METADATA_SNAPSHOT
}

/// Find model metadata by provider and model wire ID.
pub fn find_model_metadata(provider: &str, model: &str) -> Option<&'static ModelMetadataEntry> {
    let snapshot = get_builtin_metadata_snapshot();
    let key = format!("{provider}/{model}");
    if let Some(entry) = snapshot.models.get(&key) {
        return Some(entry);
    }

    let key_lower = format!(
        "{}/{}",
        provider.to_ascii_lowercase(),
        model.to_ascii_lowercase()
    );
    for (k, entry) in &snapshot.models {
        if k.to_ascii_lowercase() == key_lower {
            return Some(entry);
        }
    }

    // Provider-specific aliases
    if provider.eq_ignore_ascii_case("gemini") {
        let google_key = format!("google/{model}");
        if let Some(entry) = snapshot.models.get(&google_key) {
            return Some(entry);
        }
    } else if provider.eq_ignore_ascii_case("google") {
        let gemini_key = format!("gemini/{model}");
        if let Some(entry) = snapshot.models.get(&gemini_key) {
            return Some(entry);
        }
    }

    // Fallback: match by model wire ID across snapshot
    for entry in snapshot.models.values() {
        if entry.model.eq_ignore_ascii_case(model) {
            return Some(entry);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_snapshot_passes_schema_and_hash_verification() {
        let snapshot = get_builtin_metadata_snapshot();
        assert_eq!(snapshot.schema_version, 1);
        assert!(!snapshot.pi_commit.is_empty());
        assert!(!snapshot.models_dev_version.is_empty());
        assert!(!snapshot.hash.is_empty());
        assert!(snapshot.models.len() >= 50);

        // Hash verification must succeed
        snapshot.verify().expect("builtin snapshot must verify");
    }

    #[test]
    fn hash_mismatch_is_rejected() {
        let mut snapshot = get_builtin_metadata_snapshot().clone();
        snapshot.hash =
            "0000000000000000000000000000000000000000000000000000000000000000".to_string();
        let err = snapshot.verify().unwrap_err();
        assert!(matches!(err, MetadataValidationError::HashMismatch { .. }));
    }

    #[test]
    fn schema_version_mismatch_is_rejected() {
        let mut snapshot = get_builtin_metadata_snapshot().clone();
        snapshot.schema_version = 99;
        let err = snapshot.verify().unwrap_err();
        assert_eq!(err, MetadataValidationError::UnsupportedSchemaVersion(99));
    }

    #[test]
    fn entry_missing_context_window_is_rejected() {
        let mut entry = find_model_metadata("anthropic", "claude-sonnet-4-6")
            .expect("claude-sonnet-4-6 exists")
            .clone();
        entry.context_window = 0;
        let err = entry.validate("test-entry").unwrap_err();
        assert!(
            matches!(err, MetadataValidationError::InvalidEntry { reason, .. } if reason.contains("contextWindow"))
        );
    }

    #[test]
    fn finds_builtin_models() {
        let sonnet = find_model_metadata("anthropic", "claude-sonnet-4-6");
        assert!(sonnet.is_some());
        let sonnet = sonnet.unwrap();
        assert_eq!(sonnet.provider, "anthropic");
        assert_eq!(sonnet.model, "claude-sonnet-4-6");
        assert!(sonnet.context_window >= 200_000);
        assert!(sonnet.max_output_tokens > 0);

        let gpt4o = find_model_metadata("openai", "gpt-4o");
        assert!(gpt4o.is_some());
    }
}
