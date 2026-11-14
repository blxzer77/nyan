//! Deterministic-first local code retrieval and optional semantic enhancement.
//!
//! @nyan: this module is a library first. `CodeSearch` is only one adapter; the
//! memory module and evaluation harnesses consume the same structured
//! `SearchOutcome` without parsing model-facing text.
//!
//! Pipeline (retrieval 4.4): exact → symbol/text over the local index →
//! optional semantic → RRF fusion → optional rerank → Inspect →
//! `retrieval.answers` → `retrieval.sufficient` (at most one extra round).
//! Every branch always runs; decisions only reorder and annotate.

pub mod decisions;
pub mod exact;
pub mod fusion;
pub mod index;
pub mod inspect;
pub mod memory;
pub mod outcome;
pub mod render;
pub mod semantic;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use crate::services::decision::DecisionProvider;
use crate::services::rerank::{self, RerankClient, RerankKind, RerankRequest};
use crate::tool::AbortController;

pub use outcome::{
    Branch, BranchResult, BranchStatus, Candidate, DecisionRecord, SearchOutcome, SearchRequest,
};

const MAX_BRANCH_CANDIDATES: usize = 50;
const FUSION_KEEP: usize = 50;
const FINAL_RESULTS: usize = 30;
/// One prepared index per worktree per process, shared by every search and
/// background sync. Each worktree has its own slot lock, so concurrent
/// searches wait for one refresh and then share its result instead of each
/// rebuilding the file table.
type IndexSlot = Arc<Mutex<Option<Arc<index::LocalIndex>>>>;
static INDEX_CACHE: OnceLock<Mutex<BTreeMap<PathBuf, IndexSlot>>> = OnceLock::new();

/// The per-worktree index. A missing first build is deferred to a background
/// task (`Ok(None)`), which the caller renders as `Building` rather than
/// blocking the tool call on a full walk. A cached index is refreshed only
/// when [`index::LocalIndex::needs_refresh`] sees a change, and then from its
/// in-memory table; either way the work runs on the blocking pool, never on
/// the async worker.
async fn cached_index(
    root: &Path,
    max_file_bytes: u64,
    permission_context: &crate::tool::ToolPermissionContext,
) -> Result<Option<Arc<index::LocalIndex>>, String> {
    let root = root.to_path_buf();
    let permission = permission_context.clone();
    tokio::task::spawn_blocking(move || cached_index_blocking(&root, max_file_bytes, &permission))
        .await
        .map_err(|error| format!("index task failed: {error}"))?
}

fn cached_index_blocking(
    root: &Path,
    max_file_bytes: u64,
    permission_context: &crate::tool::ToolPermissionContext,
) -> Result<Option<Arc<index::LocalIndex>>, String> {
    let slot = Arc::clone(
        INDEX_CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(root.to_path_buf())
            .or_default(),
    );
    let mut cached = slot.lock().unwrap_or_else(PoisonError::into_inner);
    let fresh = match cached.as_ref() {
        Some(index) if index.max_file_bytes() == max_file_bytes => {
            // A read-only view whose text index another process is still
            // building retries until that build lands.
            if index.state == index::IndexState::Ready && !index.needs_refresh() {
                return Ok(Some(Arc::clone(index)));
            }
            Some(index.refresh(permission_context)?)
        }
        _ => index::LocalIndex::open_or_defer(root, max_file_bytes, permission_context)?,
    };
    let fresh = fresh.map(Arc::new);
    cached.clone_from(&fresh);
    Ok(fresh)
}

/// Run the complete retrieval plan for a worktree.
pub async fn search(
    request: SearchRequest,
    cwd: &Path,
    abort: &AbortController,
    permission_context: &crate::tool::ToolPermissionContext,
) -> SearchOutcome {
    // The decision provider is configured in `settings.nyan.decision`; without
    // this the retrieval.intent/answers/sufficient points never ran in
    // production (they only ran in tests that inject one).
    let provider = crate::services::decision::DecisionProvider::from_nyan(
        &crate::utils::settings::get_initial_settings()
            .nyan
            .unwrap_or_default(),
    );
    search_with_provider(request, cwd, abort, permission_context, Some(&provider)).await
}

