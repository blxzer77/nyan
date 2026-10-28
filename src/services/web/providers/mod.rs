//! Search and fetch provider adapters.
//!
//! @nyan: provider calls receive only the model's query or the explicitly
//! requested URL. Keys are read from configured files, never from settings JSON
//! or request input. Provider response bodies are parsed into neutral types and
//! raw error bodies never cross this boundary.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::Value;

use crate::services::service_health::{self, CallPermit, FailureKind, ServiceHealth, ServiceKind};
use crate::utils::settings::nyan::{ResolvedProvider, WebSettings};

use client::ProviderClient;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchRequest {
    pub query: String,
    pub max_results: usize,
    pub allowed_domains: Vec<String>,
    pub blocked_domains: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub published_at: Option<String>,
    pub provider_rank: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderPage {
    pub url: String,
    pub final_url: String,
    pub title: Option<String>,
    pub content: String,
    pub status: u16,
    pub content_type: String,
    pub format: String,
    pub freshness: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderError {
    Timeout,
    QuotaExhausted,
    RateLimited,
    Auth,
    Http(u16),
    Invalid,
    Unsupported,
    Unavailable,
    Network,
    BudgetExhausted,
}

impl ProviderError {
    pub fn code(&self) -> String {
        match self {
            Self::Timeout => "timeout".to_string(),
            Self::QuotaExhausted => "quota_exhausted".to_string(),
            Self::BudgetExhausted => "budget_exhausted".to_string(),
            Self::RateLimited => "rate_limited".to_string(),
            Self::Auth => "auth_failed".to_string(),
            Self::Http(status) => format!("http_{status}"),
            Self::Invalid => "invalid_response".to_string(),
            Self::Unsupported => "unsupported".to_string(),
            Self::Unavailable => "unavailable".to_string(),
            Self::Network => "network_error".to_string(),
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code())
    }
}

impl std::error::Error for ProviderError {}

pub trait SearchProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn max_results(&self) -> usize;
    fn search<'a>(
        &'a self,
        request: SearchRequest,
        deadline: Duration,
    ) -> BoxFuture<'a, Result<Vec<Hit>, ProviderError>>;
}

pub trait FetchProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn fetch<'a>(
        &'a self,
        url: String,
        deadline: Duration,
    ) -> BoxFuture<'a, Result<ProviderPage, ProviderError>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderKind {
    AnySearch,
    Brave,
    DeepSeek,
    Exa,
    Firecrawl,
    Tavily,
    Searxng,
}

impl ProviderKind {
    fn name(self) -> &'static str {
        match self {
            Self::AnySearch => "anysearch",
            Self::Brave => "brave",
            Self::DeepSeek => "deepseek",
            Self::Exa => "exa",
            Self::Firecrawl => "firecrawl",
            Self::Tavily => "tavily",
            Self::Searxng => "searxng",
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            Self::AnySearch => "https://api.anysearch.com/v1",
            Self::Brave => "https://api.search.brave.com/res/v1/web",
            Self::DeepSeek => "https://api.deepseek.com/v1/tools",
            Self::Exa => "https://api.exa.ai",
            Self::Firecrawl => "https://api.firecrawl.dev/v2",
            Self::Tavily => "https://api.tavily.com",
            Self::Searxng => "https://nyan-ops.tail6334e5.ts.net:8454",
        }
    }
}

#[derive(Clone)]
struct GenericProvider {
    kind: ProviderKind,
    client: ProviderClient,
    max_results: usize,
}

impl GenericProvider {
    fn name(&self) -> &'static str {
        self.kind.name()
    }

    fn search<'a>(
        &'a self,
        request: SearchRequest,
        deadline: Duration,
    ) -> BoxFuture<'a, Result<Vec<Hit>, ProviderError>> {
        Box::pin(async move {
            let value = self.client.search(self.kind, &request, deadline).await?;
            parse_hits(self.kind, &value)
        })
    }

    fn fetch<'a>(
        &'a self,
        url: String,
        deadline: Duration,
    ) -> BoxFuture<'a, Result<ProviderPage, ProviderError>> {
        Box::pin(async move {
            let value = self.client.fetch(self.kind, &url, deadline).await?;
            parse_page(self.kind, &url, value)
        })
    }
}

