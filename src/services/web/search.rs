//! Deterministic multi-provider WebSearch aggregation.
//!
//! @nyan: all enabled search providers are queried in parallel. Provider order
//! is never a fallback signal; RRF and byte-order URL ties make the final list
//! reproducible before optional Qwen3 reranking.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use futures::future::join_all;

use crate::services::rerank::{self, RerankClient, RerankKind, RerankRequest};
use crate::services::web::budget;
use crate::services::web::providers::{self, Hit, ProviderError, SearchRequest};
use crate::utils::settings::nyan::{WebSearchSettings, WebSettings};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchFailure {
    pub provider: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub published_at: Option<String>,
    pub providers: Vec<String>,
    pub provider_count: usize,
    pub rrf_rank: usize,
    pub likely_answers: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    pub failures: Vec<SearchFailure>,
    pub providers_used: Vec<String>,
    pub all_failed: bool,
    pub reranked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchError {
    NoProviders,
    Budget(String),
    Unavailable(Vec<SearchFailure>),
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoProviders => f.write_str("unavailable: no web search providers configured"),
            Self::Budget(message) => f.write_str(message),
            Self::Unavailable(failures) => {
                let details = failures
                    .iter()
                    .map(|failure| format!("{} {}", failure.provider, failure.reason))
                    .collect::<Vec<_>>()
                    .join(", ");
                write!(f, "unavailable: {details}")
            }
        }
    }
}

impl std::error::Error for SearchError {}

pub async fn search(
    query: &str,
    allowed_domains: &[String],
    blocked_domains: &[String],
    max_results: usize,
    web: &WebSettings,
    rerank_client: Option<&RerankClient>,
) -> Result<SearchOutcome, SearchError> {
    let providers = providers::configured_search_providers(web);
    if providers.is_empty() {
        return Err(SearchError::NoProviders);
    }
    let search_settings = web.search();
    let max_results = if max_results == 0 {
        8
    } else {
        max_results.min(20)
    };
    let request = SearchRequest {
        query: query.to_string(),
        max_results: search_settings.recall_depth() as usize,
        allowed_domains: allowed_domains.to_vec(),
        blocked_domains: blocked_domains.to_vec(),
    };
    let _search_permit = budget::begin_search(
        &search_settings,
        Duration::from_millis(search_settings.deadline_ms()),
    )
    .await
    .map_err(|error| SearchError::Budget(error.to_string()))?;

    let per_provider_deadline = Duration::from_millis(search_settings.per_provider_deadline_ms());
    let total_deadline = Duration::from_millis(search_settings.deadline_ms());
    let calls = providers.iter().map(|provider| {
        let name = provider.as_search().name().to_string();
        let max_calls = web.provider(&name).max_calls_per_session;
        let request = request.clone();
        async move {
            if budget::reserve_provider(&name, max_calls).is_err() {
                return (name, Err(ProviderError::BudgetExhausted), Vec::new());
            }
            let deadline = per_provider_deadline;
            let response =
                tokio::time::timeout(deadline, provider.as_search().search(request, deadline))
                    .await
                    .map_err(|_| ProviderError::Timeout)
                    .and_then(|result| result);
            match response {
                Ok(hits) => (name, Ok(()), hits),
                Err(error) => (name, Err(error), Vec::new()),
            }
        }
    });
    let responses = tokio::time::timeout(total_deadline, join_all(calls))
        .await
        .map_err(|_| {
            SearchError::Unavailable(vec![SearchFailure {
                provider: "search".to_string(),
                reason: "timeout".to_string(),
            }])
        })?;

    let mut providers_used = Vec::new();
    let mut failures = Vec::new();
    let mut all_hits = Vec::new();
    for (name, result, hits) in responses {
        match result {
            Ok(()) => {
                providers_used.push(name.clone());
                all_hits.extend(hits.into_iter().map(|hit| (name.clone(), hit)));
            }
            Err(error) => failures.push(SearchFailure {
                provider: name,
                reason: error.code(),
            }),
        }
    }
    providers_used.sort();
    failures.sort_by(|left, right| left.provider.cmp(&right.provider));
    if providers_used.is_empty() {
        return Err(SearchError::Unavailable(failures));
    }

    let mut merged = merge_rrf(all_hits, search_settings.rrf_k() as f64);
    merged.truncate(search_settings.fusion_keep() as usize);
    merged.retain(|hit| domain_allowed(&hit.url, allowed_domains, blocked_domains));

    let mut reranked = false;
    if web.search().rerank().enabled() {
        if let Some(client) = rerank_client {
            if rerank_hits(client, query, &mut merged, &web.search()).await {
                reranked = true;
            }
        }
    }
    let hits = cap_domains(merged, search_settings.domain_cap() as usize, max_results);
    Ok(SearchOutcome {
        hits,
        failures,
        providers_used,
        all_failed: false,
        reranked,
    })
}