/// Variant used by tests and future callers that hold a provider instance.
pub async fn search_with_provider(
    request: SearchRequest,
    cwd: &Path,
    abort: &AbortController,
    permission_context: &crate::tool::ToolPermissionContext,
    provider: Option<&DecisionProvider>,
) -> SearchOutcome {
    let started = Instant::now();
    let settings = crate::utils::settings::get_settings_with_errors().settings;
    let retrieval = settings
        .nyan
        .as_ref()
        .map(|nyan| nyan.retrieval())
        .unwrap_or_default();
    let budget = retrieval.budget();
    let deadline = Duration::from_millis(budget.deadline_ms());
    let root = match cwd.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            return failed_outcome(
                request,
                format!("worktree unavailable: {error}"),
                started.elapsed(),
            );
        }
    };
    let mut decisions_log = Vec::new();
    let mut branches = BTreeMap::new();
    let mut candidates_by_branch = Vec::new();

    if abort.is_aborted() {
        for branch in Branch::DETERMINISTIC {
            branches.insert(
                branch,
                BranchResult {
                    status: BranchStatus::Cancelled,
                    ..Default::default()
                },
            );
        }
        let weight = decisions::IntentDecision::deterministic(&request.query).symbol_weight;
        return finish(
            request,
            branches,
            candidates_by_branch,
            started,
            budget.rrf_k(),
            weight,
            false,
            decisions_log,
            false,
        );
    }

    // 4.11: intent only changes the symbol weight and relation expansion.
    let intent =
        decisions::decide_intent(provider, &request.query, abort, &mut decisions_log).await;

    let exact_started = Instant::now();
    match exact::search_exact(&root, &request, abort, permission_context) {
        Ok(mut candidates) => {
            let elapsed_ms = exact_started.elapsed().as_millis() as u64;
            for candidate in &mut candidates {
                candidate.latency_ms = elapsed_ms;
            }
            branches.insert(
                Branch::Exact,
                BranchResult {
                    status: BranchStatus::Ok,
                    candidates: candidates.clone(),
                    elapsed_ms,
                },
            );
            candidates_by_branch.push((Branch::Exact, candidates));
        }
        Err(error) if error.contains("aborted") => {
            branches.insert(
                Branch::Exact,
                BranchResult {
                    status: BranchStatus::Cancelled,
                    elapsed_ms: exact_started.elapsed().as_millis() as u64,
                    ..Default::default()
                },
            );
        }
        Err(error) => {
            branches.insert(
                Branch::Exact,
                BranchResult {
                    status: BranchStatus::Unavailable { reason: error },
                    elapsed_ms: exact_started.elapsed().as_millis() as u64,
                    ..Default::default()
                },
            );
        }
    }

    let index_started = Instant::now();
    let index = match cached_index(
        &root,
        retrieval.index().max_file_bytes(),
        permission_context,
    )
    .await
    {
        Ok(Some(index)) => {
            // 4.8.1: changed files enter the pending queue; queued entries for
            // deleted files leave it.
            if retrieval.semantic().is_some()
                && let Some(semantic_settings) = retrieval.semantic()
                && let Ok(client) =
                    semantic::SemanticClient::from_settings(&semantic_settings, &root, &budget)
            {
                let _ = client.queue_changed(&index);
                let _ = client.ensure_initial_pending(&index);
            }
            Some(index)
        }
        Ok(None) => {
            // 4.10: the first build runs in the background; exact still
            // answers and symbol/text say so instead of "no matches".
            for branch in [Branch::Symbol, Branch::Text] {
                branches.insert(
                    branch,
                    BranchResult {
                        status: BranchStatus::Building,
                        elapsed_ms: index_started.elapsed().as_millis() as u64,
                        ..Default::default()
                    },
                );
            }
            None
        }
        Err(error) => {
            branches.insert(
                Branch::Symbol,
                BranchResult {
                    status: BranchStatus::Unavailable {
                        reason: error.clone(),
                    },
                    elapsed_ms: index_started.elapsed().as_millis() as u64,
                    ..Default::default()
                },
            );
            branches.insert(
                Branch::Text,
                BranchResult {
                    status: BranchStatus::Unavailable {
                        reason: "local index unavailable".to_string(),
                    },
                    elapsed_ms: index_started.elapsed().as_millis() as u64,
                    ..Default::default()
                },
            );
            None
        }
    };

    if let Some(index) = index.as_ref() {
        if abort.is_aborted() {
            branches.insert(
                Branch::Symbol,
                BranchResult {
                    status: BranchStatus::Cancelled,
                    ..Default::default()
                },
            );
            branches.insert(
                Branch::Text,
                BranchResult {
                    status: BranchStatus::Cancelled,
                    ..Default::default()
                },
            );
        } else if index.state != index::IndexState::Ready {
            let status = if index.state == index::IndexState::Building {
                BranchStatus::Building
            } else {
                BranchStatus::Rebuilding
            };
            for branch in [Branch::Symbol, Branch::Text] {
                branches.insert(
                    branch,
                    BranchResult {
                        status: status.clone(),
                        elapsed_ms: index_started.elapsed().as_millis() as u64,
                        ..Default::default()
                    },
                );
            }
        } else {
            let symbol_started = Instant::now();
            let mut symbols =
                index.search_symbols(&request, intent.relation, false, MAX_BRANCH_CANDIDATES);
            let symbol_elapsed_ms = symbol_started.elapsed().as_millis() as u64;
            for candidate in &mut symbols {
                candidate.latency_ms = symbol_elapsed_ms;
            }
            branches.insert(
                Branch::Symbol,
                BranchResult {
                    status: BranchStatus::Ok,
                    candidates: symbols.clone(),
                    elapsed_ms: symbol_elapsed_ms,
                },
            );
            candidates_by_branch.push((Branch::Symbol, symbols));

            let text_started = Instant::now();
            let text = index.search_text(&request, MAX_BRANCH_CANDIDATES);
            let text_elapsed_ms = text_started.elapsed().as_millis() as u64;
            match text {
                Some(mut text) => {
                    for candidate in &mut text {
                        candidate.latency_ms = text_elapsed_ms;
                    }
                    branches.insert(
                        Branch::Text,
                        BranchResult {
                            status: BranchStatus::Ok,
                            candidates: text.clone(),
                            elapsed_ms: text_elapsed_ms,
                        },
                    );
                    candidates_by_branch.push((Branch::Text, text));
                }
                None => {
                    branches.insert(
                        Branch::Text,
                        BranchResult {
                            status: BranchStatus::Unavailable {
                                reason: "text index unusable".to_string(),
                            },
                            elapsed_ms: text_elapsed_ms,
                            ..Default::default()
                        },
                    );
                }
            }
        }
    }

    if let (Some(semantic_settings), Some(index)) = (retrieval.semantic(), index.as_ref()) {
        match semantic::SemanticClient::from_settings(&semantic_settings, &root, &budget) {
            Ok(client) => {
                let pending = semantic::SemanticClient::pending_count(index);
                if pending > 0 {
                    // 4.8.1: the background sync outlives this tool call, so
                    // it runs on the process-lifetime runtime rather than the
                    // per-query one (utils::process_runtime).
                    let sync_settings = retrieval.sync();
                    let background_index = Arc::clone(index);
                    let background_client = client.clone();
                    let future = async move {
                        let report = background_client
                            .sync_pending(&background_index, &sync_settings)
                            .await;
                        // Named, never silent: a stopped circuit breaker or a
                        // Down service must be visible in the log even though
                        // the tool result only carries the pending count.
                        crate::utils::debug::log_for_debugging(&format!(
                            "retrieval semantic sync: synced_chunks={} pending_files={} status={:?}",
                            report.synced_chunks, report.pending_files, report.status
                        ));
                    };
                    if let Some(handle) =
                        crate::utils::process_runtime::runtime_handle_for_detached_work()
                    {
                        handle.spawn(future);
                    } else {
                        tokio::spawn(future);
                    }
                }
                let semantic_started = Instant::now();
                let mut result = client
                    .search(
                        index,
                        &request,
                        Duration::from_millis(budget.semantic_deadline_ms()),
                    )
                    .await;
                let pending = semantic::SemanticClient::pending_count(index);
                if pending > 0 && result.status == BranchStatus::Ok {
                    result.status = BranchStatus::Partial { pending };
                }
                let semantic_elapsed_ms = semantic_started.elapsed().as_millis() as u64;
                for candidate in &mut result.candidates {
                    candidate.latency_ms = semantic_elapsed_ms;
                }
                branches.insert(
                    Branch::Semantic,
                    BranchResult {
                        status: result.status.clone(),
                        candidates: result.candidates.clone(),
                        elapsed_ms: semantic_elapsed_ms,
                    },
                );
                if result.status.is_successful() {
                    candidates_by_branch.push((Branch::Semantic, result.candidates));
                }
            }
            Err(error) => {
                branches.insert(
                    Branch::Semantic,
                    BranchResult {
                        status: BranchStatus::Unavailable {
                            reason: error.to_string(),
                        },
                        ..Default::default()
                    },
                );
            }
        }
    }

    let mut outcome = finish(
        request.clone(),
        branches,
        candidates_by_branch,
        started,
        budget.rrf_k(),
        intent.symbol_weight,
        false,
        std::mem::take(&mut decisions_log),
        false,
    );
    if !deadline.is_zero() && started.elapsed() > deadline {
        for result in outcome.branches.values_mut() {
            if result.status == BranchStatus::Ok && result.candidates.is_empty() {
                result.status = BranchStatus::TimedOut;
            }
        }
    }
    inspect_and_rerank(&mut outcome, &root, &retrieval).await;

    // 4.11: answers annotate and move; prune is shadow and only records.
    let mut decisions = std::mem::take(&mut outcome.decisions);
    decisions::decide_answers(
        provider,
        &outcome.query,
        &mut outcome.candidates,
        abort,
        &mut decisions,
    )
    .await;
    decisions::decide_prune_shadow(
        provider,
        &outcome.query,
        &outcome.candidates,
        abort,
        &mut decisions,
    )
    .await;

    // retrieval.sufficient: at most one extra round (semantic was skipped or
    // the model wants more than the current page).
    let sufficient = decisions::decide_sufficient(
        provider,
        &outcome.query,
        &outcome.candidates,
        abort,
        &mut decisions,
    )
    .await;
    let mut extra_round_keys = std::collections::BTreeSet::new();
    if sufficient && !abort.is_aborted() {
        let extra_candidates = extra_round(
            &root,
            &request,
            &outcome,
            abort,
            permission_context,
            &retrieval,
        )
        .await;
        if !extra_candidates.is_empty() {
            // Only candidates the original page did not already have count as
            // "new results of the extra round" for the post-hoc probe.
            let existing = outcome
                .candidates
                .iter()
                .map(Candidate::key)
                .collect::<std::collections::BTreeSet<_>>();
            extra_round_keys = extra_candidates
                .iter()
                .map(Candidate::key)
                .filter(|key| !existing.contains(key))
                .collect();
            let mut merged = outcome.candidates.clone();
            merged.extend(extra_candidates);
            let mut seen = std::collections::BTreeSet::new();
            merged.retain(|candidate| seen.insert(candidate.key()));
            outcome.candidates = merged;
            inspect_and_rerank(&mut outcome, &root, &retrieval).await;
            outcome.extra_round = true;
        }
    }
    // §7: record what the model was shown so a later Read can be attributed
    // to the decisions that retained it.
    decisions::register_retained_probes(
        &root,
        &outcome.candidates,
        request.bounded_max_results(),
        &extra_round_keys,
    );
    outcome.decisions = decisions;
    outcome.elapsed_ms = started.elapsed().as_millis() as u64;
    outcome
}

