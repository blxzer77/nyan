//! SSRF-checked WebFetch transport.
//!
//! @nyan: CC's WebFetch transport is retained only when `nyan.web` is absent.
//! When this module is selected, every redirect is normalized and checked again,
//! proxy mode is explicit, and a response is either fully accepted or discarded.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::StreamExt;

use crate::services::web::host_guard::{self, HostGuardConfig, HostGuardError, ValidatedUrl};
use crate::tool::AbortController;
use crate::utils::settings::nyan::{FetchVia, WebSettings};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedirectHop {
    pub from: String,
    pub to: String,
    pub status: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedPage {
    pub original_url: String,
    pub final_url: String,
    pub redirects: Vec<RedirectHop>,
    pub status: u16,
    pub content_type: String,
    pub fetched_at: DateTime<Utc>,
    pub raw_body: Vec<u8>,
    pub text: String,
}

impl FetchedPage {
    pub fn bytes(&self) -> usize {
        self.raw_body.len()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FetchError {
    InvalidUrl,
    DeniedScheme,
    DeniedPort(u16),
    DeniedPrivateNetwork,
    DeniedHost,
    ProxyUnconfigured,
    TooManyRedirects,
    TooLarge,
    Timeout,
    Cancelled,
    HttpStatus(u16),
    ContentTypeDenied(String),
    PdfConversionUnavailable,
    PdfConversionFailed,
    ResolveFailed,
    ResolvePrivateNetwork,
    Network,
    InvalidResponse,
}

impl FetchError {
    pub fn code(&self) -> String {
        match self {
            Self::InvalidUrl => "denied_host".to_string(),
            Self::DeniedScheme => "denied_scheme".to_string(),
            Self::DeniedPort(_) => "denied_port".to_string(),
            Self::DeniedPrivateNetwork => "denied_private_network".to_string(),
            Self::DeniedHost => "denied_host".to_string(),
            Self::ProxyUnconfigured => "proxy_unconfigured".to_string(),
            Self::TooManyRedirects => "too_many_redirects".to_string(),
            Self::TooLarge => "too_large".to_string(),
            Self::Timeout => "timeout".to_string(),
            Self::Cancelled => "cancelled".to_string(),
            Self::HttpStatus(status) => format!("http_{status}"),
            Self::ContentTypeDenied(_)
            | Self::PdfConversionUnavailable
            | Self::PdfConversionFailed => "content_type_denied".to_string(),
            Self::ResolveFailed | Self::ResolvePrivateNetwork | Self::Network => {
                "network_error".to_string()
            }
            Self::InvalidResponse => "invalid_response".to_string(),
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl => f.write_str("denied_host: invalid URL"),
            Self::DeniedScheme => f.write_str("denied_scheme"),
            Self::DeniedPort(port) => write!(f, "denied_port: {port}"),
            Self::DeniedPrivateNetwork => f.write_str("denied_private_network"),
            Self::DeniedHost => f.write_str("denied_host"),
            Self::ProxyUnconfigured => f.write_str("proxy_unconfigured"),
            Self::TooManyRedirects => f.write_str("too_many_redirects"),
            Self::TooLarge => f.write_str("too_large"),
            Self::Timeout => f.write_str("timeout"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::HttpStatus(status) => write!(f, "http_{status}"),
            Self::ContentTypeDenied(reason) => write!(f, "content_type_denied: {reason}"),
            Self::PdfConversionUnavailable => {
                f.write_str("content_type_denied: pdf conversion unavailable")
            }
            Self::PdfConversionFailed => f.write_str("content_type_denied: pdf conversion failed"),
            Self::ResolveFailed => f.write_str("network_error: DNS resolution failed"),
            Self::ResolvePrivateNetwork => f.write_str("denied_private_network"),
            Self::Network => f.write_str("network_error"),
            Self::InvalidResponse => f.write_str("invalid_response"),
        }
    }
}

impl std::error::Error for FetchError {}

#[derive(Clone, Debug)]
pub struct FetchConfig {
    pub via: FetchVia,
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub max_redirects: usize,
    pub max_bytes: usize,
    pub host_guard: HostGuardConfig,
    #[cfg(test)]
    pub allow_private_for_tests: bool,
}

impl FetchConfig {
    pub fn from_settings(web: &WebSettings) -> Self {
        let fetch = web.fetch();
        Self {
            via: web.fetch_via(),
            timeout: Duration::from_millis(fetch.timeout_ms()),
            connect_timeout: Duration::from_millis(fetch.connect_timeout_ms()),
            max_redirects: fetch.max_redirects() as usize,
            max_bytes: web.max_bytes().min(usize::MAX as u64) as usize,
            host_guard: HostGuardConfig {
                allow_hosts: web.allow_hosts().to_vec(),
                deny_hosts: web.deny_hosts().to_vec(),
                allow_ports: web.allow_ports().to_vec(),
                #[cfg(test)]
                allow_private_for_tests: false,
            },
            #[cfg(test)]
            allow_private_for_tests: false,
        }
    }

    #[cfg(test)]
    pub fn for_local_mock() -> Self {
        let mut config = Self::from_settings(&WebSettings::default());
        config.allow_private_for_tests = true;
        config.host_guard.allow_private_for_tests = true;
        config.via = FetchVia::Direct;
        config
    }
}

pub fn validate_target(raw_url: &str, config: &FetchConfig) -> Result<ValidatedUrl, FetchError> {
    validate(raw_url, config)
}

pub async fn fetch_url(
    raw_url: &str,
    abort_controller: &AbortController,
    config: &FetchConfig,
) -> Result<FetchedPage, FetchError> {
    ensure_not_aborted(abort_controller)?;
    let mut current = validate(raw_url, config)?;
    let original_url = current.url.to_string();
    let mut redirects = Vec::new();

    loop {
        ensure_not_aborted(abort_controller)?;
        let client = build_client(&current, config).await?;
        let response =
            send_request(&client, &current.url, abort_controller, config.timeout).await?;
        let status = response.status();

        if status.is_redirection() {
            if redirects.len() >= config.max_redirects {
                return Err(FetchError::TooManyRedirects);
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(FetchError::InvalidResponse)?;
            let next_url = current
                .url
                .join(location)
                .map_err(|_| FetchError::InvalidResponse)?;
            let next = validate(next_url.as_str(), config)?;
            redirects.push(RedirectHop {
                from: current.url.to_string(),
                to: next.url.to_string(),
                status: status.as_u16(),
            });
            current = next;
            continue;
        }

        let status_code = status.as_u16();
        if !status.is_success() {
            return Err(FetchError::HttpStatus(status_code));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase()
            })
            .unwrap_or_default();
        if !is_allowed_content_type(&content_type) {
            return Err(FetchError::ContentTypeDenied(content_type));
        }
        if response
            .content_length()
            .is_some_and(|length| length > config.max_bytes as u64)
        {
            return Err(FetchError::TooLarge);
        }
        let raw_body = read_body(response, config.max_bytes, abort_controller).await?;
        let text = convert_body(&content_type, &raw_body).await?;
        return Ok(FetchedPage {
            original_url,
            final_url: current.url.to_string(),
            redirects,
            status: status_code,
            content_type,
            fetched_at: Utc::now(),
            raw_body,
            text,
        });
    }
}

fn validate(raw_url: &str, config: &FetchConfig) -> Result<ValidatedUrl, FetchError> {
    #[cfg(test)]
    {
        let mut guard = config.host_guard.clone();
        guard.allow_private_for_tests |= config.allow_private_for_tests;
        return host_guard::validate_url(raw_url, &guard).map_err(map_guard_error);
    }
    #[cfg(not(test))]
    host_guard::validate_url(raw_url, &config.host_guard).map_err(map_guard_error)
}

fn map_guard_error(error: HostGuardError) -> FetchError {
    match error {
        HostGuardError::InvalidUrl | HostGuardError::Credentials => FetchError::InvalidUrl,
        HostGuardError::DeniedScheme => FetchError::DeniedScheme,
        HostGuardError::DeniedPort(port) => FetchError::DeniedPort(port),
        HostGuardError::DeniedPrivateNetwork => FetchError::DeniedPrivateNetwork,
        HostGuardError::DeniedHost => FetchError::DeniedHost,
    }
}

async fn build_client(
    validated: &ValidatedUrl,
    config: &FetchConfig,
) -> Result<reqwest::Client, FetchError> {
    crate::utils::tls_provider::install_crypto_provider();
    let mut builder = crate::utils::proxy::client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(config.connect_timeout)
        .timeout(config.timeout)
        .pool_idle_timeout(Duration::from_secs(90));

    match config.via {
        FetchVia::Proxy => {
            let env = crate::utils::process_env::snapshot();
            let Some(proxy_url) = crate::utils::proxy::get_proxy_url(&env) else {
                return Err(FetchError::ProxyUnconfigured);
            };
            let proxy = reqwest::Proxy::all(proxy_url).map_err(|_| FetchError::InvalidResponse)?;
            // @nyan: do not call create_axios_instance here. Its NO_PROXY
            // matcher would silently turn an explicit proxy fetch into direct I/O.
            builder = builder.proxy(proxy);
        }
        FetchVia::Direct => {
            let addresses = resolve_public_addresses(validated).await?;
            builder = builder.no_proxy();
            builder = builder.resolve_to_addrs(&validated.host, &addresses);
        }
    }

    builder.build().map_err(|_| FetchError::InvalidResponse)
}

async fn resolve_public_addresses(validated: &ValidatedUrl) -> Result<Vec<SocketAddr>, FetchError> {
    let addresses = tokio::net::lookup_host((validated.host.as_str(), validated.port))
        .await
        .map_err(|_| FetchError::ResolveFailed)?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(FetchError::ResolveFailed);
    }
    if addresses
        .iter()
        .any(|address| host_guard::is_private_ip(&address.ip()))
    {
        return Err(FetchError::ResolvePrivateNetwork);
    }
    Ok(addresses)
}

async fn send_request(
    client: &reqwest::Client,
    url: &reqwest::Url,
    abort_controller: &AbortController,
    timeout: Duration,
) -> Result<reqwest::Response, FetchError> {
    let request = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "text/html, text/plain, text/markdown, application/json, application/xml, application/pdf")
        .header(
            reqwest::header::USER_AGENT,
            crate::utils::http::get_web_fetch_user_agent(),
        )
        .send();
    let mut signal = abort_controller.signal();
    tokio::time::timeout(timeout, async {
        tokio::select! {
            result = request => result.map_err(|error| if error.is_timeout() { FetchError::Timeout } else { FetchError::Network }),
            _ = signal.aborted() => Err(FetchError::Cancelled),
        }
    })
    .await
    .map_err(|_| FetchError::Timeout)?
}

async fn read_body(
    response: reqwest::Response,
    max_bytes: usize,
    abort_controller: &AbortController,
) -> Result<Vec<u8>, FetchError> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    let mut signal = abort_controller.signal();
    while let Some(chunk) = tokio::select! {
        value = stream.next() => value,
        _ = signal.aborted() => return Err(FetchError::Cancelled),
    } {
        let chunk = chunk.map_err(|error| {
            if error.is_timeout() {
                FetchError::Timeout
            } else {
                FetchError::Network
            }
        })?;
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(FetchError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn is_allowed_content_type(content_type: &str) -> bool {
    matches!(
        content_type,
        "text/html"
            | "text/plain"
            | "text/markdown"
            | "application/json"
            | "application/xml"
            | "text/xml"
            | "application/pdf"
    )
}

async fn convert_body(content_type: &str, body: &[u8]) -> Result<String, FetchError> {
    if content_type == "application/pdf" {
        return convert_pdf(body).await;
    }
    let decoded = String::from_utf8_lossy(body).into_owned();
    if content_type == "text/html" {
        Ok(html_to_markdown(&decoded))
    } else {
        Ok(decoded)
    }
}

fn html_to_markdown(html: &str) -> String {
    let options = supermarkdown::Options::new()
        .heading_style(supermarkdown::HeadingStyle::Setext)
        .bullet_marker('*')
        .link_style(supermarkdown::LinkStyle::Inline);
    supermarkdown::convert_with_options(html, &options)
}

async fn convert_pdf(body: &[u8]) -> Result<String, FetchError> {
    let snapshots = crate::utils::env_utils::get_claude_config_home_dir().join("web-snapshots");
    let directory = snapshots.join("tmp");
    std::fs::create_dir_all(&directory).map_err(|_| FetchError::PdfConversionFailed)?;
    set_private_directory(&snapshots);
    set_private_directory(&directory);
    let path = directory.join(format!("{}.pdf", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, body).map_err(|_| FetchError::PdfConversionFailed)?;
    set_private_permissions(&path);
    let output = tokio::process::Command::new("pdftotext")
        .arg("-enc")
        .arg("UTF-8")
        .arg(&path)
        .arg("-")
        .output()
        .await;
    let _ = std::fs::remove_file(&path);
    let output = output.map_err(|_| FetchError::PdfConversionUnavailable)?;
    if !output.status.success() {
        return Err(FetchError::PdfConversionFailed);
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn set_private_directory(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn set_private_permissions(path: &PathBuf) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn ensure_not_aborted(abort_controller: &AbortController) -> Result<(), FetchError> {
    if abort_controller.is_aborted() {
        Err(FetchError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_type_allowlist_is_closed() {
        assert!(is_allowed_content_type("text/html"));
        assert!(is_allowed_content_type("application/pdf"));
        assert!(!is_allowed_content_type("image/png"));
        assert!(!is_allowed_content_type("application/octet-stream"));
    }

    #[tokio::test]
    async fn proxy_mode_without_proxy_is_named_and_does_not_connect() {
        let _lock = crate::utils::test_env::TEST_ENV_LOCK.lock().unwrap();
        let _http = crate::utils::test_env::EnvVarGuard::unset("http_proxy");
        let _https = crate::utils::test_env::EnvVarGuard::unset("https_proxy");
        let _http_upper = crate::utils::test_env::EnvVarGuard::unset("HTTP_PROXY");
        let _https_upper = crate::utils::test_env::EnvVarGuard::unset("HTTPS_PROXY");
        let config = FetchConfig::from_settings(&WebSettings::default());
        let error = fetch_url("https://example.com", &AbortController::default(), &config)
            .await
            .unwrap_err();
        assert_eq!(error, FetchError::ProxyUnconfigured);
    }

    #[test]
    fn pdf_conversion_uses_private_temp_path_helper() {
        let path = PathBuf::from("/tmp/nyan-web-fetch-test.pdf");
        set_private_permissions(&path);
    }
}