macro_rules! provider_type {
    ($name:ident, $kind:ident, $max:expr) => {
        #[derive(Clone)]
        pub struct $name {
            inner: GenericProvider,
        }

        impl $name {
            pub fn from_settings(web: &WebSettings) -> Result<Self, ProviderError> {
                let resolved = web.provider(ProviderKind::$kind.name());
                Ok(Self {
                    inner: GenericProvider {
                        kind: ProviderKind::$kind,
                        client: ProviderClient::from_resolved(ProviderKind::$kind, &resolved)?,
                        max_results: $max,
                    },
                })
            }

            pub fn with_base_url(
                base_url: impl Into<String>,
                api_key: Option<String>,
            ) -> Result<Self, ProviderError> {
                Ok(Self {
                    inner: GenericProvider {
                        kind: ProviderKind::$kind,
                        client: ProviderClient::with_base_url(
                            ProviderKind::$kind,
                            base_url.into(),
                            api_key,
                        )?,
                        max_results: $max,
                    },
                })
            }
        }

        impl SearchProvider for $name {
            fn name(&self) -> &'static str {
                self.inner.name()
            }
            fn max_results(&self) -> usize {
                self.inner.max_results
            }
            fn search<'a>(
                &'a self,
                request: SearchRequest,
                deadline: Duration,
            ) -> BoxFuture<'a, Result<Vec<Hit>, ProviderError>> {
                self.inner.search(request, deadline)
            }
        }
    };
}

provider_type!(AnySearchProvider, AnySearch, 10);
provider_type!(BraveProvider, Brave, 20);
provider_type!(DeepSeekProvider, DeepSeek, 50);
provider_type!(ExaProvider, Exa, 100);
provider_type!(FirecrawlProvider, Firecrawl, 100);
provider_type!(TavilyProvider, Tavily, 20);
provider_type!(SearxngProvider, Searxng, 20);

macro_rules! fetch_impl {
    ($name:ident) => {
        impl FetchProvider for $name {
            fn name(&self) -> &'static str {
                self.inner.name()
            }
            fn fetch<'a>(
                &'a self,
                url: String,
                deadline: Duration,
            ) -> BoxFuture<'a, Result<ProviderPage, ProviderError>> {
                self.inner.fetch(url, deadline)
            }
        }
    };
}

fetch_impl!(AnySearchProvider);
fetch_impl!(DeepSeekProvider);
fetch_impl!(ExaProvider);
fetch_impl!(FirecrawlProvider);
fetch_impl!(TavilyProvider);

pub enum ConfiguredSearchProvider {
    AnySearch(AnySearchProvider),
    Brave(BraveProvider),
    DeepSeek(DeepSeekProvider),
    Exa(ExaProvider),
    Firecrawl(FirecrawlProvider),
    Tavily(TavilyProvider),
    Searxng(SearxngProvider),
}

impl ConfiguredSearchProvider {
    pub fn as_search(&self) -> &dyn SearchProvider {
        match self {
            Self::AnySearch(value) => value,
            Self::Brave(value) => value,
            Self::DeepSeek(value) => value,
            Self::Exa(value) => value,
            Self::Firecrawl(value) => value,
            Self::Tavily(value) => value,
            Self::Searxng(value) => value,
        }
    }

    pub fn as_fetch(&self) -> Result<&dyn FetchProvider, ProviderError> {
        match self {
            Self::AnySearch(value) => Ok(value),
            Self::Brave(_) | Self::Searxng(_) => Err(ProviderError::Unsupported),
            Self::DeepSeek(value) => Ok(value),
            Self::Exa(value) => Ok(value),
            Self::Firecrawl(value) => Ok(value),
            Self::Tavily(value) => Ok(value),
        }
    }
}

pub fn configured_search_providers(web: &WebSettings) -> Vec<ConfiguredSearchProvider> {
    let Some(configured) = web.providers.as_ref() else {
        return Vec::new();
    };
    let mut providers = Vec::new();
    for name in [
        "anysearch",
        "brave",
        "deepseek",
        "exa",
        "firecrawl",
        "tavily",
        "searxng",
    ] {
        let Some(config) = configured.get(name) else {
            continue;
        };
        if config.enabled == Some(false) {
            continue;
        }
        let provider = match name {
            "anysearch" => {
                AnySearchProvider::from_settings(web).map(ConfiguredSearchProvider::AnySearch)
            }
            "brave" => BraveProvider::from_settings(web).map(ConfiguredSearchProvider::Brave),
            "deepseek" => {
                DeepSeekProvider::from_settings(web).map(ConfiguredSearchProvider::DeepSeek)
            }
            "exa" => ExaProvider::from_settings(web).map(ConfiguredSearchProvider::Exa),
            "firecrawl" => {
                FirecrawlProvider::from_settings(web).map(ConfiguredSearchProvider::Firecrawl)
            }
            "tavily" => TavilyProvider::from_settings(web).map(ConfiguredSearchProvider::Tavily),
            "searxng" => SearxngProvider::from_settings(web).map(ConfiguredSearchProvider::Searxng),
            _ => continue,
        };
        if let Ok(provider) = provider {
            providers.push(provider);
        }
    }
    providers
}