/// The single extra round. Design rule: if semantic did not run, run it; if
/// every branch already ran, widen the result cap instead. Deterministic
/// branches are not re-run.
async fn extra_round(
    root: &Path,
    request: &SearchRequest,
    outcome: &SearchOutcome,
    abort: &AbortController,
    permission_context: &crate::tool::ToolPermissionContext,
    retrieval: &crate::utils::settings::nyan::RetrievalSettings,
) -> Vec<Candidate> {
    let semantic_ran = outcome.branches.contains_key(&Branch::Semantic);
    if !semantic_ran {
        let (Some(semantic_settings), Ok(Some(index))) = (
            retrieval.semantic(),
            cached_index(root, retrieval.index().max_file_bytes(), permission_context).await,
        ) else {
            return Vec::new();
        };
        let budget = retrieval.budget();
        let Ok(client) = semantic::SemanticClient::from_settings(&semantic_settings, root, &budget)
        else {
            return Vec::new();
        };
        let result = client
            .search(
                &index,
                request,
                Duration::from_millis(budget.semantic_deadline_ms()),
            )
            .await;
        if !result.status.is_successful() {
            return Vec::new();
        }
        let mut verified = Vec::new();
        for candidate in result.candidates {
            if let Ok(inspection) = inspect::inspect_candidate(root, &candidate) {
                let mut candidate = inspection.candidate;
                candidate.snippet = Some(inspection.snippet);
                verified.push(candidate);
            }
        }
        return verified;
    }
    // Every branch ran: widen by re-filtering the already-verified page is not
    // possible after Inspect dropped candidates; the honest widening is a
    // fresh local pass capped at 2× results.
    let mut widened = request.clone();
    widened.max_results = (request.bounded_max_results() * 2).min(30);
    let Ok(Some(index)) =
        cached_index(root, retrieval.index().max_file_bytes(), permission_context).await
    else {
        return Vec::new();
    };
    let _ = abort;
    let mut extra = index.search_symbols(&widened, false, false, widened.max_results);
    extra.extend(
        index
            .search_text(&widened, widened.max_results)
            .unwrap_or_default(),
    );
    let mut verified = Vec::new();
    for candidate in extra {
        if let Ok(inspection) = inspect::inspect_candidate(root, &candidate) {
            let mut candidate = inspection.candidate;
            candidate.snippet = Some(inspection.snippet);
            verified.push(candidate);
        }
    }
    verified
}

