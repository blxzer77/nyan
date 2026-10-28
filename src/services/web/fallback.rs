//! Ordered FetchProvider fallback after nyan's own fetcher.

use std::time::{Duration, Instant};

use chrono::Utc;

use super::budget;
use super::fetcher::{FetchError, fetch_url};
use super::providers::{self, ProviderError, ProviderPage};
use super::snapshot::{self, Snapshot};
use crate::tool::AbortController;
use crate::utils::settings::nyan::WebSettings;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchChainFailure {
    pub nyan: String,
    pub attempts: Vec<(String, String)>,
}

impl std::fmt::Display for FetchChainFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut parts = vec![format!("nyan {}", self.nyan)];
        parts.extend(
            self.attempts
                .iter()
                .map(|(provider, error)| format!("{provider} {error}")),
        );
        write!(f, "fetch_failed: {}", parts.join(", "))
    }
}

impl std::error::Error for FetchChainFailure {}

pub struct FetchChainResult {
    pub snapshot: Snapshot,
    pub direct_reason: Option<String>,
}

pub async fn fetch_with_fallback(
    raw_url: &str,
    abort_controller: &AbortController,
    web: &WebSettings,
) -> Result<FetchChainResult, FetchChainFailure> {
    let config = super::fetcher::FetchConfig::from_settings(web);
    let nyan_result = fetch_url(raw_url, abort_controller, &config).await;
    match nyan_result {
        Ok(page) if page.text.chars().count() >= 200 => {
            let snapshot = snapshot::save_nyan(&page).map_err(|error| FetchChainFailure {
                nyan: format!("snapshot_error: {error}"),
                attempts: Vec::new(),
            })?;
            return Ok(FetchChainResult {
                snapshot,
                direct_reason: None,
            });
        }
        Ok(_) => {
            return fallback(raw_url, "content_too_short", abort_controller, web).await;
        }
        Err(error) if should_fallback(&error) => {
            return fallback(raw_url, &error.to_string(), abort_controller, web).await;
        }
        Err(error) => {
            return Err(FetchChainFailure {
                nyan: error.to_string(),
                attempts: Vec::new(),
            });
        }
    }
}

async fn fallback(
    raw_url: &str,
    direct_reason: &str,
    abort_controller: &AbortController,
    web: &WebSettings,
) -> Result<FetchChainResult, FetchChainFailure> {
    let started = Instant::now();
    let deadline = Duration::from_millis(web.fetch().fallback_deadline_ms());
    let providers = providers::configured_search_providers(web);
    let mut attempts = Vec::new();
    for name in web.fallback_order() {
        if abort_controller.is_aborted() {
            attempts.push((name, "cancelled".to_string()));
            break;
        }
        if started.elapsed() >= deadline {
            attempts.push((name, "timeout".to_string()));
            break;
        }
        let Some(provider) = providers
            .iter()
            .find(|provider| provider.as_search().name() == name)
        else {
            continue;
        };
        let max_calls = web.provider(&name).max_calls_per_session;
        if let Err(error) = budget::reserve_provider(&name, max_calls) {
            attempts.push((name, error.to_string()));
            continue;
        }
        let remaining = deadline.saturating_sub(started.elapsed());
        let fetched = match provider.as_fetch() {
            Ok(fetch_provider) => tokio::time::timeout(
                remaining,
                fetch_provider.fetch(raw_url.to_string(), remaining),
            )
            .await
            .map_err(|_| ProviderError::Timeout)
            .and_then(|result| result),
            Err(error) => Err(error),
        };
        match fetched {
            Ok(page) if !page.content.is_empty() => {
                let snapshot =
                    save_provider_page(page, name.clone()).map_err(|error| FetchChainFailure {
                        nyan: direct_reason.to_string(),
                        attempts: vec![(name.clone(), format!("snapshot_error: {error}"))],
                    })?;
                return Ok(FetchChainResult {
                    snapshot,
                    direct_reason: Some(direct_reason.to_string()),
                });
            }
            Ok(_) => attempts.push((name, "invalid_response".to_string())),
            Err(error) => attempts.push((name, error.code())),
        }
    }
    Err(FetchChainFailure {
        nyan: direct_reason.to_string(),
        attempts,
    })
}

fn save_provider_page(page: ProviderPage, provider: String) -> Result<Snapshot, std::io::Error> {
    snapshot::save_provider(snapshot::ProviderSnapshotInput {
        url: page.url.clone(),
        final_url: page.final_url,
        status: page.status,
        content_type: page.content_type,
        fetched_at: Utc::now(),
        fetched_by: provider,
        text: page.content,
        provider_format: page.format,
        freshness: page.freshness,
    })
}

fn should_fallback(error: &FetchError) -> bool {
    matches!(
        error,
        FetchError::HttpStatus(403 | 429 | 451) | FetchError::Timeout
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_named_fetch_failures_trigger_provider_fallback() {
        assert!(should_fallback(&FetchError::HttpStatus(403)));
        assert!(should_fallback(&FetchError::HttpStatus(429)));
        assert!(should_fallback(&FetchError::HttpStatus(451)));
        assert!(should_fallback(&FetchError::Timeout));
        assert!(!should_fallback(&FetchError::DeniedPrivateNetwork));
        assert!(!should_fallback(&FetchError::ProxyUnconfigured));
    }
}