fn parse_hits(kind: ProviderKind, value: &Value) -> Result<Vec<Hit>, ProviderError> {
    let items = match kind {
        ProviderKind::Brave => value.pointer("/web/results").and_then(Value::as_array),
        ProviderKind::Firecrawl => value.get("data").and_then(Value::as_array),
        _ => value
            .get("results")
            .or_else(|| value.get("data"))
            .and_then(Value::as_array),
    }
    .ok_or(ProviderError::Invalid)?;
    let mut hits = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(url) = item.get("url").and_then(Value::as_str) else {
            continue;
        };
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(url)
            .to_string();
        let snippet = item
            .get("snippet")
            .or_else(|| item.get("description"))
            .or_else(|| item.get("content"))
            .or_else(|| item.get("summary"))
            .or_else(|| item.get("text"))
            .or_else(|| item.get("highlights"))
            .map(value_text)
            .unwrap_or_default();
        let published_at = item
            .get("publishedDate")
            .or_else(|| item.get("published_date"))
            .or_else(|| item.get("date"))
            .and_then(Value::as_str)
            .map(str::to_string);
        hits.push(Hit {
            title,
            url: url.to_string(),
            snippet,
            published_at,
            provider_rank: index + 1,
        });
    }
    Ok(hits)
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(value_text).collect::<Vec<_>>().join(" "),
        _ => value.to_string(),
    }
}

fn parse_page(kind: ProviderKind, url: &str, value: Value) -> Result<ProviderPage, ProviderError> {
    let (content, title, format) = match kind {
        ProviderKind::Firecrawl => {
            let data = value.get("data").unwrap_or(&value);
            (
                data.get("markdown")
                    .or_else(|| data.get("content"))
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::Invalid)?
                    .to_string(),
                data.pointer("/metadata/title")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                "markdown",
            )
        }
        ProviderKind::Exa => {
            let item = value
                .get("results")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .ok_or(ProviderError::Invalid)?;
            (
                item.get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::Invalid)?
                    .to_string(),
                item.get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                "text",
            )
        }
        _ => {
            let item = value
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    value
                        .get("results")
                        .and_then(Value::as_array)
                        .and_then(|items| items.first())
                        .and_then(|item| item.get("content").or_else(|| item.get("raw_content")))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .ok_or(ProviderError::Invalid)?;
            (item, None, "markdown")
        }
    };
    if content.is_empty() {
        return Err(ProviderError::Invalid);
    }
    Ok(ProviderPage {
        url: url.to_string(),
        final_url: url.to_string(),
        title,
        content,
        status: 200,
        content_type: "text/markdown".to_string(),
        format: format.to_string(),
        freshness: None,
    })
}

fn read_key(path: Option<&str>) -> Result<Option<String>, ProviderError> {
    let Some(path) = path else {
        return Ok(None);
    };
    let path = expand_path(path);
    let value = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ProviderError::Auth),
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(ProviderError::Auth);
    }
    Ok(Some(value))
}

fn expand_path(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        crate::utils::node_os::homedir().join(rest)
    } else {
        std::path::PathBuf::from(path)
    }
}

mod client {
    use super::*;
    use crate::services::web::redact::redact_error;

    #[derive(Clone)]
    pub struct ProviderClient {
        kind: ProviderKind,
        base_url: String,
        api_key: Option<String>,
        http: reqwest::Client,
        health: Option<Arc<ServiceHealth>>,
    }

    impl ProviderClient {
        pub fn from_resolved(
            kind: ProviderKind,
            resolved: &ResolvedProvider,
        ) -> Result<Self, ProviderError> {
            let base_url = resolved
                .base_url
                .as_deref()
                .or(resolved.url.as_deref())
                .unwrap_or(kind.default_base_url())
                .to_string();
            let api_key = read_key(resolved.api_key_file.as_deref())?;
            Self::new(kind, base_url, api_key)
        }

