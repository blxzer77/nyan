//! Deterministic-first local code retrieval and optional semantic enhancement.
//!
//! @nyan: this module is a library first. `CodeSearch` is only one adapter; the
//! memory module and future evaluation harnesses consume the same structured
//! `SearchOutcome` without parsing model-facing text.

pub mod exact;
pub mod fusion;
pub mod index;
pub mod inspect;
pub mod memory;
pub mod outcome;
pub mod render;
pub mod semantic;

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::services::rerank::{self, RerankClient, RerankKind, RerankRequest};
use crate::tool::AbortController;

pub use outcome::{Branch, BranchResult, BranchStatus, Candidate, SearchOutcome, SearchRequest};

const MAX_BRANCH_CANDIDATES: usize = 50;
const FUSION_KEEP: usize = 50;

/// Run the complete retrieval plan for a worktree. Exact, symbol and text are
/// local deterministic branches; semantic is opt-in by settings presence.
pub async fn search(
    request: SearchRequest,
    cwd: &Path,
    abort: &AbortController,
    permission_context: &crate::tool::ToolPermissionContext,
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
        return finish(
            request,
            branches,
            candidates_by_branch,
            started,
            budget.rrf_k(),
            false,
        );
    }

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
    let index = match index::LocalIndex::open(
        &root,
        retrieval.index().max_file_bytes(),
        permission_context,
    ) {
        Ok(index) => Some(index),
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
        } else {
            let symbol_started = Instant::now();
            let mut symbols = index.search_symbols(
                &request.query,
                fusion::asks_for_relations(&request.query),
                MAX_BRANCH_CANDIDATES,
            );
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
            let mut text = index.search_text(&request.query, MAX_BRANCH_CANDIDATES);
            let text_elapsed_ms = text_started.elapsed().as_millis() as u64;
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
    }

    if let (Some(semantic_settings), Some(index)) = (retrieval.semantic(), index.as_ref()) {
        let _ = semantic::SemanticClient::ensure_initial_pending(index);
        match semantic::SemanticClient::from_settings(&semantic_settings, &root, &budget) {
            Ok(client) => {
                let semantic_started = Instant::now();
                let mut result = client
                    .search(
                        &root,
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
        request,
        branches,
        candidates_by_branch,
        started,
        budget.rrf_k(),
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
    outcome.elapsed_ms = started.elapsed().as_millis() as u64;
    outcome
}

fn finish(
    request: SearchRequest,
    branches: BTreeMap<Branch, BranchResult>,
    candidates_by_branch: Vec<(Branch, Vec<Candidate>)>,
    started: Instant,
    rrf_k: u32,
    reranked: bool,
) -> SearchOutcome {
    let max_results = request.bounded_max_results();
    let candidates = fusion::rrf_fuse(
        candidates_by_branch,
        rrf_k,
        fusion::symbol_weight(&request.query),
        FUSION_KEEP,
    );
    SearchOutcome {
        query: request.query,
        truncated: candidates.len() > max_results,
        candidates,
        branches,
        dropped: Vec::new(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        rrf_k,
        reranked,
    }
}

async fn inspect_and_rerank(
    outcome: &mut SearchOutcome,
    root: &Path,
    retrieval: &crate::utils::settings::nyan::RetrievalSettings,
) {
    let mut verified = Vec::new();
    for candidate in outcome.candidates.drain(..) {
        match inspect::inspect_candidate(root, &candidate) {
            Ok(inspection) => {
                let mut candidate = inspection.candidate;
                candidate.snippet = Some(inspection.snippet);
                verified.push(candidate);
            }
            Err(reason) => {
                let mut dropped = candidate;
                dropped.dropped_reason = Some(reason);
                outcome.dropped.push(dropped);
            }
        }
    }
    outcome.candidates = verified;

    let settings = retrieval.rerank();
    if !settings.enabled() || outcome.candidates.is_empty() {
        outcome.candidates.truncate(30);
        return;
    }
    let Ok(client) = RerankClient::from_settings(&settings, retrieval.budget().rerank_timeout_ms())
    else {
        outcome.candidates.truncate(30);
        return;
    };
    let documents = outcome
        .candidates
        .iter()
        .take(settings.top_n() as usize)
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
        outcome.candidates.truncate(30);
        return;
    };
    for (candidate, score) in outcome.candidates.iter_mut().zip(reranked.scores) {
        candidate.score = Some(score);
    }
    let order = rerank::order_by_score(
        &outcome
            .candidates
            .iter()
            .map(|candidate| candidate.score.unwrap_or(0.0))
            .collect::<Vec<_>>(),
        |left, right| {
            fusion::compare_candidates(&outcome.candidates[left], &outcome.candidates[right])
        },
    );
    let old = std::mem::take(&mut outcome.candidates);
    outcome.candidates = order
        .into_iter()
        .filter_map(|index| old.get(index).cloned())
        .collect();
    outcome.reranked = true;
    outcome.candidates.truncate(30);
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

    #[tokio::test]
    async fn local_search_returns_verified_current_source_without_semantic_configuration() {
        let root =
            std::env::temp_dir().join(format!("nyan-retrieval-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join("src")).unwrap();
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
        let _ = std::fs::remove_dir_all(root);
    }
}