fn merge_rrf(items: Vec<(String, Hit)>, k: f64) -> Vec<SearchHit> {
    #[derive(Default)]
    struct Aggregate {
        title: String,
        url: String,
        snippet: String,
        published_at: Option<String>,
        providers: BTreeSet<String>,
        score: f64,
    }
    let mut by_url: BTreeMap<String, Aggregate> = BTreeMap::new();
    for (provider, hit) in items {
        let Some(url) = normalize_url(&hit.url) else {
            continue;
        };
        let entry = by_url.entry(url.clone()).or_insert_with(|| Aggregate {
            title: hit.title.clone(),
            url: url.clone(),
            ..Default::default()
        });
        entry.score += 1.0 / (k + hit.provider_rank as f64);
        entry.providers.insert(provider);
        if hit.snippet.chars().count() > entry.snippet.chars().count() {
            entry.snippet = hit.snippet;
        }
        if entry.title.is_empty() {
            entry.title = hit.title;
        }
        if entry.published_at.is_none() {
            entry.published_at = hit.published_at;
        }
    }
    let mut values = by_url.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.url.cmp(&right.url))
    });
    values
        .into_iter()
        .enumerate()
        .map(|(index, value)| SearchHit {
            title: value.title,
            url: value.url,
            snippet: value.snippet.chars().take(300).collect(),
            published_at: value.published_at,
            provider_count: value.providers.len(),
            providers: value.providers.into_iter().collect(),
            rrf_rank: index + 1,
            likely_answers: false,
        })
        .collect()
}

async fn rerank_hits(
    client: &RerankClient,
    query: &str,
    hits: &mut [SearchHit],
    settings: &WebSearchSettings,
) -> bool {
    let request = RerankRequest {
        kind: RerankKind::Web,
        query: query.to_string(),
        documents: hits
            .iter()
            .map(|hit| {
                let snippet = hit
                    .snippet
                    .chars()
                    .take(settings.rerank().snippet_chars() as usize)
                    .collect::<String>();
                format!("{}\n{}", hit.title, snippet)
            })
            .collect(),
    };
    let Ok(outcome) = client
        .score(
            &request,
            Duration::from_millis(settings.rerank().timeout_ms()),
        )
        .await
    else {
        return false;
    };
    let order = rerank::order_by_score(&outcome.scores, |left, right| {
        hits[left].url.cmp(&hits[right].url)
    });
    let reordered = order
        .into_iter()
        .map(|index| hits[index].clone())
        .collect::<Vec<_>>();
    hits.clone_from_slice(&reordered);
    true
}