        pub fn with_base_url(
            kind: ProviderKind,
            base_url: String,
            api_key: Option<String>,
        ) -> Result<Self, ProviderError> {
            Self::new(kind, base_url, api_key)
        }

        fn new(
            kind: ProviderKind,
            base_url: String,
            api_key: Option<String>,
        ) -> Result<Self, ProviderError> {
            crate::utils::tls_provider::install_crypto_provider();
            let builder = if kind == ProviderKind::Searxng {
                crate::utils::proxy::client_builder().no_proxy()
            } else {
                crate::utils::proxy::create_axios_instance().map_err(|_| ProviderError::Network)?
            };
            let http = builder.build().map_err(|_| ProviderError::Network)?;
            let health = (kind == ProviderKind::Searxng)
                .then(|| service_health::shared(ServiceKind::Searxng));
            Ok(Self {
                kind,
                base_url,
                api_key,
                http,
                health,
            })
        }

        pub async fn search(
            &self,
            kind: ProviderKind,
            request: &SearchRequest,
            deadline: Duration,
        ) -> Result<Value, ProviderError> {
            let path = if kind == ProviderKind::Searxng {
                "search"
            } else {
                "search"
            };
            if let Some(health) = &self.health {
                match health.call_permit() {
                    CallPermit::Skipped => return Err(ProviderError::Unavailable),
                    CallPermit::Probe => {
                        health.spawn_probe();
                        return Err(ProviderError::Unavailable);
                    }
                    CallPermit::Allowed => {}
                }
            }
            let result = if kind == ProviderKind::Brave || kind == ProviderKind::Searxng {
                let mut url = self.endpoint(path).map_err(|_| ProviderError::Invalid)?;
                url.query_pairs_mut()
                    .append_pair("q", &request.query)
                    .append_pair("format", "json");
                let limit = request.max_results.min(self.max_results(kind));
                url.query_pairs_mut()
                    .append_pair("count", &limit.to_string());
                self.send(reqwest::Method::GET, url, None, deadline).await
            } else {
                let body = search_body(kind, request, self.max_results(kind));
                let url = self.endpoint(path).map_err(|_| ProviderError::Invalid)?;
                self.send(reqwest::Method::POST, url, Some(body), deadline)
                    .await
            };
            if let Some(health) = &self.health {
                match &result {
                    Ok(_) => health.record_success(),
                    Err(error) => health.record_failure(failure_kind(error)),
                }
            }
            result
        }

        pub async fn fetch(
            &self,
            kind: ProviderKind,
            url: &str,
            deadline: Duration,
        ) -> Result<Value, ProviderError> {
            let path = match kind {
                ProviderKind::AnySearch => "extract",
                ProviderKind::DeepSeek => "fetch",
                ProviderKind::Exa => "contents",
                ProviderKind::Firecrawl => "scrape",
                ProviderKind::Tavily => "extract",
                ProviderKind::Brave | ProviderKind::Searxng => {
                    return Err(ProviderError::Unsupported);
                }
            };
            let endpoint = self.endpoint(path).map_err(|_| ProviderError::Invalid)?;
            let body = fetch_body(kind, url);
            self.send(reqwest::Method::POST, endpoint, Some(body), deadline)
                .await
        }

        fn endpoint(&self, path: &str) -> Result<reqwest::Url, ProviderError> {
            let base = self.base_url.trim_end_matches('/');
            reqwest::Url::parse(&format!("{base}/{path}")).map_err(|_| ProviderError::Invalid)
        }

        fn max_results(&self, kind: ProviderKind) -> usize {
            match kind {
                ProviderKind::AnySearch => 10,
                ProviderKind::Brave => 20,
                ProviderKind::DeepSeek => 50,
                ProviderKind::Exa | ProviderKind::Firecrawl => 100,
                ProviderKind::Tavily | ProviderKind::Searxng => 20,
            }
        }