#[allow(clippy::too_many_arguments)]
fn finish(
    request: SearchRequest,
    branches: BTreeMap<Branch, BranchResult>,
    candidates_by_branch: Vec<(Branch, Vec<Candidate>)>,
    started: Instant,
    rrf_k: u32,
    symbol_weight: f64,
    reranked: bool,
    decisions: Vec<DecisionRecord>,
    extra_round: bool,
) -> SearchOutcome {
    let max_results = request.bounded_max_results();
    let candidates = fusion::rrf_fuse(candidates_by_branch, rrf_k, symbol_weight, FUSION_KEEP);
    SearchOutcome {
        query: request.query,
        truncated: candidates.len() > max_results,
        candidates,
        branches,
        dropped: Vec::new(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        rrf_k,
        reranked,
        decisions,
        extra_round,
    }
}

async fn inspect_and_rerank(
    outcome: &mut SearchOutcome,
    root: &Path,
    retrieval: &crate::utils::settings::nyan::RetrievalSettings,
) {
    let mut verified = Vec::new();
    let mut dropped = std::mem::take(&mut outcome.dropped);
    for candidate in outcome.candidates.drain(..) {
        match inspect::inspect_candidate(root, &candidate) {
            Ok(inspection) => {
                let mut candidate = inspection.candidate;
                candidate.snippet = Some(inspection.snippet);
                verified.push(candidate);
            }
            Err(reason) => {
                let mut candidate = candidate;
                candidate.dropped_reason = Some(reason);
                dropped.push(candidate);
            }
        }
    }
    outcome.candidates = verified;
    outcome.dropped = dropped;

    let settings = retrieval.rerank();
    if !settings.enabled() || outcome.candidates.is_empty() {
        outcome.candidates.truncate(FINAL_RESULTS);
        return;
    }
    let Ok(client) = RerankClient::from_settings(&settings, retrieval.budget().rerank_timeout_ms())
    else {
        outcome.candidates.truncate(FINAL_RESULTS);
        return;
    };
    let top = settings.top_n() as usize;
    let documents = outcome
        .candidates
        .iter()
        .take(top)
        .map(|candidate| candidate.snippet.clone().unwrap_or_default())
        .collect::<Vec<_>>();
    let request = RerankRequest {
        kind: RerankKind::Code,
        query: outcome.query.clone(),
        documents,
    };
    let Ok(reranked) = client
        .score(
            &request,
            Duration::from_millis(retrieval.budget().rerank_timeout_ms()),
        )
        .await
    else {
        outcome.candidates.truncate(FINAL_RESULTS);
        return;
    };
    for (candidate, score) in outcome.candidates.iter_mut().zip(reranked.scores) {
        candidate.score = Some(score);
    }
    let scores = outcome
        .candidates
        .iter()
        .map(|candidate| candidate.score.unwrap_or(0.0))
        .collect::<Vec<_>>();
    let order = rerank::order_by_score(&scores, |left, right| {
        fusion::compare_candidates(&outcome.candidates[left], &outcome.candidates[right])
    });
    let old = std::mem::take(&mut outcome.candidates);
    outcome.candidates = order
        .into_iter()
        .filter_map(|index| old.get(index).cloned())
        .collect();
    outcome.reranked = true;
    outcome.candidates.truncate(FINAL_RESULTS);
}

fn failed_outcome(request: SearchRequest, reason: String, elapsed: Duration) -> SearchOutcome {
    let mut branches = BTreeMap::new();
    for branch in Branch::DETERMINISTIC {
        branches.insert(
            branch,
            BranchResult {
                status: BranchStatus::Unavailable {
                    reason: reason.clone(),
                },
                ..Default::default()
            },
        );
    }
    SearchOutcome {
        query: request.query,
        branches,
        elapsed_ms: elapsed.as_millis() as u64,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_env::{EnvVarGuard, TEST_ENV_LOCK};

    fn isolated_project(name: &str) -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("nyan-{name}-{}", uuid::Uuid::new_v4().simple()));
        let config = root.join("config");
        let project = root.join("project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        (config, project)
    }

    #[tokio::test]
    async fn local_search_returns_verified_current_source_without_semantic_configuration() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let (config, root) = isolated_project("retrieval");
        let _config = EnvVarGuard::set("NYAN_CONFIG_DIR", &config);
        std::fs::write(
            root.join("src/lib.rs"),
            "fn needle() {\n  let needle = 1;\n}\n",
        )
        .unwrap();
        let outcome = search(
            SearchRequest::new("needle"),
            &root,
            &AbortController::default(),
            &crate::tool::ToolPermissionContext::default(),
        )
        .await;
        assert!(outcome.branches.contains_key(&Branch::Exact));
        assert!(
            outcome
                .candidates
                .iter()
                .any(|candidate| candidate.path == "src/lib.rs")
        );
        assert!(
            outcome
                .candidates
                .iter()
                .all(|candidate| candidate.snippet.is_some())
        );
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn cached_index_is_shared_until_the_worktree_changes() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let (config, root) = isolated_project("cache-share");
        let _config = EnvVarGuard::set("NYAN_CONFIG_DIR", &config);
        std::fs::write(root.join("src/a.rs"), "fn alpha() {}\n").unwrap();
        std::fs::write(root.join("src/b.rs"), "fn beta() {}\n").unwrap();
        let root = root.canonicalize().unwrap();
        let context = crate::tool::ToolPermissionContext::default();
        // Persist the first build so the cache opens it synchronously.
        drop(index::LocalIndex::open(&root, 1_048_576, &context).unwrap());
        let get = || {
            cached_index_blocking(&root, 1_048_576, &context)
                .unwrap()
                .unwrap()
        };

        let first = get();
        let storage = first.storage().to_path_buf();
        // A later open must not re-read index.json: make it unreadable.
        std::fs::write(storage.join("index.json"), b"{").unwrap();
        let hits = (0..3).map(|_| get()).collect::<Vec<_>>();
        assert!(
            hits.iter().all(|hit| Arc::ptr_eq(hit, &first)),
            "an unchanged worktree is served from the same index"
        );

        std::fs::write(root.join("src/b.rs"), "fn beta_two() {}\n").unwrap();
        let refreshed = get();
        assert!(!Arc::ptr_eq(&refreshed, &first));
        assert_eq!(refreshed.files().len(), 2, "refreshed in memory");
        assert!(Arc::ptr_eq(
            first.file("src/a.rs").unwrap(),
            refreshed.file("src/a.rs").unwrap()
        ));
        assert!(Arc::ptr_eq(&get(), &refreshed));

        // Concurrent callers after a change: one refresh, one shared result.
        std::fs::write(root.join("src/a.rs"), "fn alpha_two() {}\n").unwrap();
        let concurrent = std::thread::scope(|scope| {
            let workers = (0..4).map(|_| scope.spawn(get)).collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(!Arc::ptr_eq(&concurrent[0], &refreshed));
        assert!(
            concurrent
                .iter()
                .all(|index| Arc::ptr_eq(index, &concurrent[0])),
            "concurrent searches share one refresh"
        );
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn branch_status_renders_building_instead_of_zero_matches() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let (config, root) = isolated_project("building");
        let _config = EnvVarGuard::set("NYAN_CONFIG_DIR", &config);
        std::fs::write(root.join("src/lib.rs"), "fn needle() {}\n").unwrap();
        // First open takes the writer lock; a second live opener is read-only
        // and Ready, so force a new generation to get a Rebuilding view.
        let _first = index::LocalIndex::open(
            &root,
            1_048_576,
            &crate::tool::ToolPermissionContext::default(),
        )
        .unwrap();
        let outcome = search_with_provider(
            SearchRequest::new("needle"),
            &root,
            &AbortController::default(),
            &crate::tool::ToolPermissionContext::default(),
            None,
        )
        .await;
        // While the writer is alive the exact branch still answers.
        assert!(outcome.branches.contains_key(&Branch::Exact));
        let rendered = render::render_outcome(&outcome, 10);
        assert!(rendered.contains("[searched:"));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}