fn cap_domains(mut hits: Vec<SearchHit>, cap: usize, max_results: usize) -> Vec<SearchHit> {
    let mut seen = BTreeMap::<String, usize>::new();
    hits.retain(|hit| {
        let domain = reqwest::Url::parse(&hit.url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
            .unwrap_or_default();
        let count = seen.entry(domain).or_default();
        if *count >= cap {
            false
        } else {
            *count += 1;
            true
        }
    });
    hits.truncate(max_results);
    hits
}

fn domain_allowed(url: &str, allowed: &[String], blocked: &[String]) -> bool {
    let Some(domain) = reqwest::Url::parse(url).ok().and_then(|url| {
        url.host_str()
            .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
    }) else {
        return false;
    };
    if blocked.iter().any(|entry| host_matches(entry, &domain)) {
        return false;
    }
    allowed.is_empty() || allowed.iter().any(|entry| host_matches(entry, &domain))
}

fn host_matches(entry: &str, domain: &str) -> bool {
    let entry = entry.trim().trim_start_matches('.').to_ascii_lowercase();
    domain == entry || domain.ends_with(&format!(".{entry}"))
}

pub fn normalize_url(raw: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    url.set_fragment(None);
    if url.path().is_empty() {
        url.set_path("/");
    }
    Some(url.to_string())
}

pub fn render_outcome(outcome: &SearchOutcome) -> String {
    if outcome.hits.is_empty() {
        if outcome.failures.is_empty() {
            return "No results found".to_string();
        }
        return format!(
            "No results found from: {}",
            outcome
                .failures
                .iter()
                .map(|failure| format!("{} ({})", failure.provider, failure.reason))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let mut output = String::new();
    for (index, hit) in outcome.hits.iter().enumerate() {
        output.push_str(&format!("{}. {}\n", index + 1, hit.title));
        output.push_str(&format!(
            "   {} ({} sources: {}{})\n",
            hit.url,
            hit.provider_count,
            hit.providers.join(", "),
            hit.published_at
                .as_deref()
                .map(|date| format!(" · published {date}"))
                .unwrap_or_default()
        ));
        if !hit.snippet.is_empty() {
            output.push_str(&format!("   {}\n", hit.snippet));
        }
        output.push('\n');
    }
    if !outcome.providers_used.is_empty() || !outcome.failures.is_empty() {
        output.push_str("[searched: ");
        output.push_str(&outcome.providers_used.join(", "));
        if !outcome.failures.is_empty() {
            output.push_str(" — ");
            output.push_str(
                &outcome
                    .failures
                    .iter()
                    .map(|failure| format!("{} {}", failure.provider, failure.reason))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }
        output.push_str("]\n");
    }
    output.push_str("[Search results are leads, not sources. WebFetch a page before citing it.]");
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_normalization_removes_fragments_and_adds_root() {
        assert_eq!(
            normalize_url("HTTPS://Example.com#part").as_deref(),
            Some("https://example.com/")
        );
        assert!(normalize_url("file:///tmp/a").is_none());
    }

    #[test]
    fn rrf_merges_sources_and_uses_url_tie_break() {
        let hits = merge_rrf(
            vec![
                (
                    "brave".to_string(),
                    Hit {
                        title: "B".to_string(),
                        url: "https://example.com/b".to_string(),
                        snippet: "b".to_string(),
                        published_at: None,
                        provider_rank: 1,
                    },
                ),
                (
                    "exa".to_string(),
                    Hit {
                        title: "A".to_string(),
                        url: "https://example.com/a".to_string(),
                        snippet: "a".to_string(),
                        published_at: None,
                        provider_rank: 1,
                    },
                ),
                (
                    "deepseek".to_string(),
                    Hit {
                        title: "B".to_string(),
                        url: "https://example.com/b#frag".to_string(),
                        snippet: "longer".to_string(),
                        published_at: None,
                        provider_rank: 2,
                    },
                ),
            ],
            60.0,
        );
        assert_eq!(hits[0].url, "https://example.com/b");
        assert_eq!(hits[0].provider_count, 2);
        assert_eq!(hits[0].snippet, "longer");
    }

    #[test]
    fn domain_cap_is_deterministic() {
        let hits = (0..4)
            .map(|index| SearchHit {
                title: index.to_string(),
                url: format!("https://same.example/{index}"),
                snippet: String::new(),
                published_at: None,
                providers: vec!["x".to_string()],
                provider_count: 1,
                rrf_rank: index,
                likely_answers: false,
            })
            .collect();
        assert_eq!(cap_domains(hits, 2, 8).len(), 2);
    }
}