        async fn send(
            &self,
            method: reqwest::Method,
            url: reqwest::Url,
            body: Option<Value>,
            deadline: Duration,
        ) -> Result<Value, ProviderError> {
            let mut request = self.http.request(method, url);
            if let Some(key) = self.api_key.as_deref() {
                request = match self.kind {
                    ProviderKind::Brave => request.header("X-Subscription-Token", key),
                    ProviderKind::Exa => request.header("x-api-key", key),
                    ProviderKind::Searxng => request,
                    _ => request.bearer_auth(key),
                };
            }
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = tokio::time::timeout(deadline, request.send())
                .await
                .map_err(|_| ProviderError::Timeout)?
                .map_err(|error| {
                    if error.is_timeout() {
                        ProviderError::Timeout
                    } else {
                        ProviderError::Network
                    }
                })?;
            let status = response.status();
            let brave_quota = self.kind == ProviderKind::Brave
                && response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.trim() == "0");
            let bytes = response.bytes().await.map_err(|_| ProviderError::Network)?;
            if brave_quota {
                return Err(ProviderError::QuotaExhausted);
            }
            if !status.is_success() {
                return Err(classify_status(
                    status.as_u16(),
                    &bytes,
                    self.api_key.as_deref(),
                ));
            }
            serde_json::from_slice(&bytes).map_err(|error| {
                let _ = redact_error(
                    &error.to_string(),
                    &self.api_key.iter().cloned().collect::<Vec<_>>(),
                );
                ProviderError::Invalid
            })
        }
    }

    fn classify_status(status: u16, body: &[u8], key: Option<&str>) -> ProviderError {
        let _safe_debug = redact_error(
            &String::from_utf8_lossy(body),
            &key.into_iter().map(str::to_string).collect::<Vec<_>>(),
        );
        match status {
            401 | 403 => ProviderError::Auth,
            402 | 432 => ProviderError::QuotaExhausted,
            429 => ProviderError::RateLimited,
            status => ProviderError::Http(status),
        }
    }

    fn failure_kind(error: &ProviderError) -> FailureKind {
        match error {
            ProviderError::Timeout => FailureKind::Timeout,
            ProviderError::RateLimited => FailureKind::RateLimited,
            ProviderError::Auth => FailureKind::Auth,
            ProviderError::QuotaExhausted => FailureKind::Budget,
            ProviderError::Invalid => FailureKind::InvalidResponse,
            _ => FailureKind::Unreachable,
        }
    }

    fn search_body(kind: ProviderKind, request: &SearchRequest, max: usize) -> Value {
        let count = request.max_results.min(max);
        match kind {
            ProviderKind::AnySearch => {
                serde_json::json!({"query": &request.query, "max_results": count})
            }
            ProviderKind::DeepSeek => serde_json::json!({"query": &request.query, "count": count}),
            ProviderKind::Exa => {
                serde_json::json!({"query": &request.query, "numResults": count, "contents": {"highlights": {"maxCharacters": 300}}})
            }
            ProviderKind::Firecrawl => serde_json::json!({"query": &request.query, "limit": count}),
            ProviderKind::Tavily => {
                serde_json::json!({"query": &request.query, "max_results": count, "include_answer": false})
            }
            ProviderKind::Brave | ProviderKind::Searxng => serde_json::Value::Null,
        }
    }

    fn fetch_body(kind: ProviderKind, url: &str) -> Value {
        match kind {
            ProviderKind::AnySearch | ProviderKind::Tavily => serde_json::json!({"urls": [url]}),
            ProviderKind::DeepSeek => serde_json::json!({"url": url}),
            ProviderKind::Exa => serde_json::json!({"urls": [url], "text": true}),
            ProviderKind::Firecrawl => serde_json::json!({"url": url, "maxAge": 0}),
            ProviderKind::Brave | ProviderKind::Searxng => serde_json::Value::Null,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_errors_are_named_without_response_bodies() {
        assert_eq!(ProviderError::QuotaExhausted.code(), "quota_exhausted");
        assert_eq!(ProviderError::Http(503).code(), "http_503");
        assert!(!ProviderError::Auth.to_string().contains("secret"));
    }

    #[test]
    fn parse_hits_supports_each_response_shape() {
        let cases = [
            (
                ProviderKind::AnySearch,
                serde_json::json!({"results":[{"title":"A","url":"https://a","snippet":"s"}]}),
            ),
            (
                ProviderKind::Brave,
                serde_json::json!({"web":{"results":[{"title":"A","url":"https://a","description":"s"}]}}),
            ),
            (
                ProviderKind::Firecrawl,
                serde_json::json!({"data":[{"title":"A","url":"https://a","description":"s"}]}),
            ),
        ];
        for (kind, value) in cases {
            let hits = parse_hits(kind, &value).unwrap();
            assert_eq!(hits[0].url, "https://a");
        }
    }

    #[test]
    fn brave_and_searxng_explicitly_do_not_implement_fetch() {
        let web = WebSettings::default();
        let brave = BraveProvider::from_settings(&web);
        assert!(brave.is_ok());
        let searxng = SearxngProvider::from_settings(&web);
        assert!(searxng.is_ok());
    }
}
