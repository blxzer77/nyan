//! Optional embedding/Qdrant branch. It is deliberately isolated from the
//! deterministic local branches: an unavailable corp-pc or Qdrant never turns
//! a code search into an empty success.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::services::service_health::{self, CallPermit, FailureKind, ServiceKind};
use crate::utils::settings::nyan::{RetrievalSyncSettings, SemanticSettings};

use super::index::{LocalIndex, acquire_lock};
use super::outcome::{Branch, BranchStatus, Candidate, SearchRequest};

const QUERY_PREFIX: &str = "Find the most relevant code snippet given the following query:\n";
const GENERATION_VERSION: &str = "semantic-v1";

#[derive(Clone, Debug)]
pub struct SemanticClient {
    embedding: EmbeddingClient,
    qdrant: QdrantClient,
    pub generation: String,
    pub collection: String,
}

#[derive(Clone, Debug)]
struct EmbeddingClient {
    url: String,
    model: String,
    dim: usize,
    api_key: Option<String>,
    client: reqwest::Client,
    health: Arc<service_health::ServiceHealth>,
}

#[derive(Clone, Debug)]
struct QdrantClient {
    url: String,
    api_key: Option<String>,
    client: reqwest::Client,
    health: Arc<service_health::ServiceHealth>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SemanticSearchResult {
    pub candidates: Vec<Candidate>,
    pub status: BranchStatus,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyncReport {
    pub synced_files: usize,
    pub pending_files: usize,
    pub status: BranchStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PendingEntry {
    path: String,
    #[serde(rename = "fileHashRaw")]
    file_hash_raw: String,
}

impl SemanticClient {
    pub fn from_settings(
        settings: &SemanticSettings,
        root: &Path,
        budget: &crate::utils::settings::nyan::RetrievalBudgetSettings,
    ) -> anyhow::Result<Self> {
        crate::utils::tls_provider::install_crypto_provider();
        let embedding_settings = settings.embedding();
        let qdrant_settings = settings.qdrant();
        let connect_timeout = Duration::from_millis(budget.connect_timeout_ms());
        let embed_timeout = Duration::from_millis(budget.embed_timeout_ms());
        let qdrant_timeout = Duration::from_millis(budget.qdrant_timeout_ms());
        let embedding_health = service_health::shared(ServiceKind::Embedding);
        let qdrant_health = service_health::shared(ServiceKind::Qdrant);
        let embedding_client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(connect_timeout)
            .timeout(embed_timeout)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()?;
        let qdrant_client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(connect_timeout)
            .timeout(qdrant_timeout)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()?;
        let embedding = EmbeddingClient {
            url: embedding_settings.url().trim_end_matches('/').to_string(),
            model: embedding_settings.model().to_string(),
            dim: embedding_settings.dim() as usize,
            api_key: read_key(embedding_settings.api_key_file.as_deref())?,
            client: embedding_client,
            health: embedding_health,
        };
        let qdrant = QdrantClient {
            url: qdrant_settings.url().trim_end_matches('/').to_string(),
            api_key: read_key(qdrant_settings.api_key_file())?,
            client: qdrant_client,
            health: qdrant_health,
        };
        embedding.install_probe();
        qdrant.install_probe();
        let worktree_id = worktree_id(root);
        let generation = generation(&embedding, &worktree_id);
        let collection = format!(
            "nyan_{worktree_id}_{}",
            &generation[7..23.min(generation.len())]
        );
        Ok(Self {
            embedding,
            qdrant,
            generation,
            collection,
        })
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }

    pub fn collection(&self) -> &str {
        &self.collection
    }

    pub async fn search(
        &self,
        root: &Path,
        index: &LocalIndex,
        request: &SearchRequest,
        deadline: Duration,
    ) -> SemanticSearchResult {
        if deadline.is_zero() {
            return SemanticSearchResult {
                candidates: Vec::new(),
                status: BranchStatus::TimedOut,
            };
        }
        let result = tokio::time::timeout(deadline, self.search_inner(root, index, request)).await;
        match result {
            Ok(result) => result,
            Err(_) => SemanticSearchResult {
                candidates: Vec::new(),
                status: BranchStatus::TimedOut,
            },
        }
    }

    async fn search_inner(
        &self,
        _root: &Path,
        index: &LocalIndex,
        request: &SearchRequest,
    ) -> SemanticSearchResult {
        let query = format!("{QUERY_PREFIX}{}", request.query);
        let vector = match self.embedding.embed(&[query]).await {
            Ok(mut vectors) => vectors.pop().unwrap_or_default(),
            Err(error) => {
                return SemanticSearchResult {
                    candidates: Vec::new(),
                    status: BranchStatus::Unavailable { reason: error },
                };
            }
        };
        let points = match self.qdrant.search(&self.collection, &vector, 50).await {
            Ok(points) => points,
            Err(error) => {
                return SemanticSearchResult {
                    candidates: Vec::new(),
                    status: BranchStatus::Unavailable { reason: error },
                };
            }
        };
        let mut candidates = Vec::new();
        for (rank, point) in points.into_iter().enumerate() {
            let payload = point.get("payload").unwrap_or(&point);
            let Some(path) = payload.get("path").and_then(Value::as_str) else {
                continue;
            };
            let Some(file_hash_raw) = payload.get("fileHashRaw").and_then(Value::as_str) else {
                continue;
            };
            let start_line = payload
                .get("startLine")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let end_line = payload
                .get("endLine")
                .and_then(Value::as_u64)
                .unwrap_or(start_line as u64) as usize;
            if start_line == 0 {
                continue;
            }
            let symbol = payload
                .get("symbol")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let normalized_path = path.replace('\\', "/");
            let no_symbol_check = index
                .files()
                .iter()
                .find(|file| file.path == normalized_path)
                .is_none_or(|file| !file.symbol_checked);
            candidates.push(Candidate {
                branch: Branch::Semantic,
                path: normalized_path,
                start_line,
                end_line,
                symbol,
                file_hash_raw: file_hash_raw.to_string(),
                rank: rank + 1,
                score: point.get("score").and_then(Value::as_f64),
                no_symbol_check,
                ..Candidate::default()
            });
        }
        // The index is intentionally referenced here even though the payload
        // contains no source text; Inspect remains the source of truth.
        let _ = index.files().len();
        SemanticSearchResult {
            candidates,
            status: BranchStatus::Ok,
        }
    }

    /// Add changed chunks to the sole pending queue. The queue is JSONL and
    /// contains hashes/ranges only; source text never enters the Qdrant payload.
    pub fn enqueue_pending(&self, index: &LocalIndex, files: &[String]) -> Result<usize, String> {
        let path = index.storage().join("semantic-pending.jsonl");
        let mut output = String::new();
        for file in files {
            let Some(metadata) = index.files().iter().find(|entry| entry.path == *file) else {
                continue;
            };
            output.push_str(
                &serde_json::json!({"path": metadata.path, "fileHashRaw": metadata.file_hash_raw})
                    .to_string(),
            );
            output.push('\n');
        }
        if output.is_empty() {
            return Ok(0);
        }
        use std::io::Write;
        let mut handle = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|error| error.to_string())?;
        handle
            .write_all(output.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(output.lines().count())
    }

    pub fn pending_count(index: &LocalIndex) -> usize {
        std::fs::read_to_string(index.storage().join("semantic-pending.jsonl"))
            .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
            .unwrap_or(0)
    }

    /// Queue the first full synchronization exactly once. The marker and queue
    /// both live outside the worktree; a later sync worker can remove entries
    /// after a complete embedding + Qdrant batch.
    pub fn ensure_initial_pending(index: &LocalIndex) -> Result<usize, String> {
        let marker = index.storage().join("semantic-initialized");
        if marker.is_file() {
            return Ok(Self::pending_count(index));
        }
        let pending = index
            .files()
            .iter()
            .map(|file| {
                serde_json::json!({"path": file.path, "fileHashRaw": file.file_hash_raw})
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !pending.is_empty() {
            std::fs::write(
                index.storage().join("semantic-pending.jsonl"),
                format!("{pending}\n"),
            )
            .map_err(|error| error.to_string())?;
        }
        std::fs::write(marker, b"v1").map_err(|error| error.to_string())?;
        Ok(index.files().len())
    }

    /// Synchronize pending files in deterministic batches. A file leaves the
    /// queue only after every embedding and Qdrant upsert in that file's batch
    /// succeeds; a failure leaves the entry for the next background attempt.
    pub async fn sync_pending(
        &self,
        index: &LocalIndex,
        settings: &RetrievalSyncSettings,
    ) -> SyncReport {
        let Some(_lock) = acquire_lock(index.storage()) else {
            let pending = Self::pending_count(index);
            return SyncReport {
                synced_files: 0,
                pending_files: pending,
                status: BranchStatus::Partial { pending },
            };
        };
        let queue_path = index.storage().join("semantic-pending.jsonl");
        let entries = std::fs::read_to_string(&queue_path)
            .map(|text| {
                text.lines()
                    .filter_map(|line| serde_json::from_str::<PendingEntry>(line).ok())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if entries.is_empty() {
            return SyncReport {
                synced_files: 0,
                pending_files: 0,
                status: BranchStatus::Ok,
            };
        }

        let batch_size = settings.batch_size().max(1) as usize;
        let mut remaining = Vec::new();
        let mut synced = 0;
        let mut failure = None;
        let mut failed_after = None;
        let mut seen = HashSet::new();
        for (entry_index, entry) in entries.iter().cloned().enumerate() {
            if !seen.insert((entry.path.clone(), entry.file_hash_raw.clone())) {
                continue;
            }
            let Some(file) = index
                .files()
                .iter()
                .find(|file| file.path == entry.path && file.file_hash_raw == entry.file_hash_raw)
            else {
                // A deleted or changed file is not a successful old payload;
                // leave changed files to the next index refresh and drop deleted
                // files from this queue generation.
                if index.files().iter().any(|file| file.path == entry.path) {
                    remaining.push(entry);
                }
                continue;
            };
            let Ok(text) = std::fs::read_to_string(index.root().join(&file.path)) else {
                remaining.push(entry);
                failure = Some("file unavailable".to_string());
                failed_after = Some(entry_index + 1);
                break;
            };
            let lines = text.lines().collect::<Vec<_>>();
            let mut points = Vec::new();
            for chunk in &file.chunks {
                let content = lines
                    .get(chunk.start_line.saturating_sub(1)..chunk.end_line.min(lines.len()))
                    .map(|lines| lines.join("\\n"))
                    .unwrap_or_default();
                if content.is_empty() {
                    continue;
                }
                points.push((chunk, content));
            }
            let mut file_ok = true;
            for batch in points.chunks(batch_size) {
                let documents = batch
                    .iter()
                    .map(|(_, content)| content.clone())
                    .collect::<Vec<_>>();
                let vectors = match self.embedding.embed(&documents).await {
                    Ok(vectors) if vectors.len() == batch.len() => vectors,
                    Ok(_) => {
                        failure = Some("embedding count mismatch".to_string());
                        file_ok = false;
                        break;
                    }
                    Err(error) => {
                        failure = Some(error);
                        file_ok = false;
                        break;
                    }
                };
                let payloads = batch
                    .iter()
                    .map(|(chunk, _)| {
                        let chunk_id = short_hash(
                            format!("{}:{}:{}", file.path, chunk.start_line, chunk.end_line)
                                .as_bytes(),
                            32,
                        );
                        json!({
                            "id": chunk_id,
                            "vector": [],
                            "payload": {
                                "path": file.path,
                                "startLine": chunk.start_line,
                                "endLine": chunk.end_line,
                                "chunkId": chunk_id,
                                "fileHashRaw": file.file_hash_raw,
                                "symbol": chunk.symbol,
                            }
                        })
                    })
                    .zip(vectors)
                    .map(|(mut point, vector)| {
                        point["vector"] = serde_json::to_value(vector).unwrap_or(Value::Null);
                        point
                    })
                    .collect::<Vec<_>>();
                if let Err(error) = self
                    .qdrant
                    .upsert(&self.collection, payloads, self.embedding.dim)
                    .await
                {
                    failure = Some(error);
                    file_ok = false;
                    break;
                }
            }
            if file_ok {
                synced += 1;
            } else {
                remaining.push(entry);
                if failure.is_some() {
                    failed_after = Some(entry_index + 1);
                    break;
                }
            }
        }
        if let Some(error) = failure {
            // Preserve entries not visited after the first failed file.
            if let Some(start) = failed_after {
                remaining.extend(entries.into_iter().skip(start));
            }
            let _ = std::fs::write(
                &queue_path,
                remaining
                    .iter()
                    .filter_map(|entry| serde_json::to_string(entry).ok())
                    .collect::<Vec<_>>()
                    .join("\\n")
                    + if remaining.is_empty() { "" } else { "\\n" },
            );
            return SyncReport {
                synced_files: synced,
                pending_files: remaining.len(),
                status: BranchStatus::Unavailable { reason: error },
            };
        }
        let _ = std::fs::write(
            &queue_path,
            remaining
                .iter()
                .filter_map(|entry| serde_json::to_string(entry).ok())
                .collect::<Vec<_>>()
                .join("\\n")
                + if remaining.is_empty() { "" } else { "\\n" },
        );
        SyncReport {
            synced_files: synced,
            pending_files: remaining.len(),
            status: if remaining.is_empty() {
                BranchStatus::Ok
            } else {
                BranchStatus::Partial {
                    pending: remaining.len(),
                }
            },
        }
    }
}

impl EmbeddingClient {
    fn install_probe(&self) {
        let client = self.client.clone();
        let url = self.url.clone();
        let model = self.model.clone();
        self.health.set_probe(Some(Arc::new(move || {
            let client = client.clone();
            let url = url.clone();
            let model = model.clone();
            Box::pin(async move {
                let response = client
                    .get(format!("{url}/v1/models"))
                    .send()
                    .await
                    .map_err(|_| ())?;
                if !response.status().is_success() {
                    return Err(());
                }
                let body: Value = response.json().await.map_err(|_| ())?;
                let served = body
                    .get("data")
                    .and_then(Value::as_array)
                    .is_some_and(|models| {
                        models.iter().any(|entry| {
                            entry.get("id").and_then(Value::as_str) == Some(model.as_str())
                        })
                    });
                served.then_some(()).ok_or(())
            })
        })));
    }

    async fn embed(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
        match self.health.call_permit() {
            CallPermit::Skipped => return Err("embedding service unreachable".to_string()),
            CallPermit::Probe => {
                self.health.spawn_probe();
                return Err("embedding service unreachable".to_string());
            }
            CallPermit::Allowed => {}
        }
        let mut request = self
            .client
            .post(format!("{}/v1/embeddings", self.url))
            .json(&json!({
                "model": self.model,
                "input": inputs,
                "encoding_format": "base64",
            }));
        if let Some(key) = self.api_key.as_deref() {
            request = request.bearer_auth(key);
        }
        let response = request.send().await.map_err(|error| {
            self.health.record_failure(if error.is_timeout() {
                FailureKind::Timeout
            } else {
                FailureKind::Unreachable
            });
            error.to_string()
        })?;
        if !response.status().is_success() {
            self.health
                .record_failure(if response.status().as_u16() == 429 {
                    FailureKind::RateLimited
                } else {
                    FailureKind::Unreachable
                });
            return Err(format!("embedding HTTP {}", response.status()));
        }
        let body: Value = response.json().await.map_err(|error| {
            self.health.record_failure(FailureKind::InvalidResponse);
            error.to_string()
        })?;
        let Some(data) = body.get("data").and_then(Value::as_array) else {
            self.health.record_failure(FailureKind::InvalidResponse);
            return Err("embedding response has no data".to_string());
        };
        if data.len() != inputs.len() {
            self.health.record_failure(FailureKind::InvalidResponse);
            return Err("embedding count mismatch".to_string());
        }
        let mut vectors = Vec::new();
        for entry in data {
            let Some(encoded) = entry.get("embedding").and_then(Value::as_str) else {
                self.health.record_failure(FailureKind::InvalidResponse);
                return Err("embedding is not base64".to_string());
            };
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| {
                    self.health.record_failure(FailureKind::InvalidResponse);
                    "invalid embedding base64".to_string()
                })?;
            if bytes.len() != self.dim * 4 {
                self.health.record_failure(FailureKind::InvalidResponse);
                return Err(format!("embedding dimension mismatch: {}", bytes.len() / 4));
            }
            let values = bytes
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect::<Vec<_>>();
            let norm = values
                .iter()
                .map(|value| (*value as f64) * (*value as f64))
                .sum::<f64>()
                .sqrt();
            if !values.iter().all(|value| value.is_finite()) || !norm.is_finite() || norm == 0.0 {
                self.health.record_failure(FailureKind::InvalidResponse);
                return Err("embedding contains non-finite values".to_string());
            }
            vectors.push(values);
        }
        self.health.record_success();
        Ok(vectors)
    }
}

impl QdrantClient {
    fn install_probe(&self) {
        let client = self.client.clone();
        let url = self.url.clone();
        let api_key = self.api_key.clone();
        self.health.set_probe(Some(Arc::new(move || {
            let client = client.clone();
            let url = url.clone();
            let api_key = api_key.clone();
            Box::pin(async move {
                let mut request = client.get(format!("{url}/healthz"));
                if let Some(key) = api_key.as_deref() {
                    request = request.header("api-key", key);
                }
                let response = request.send().await.map_err(|_| ())?;
                response.status().is_success().then_some(()).ok_or(())
            })
        })));
    }

    async fn upsert(
        &self,
        collection: &str,
        points: Vec<Value>,
        dimension: usize,
    ) -> Result<(), String> {
        match self.health.call_permit() {
            CallPermit::Skipped => return Err("Qdrant service unreachable".to_string()),
            CallPermit::Probe => {
                self.health.spawn_probe();
                return Err("Qdrant service unreachable".to_string());
            }
            CallPermit::Allowed => {}
        }
        self.ensure_collection(collection, dimension).await?;
        let url = format!("{}/collections/{collection}/points?wait=true", self.url);
        let mut request = self.client.put(url).json(&json!({"points": points}));
        if let Some(key) = self.api_key.as_deref() {
            request = request.header("api-key", key);
        }
        let response = request.send().await.map_err(|error| {
            self.health.record_failure(if error.is_timeout() {
                FailureKind::Timeout
            } else {
                FailureKind::Unreachable
            });
            error.to_string()
        })?;
        if !response.status().is_success() {
            self.health.record_failure(FailureKind::Unreachable);
            return Err(format!("Qdrant upsert HTTP {}", response.status()));
        }
        self.health.record_success();
        Ok(())
    }

    async fn ensure_collection(&self, collection: &str, dimension: usize) -> Result<(), String> {
        let url = format!("{}/collections/{collection}", self.url);
        let mut request = self.client.put(url).json(&json!({
            "vectors": {"size": dimension, "distance": "Cosine"}
        }));
        if let Some(key) = self.api_key.as_deref() {
            request = request.header("api-key", key);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        if response.status().is_success() || response.status().as_u16() == 409 {
            Ok(())
        } else {
            Err(format!("Qdrant collection HTTP {}", response.status()))
        }
    }

    async fn search(
        &self,
        collection: &str,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        match self.health.call_permit() {
            CallPermit::Skipped => return Err("Qdrant service unreachable".to_string()),
            CallPermit::Probe => {
                self.health.spawn_probe();
                return Err("Qdrant service unreachable".to_string());
            }
            CallPermit::Allowed => {}
        }
        let url = format!("{}/collections/{collection}/points/search", self.url);
        let mut request = self.client.post(url).json(&json!({
            "vector": vector,
            "limit": limit,
            "with_payload": true,
        }));
        if let Some(key) = self.api_key.as_deref() {
            request = request.header("api-key", key);
        }
        let response = request.send().await.map_err(|error| {
            self.health.record_failure(if error.is_timeout() {
                FailureKind::Timeout
            } else {
                FailureKind::Unreachable
            });
            error.to_string()
        })?;
        if !response.status().is_success() {
            self.health.record_failure(FailureKind::Unreachable);
            return Err(format!("Qdrant HTTP {}", response.status()));
        }
        let body: Value = response.json().await.map_err(|error| {
            self.health.record_failure(FailureKind::InvalidResponse);
            error.to_string()
        })?;
        let points = body
            .get("result")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.health.record_success();
        Ok(points)
    }
}

fn read_key(path: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let path = crate::utils::path::expand_path(path, None).map_err(anyhow::Error::msg)?;
    if !path.is_file() {
        return Ok(None);
    }
    let value = std::fs::read_to_string(path)?.trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

pub fn worktree_id(root: &Path) -> String {
    let machine_source = std::fs::read_to_string("/etc/machine-id")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "unknown-machine".to_string());
    let machine = short_hash(machine_source.as_bytes(), 12);
    let path = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    format!(
        "{}-{}",
        machine,
        short_hash(path.to_string_lossy().as_bytes(), 16)
    )
}

fn generation(client: &EmbeddingClient, worktree_id: &str) -> String {
    let value = serde_json::json!({
        "embeddingModelId": client.model,
        "embeddingDim": client.dim,
        "normalize": true,
        "precision": "float32",
        "taskPrefix": {"query": QUERY_PREFIX, "document": ""},
        "chunkerVersion": "line-symbol-v1",
        "indexSchemaVersion": GENERATION_VERSION,
        "worktreeId": worktree_id,
    });
    format!("semgen-{}", short_hash(value.to_string().as_bytes(), 32))
}

fn short_hash(bytes: &[u8], length: usize) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .chars()
        .take(length)
        .collect()
}

use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_id_is_machine_and_path_scoped_without_raw_machine_id() {
        let id = worktree_id(Path::new("/tmp/project"));
        assert!(
            id.split('-')
                .all(|part| part.chars().all(|character| character.is_ascii_hexdigit()))
        );
        assert_eq!(id.len(), 12 + 1 + 16);
    }

    #[test]
    fn generation_uses_documented_query_prefix() {
        assert!(QUERY_PREFIX.starts_with("Find the most relevant code snippet"));
    }
}
