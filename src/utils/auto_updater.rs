//! GitHub Releases-backed auto-update.
//!
//! The only distribution channel is the `blxzer77/nyan` GitHub Release stream:
//! tags are `nyan-vX.Y.Z`, assets are `nyan-vX.Y.Z-linux-x86_64.tar.gz`,
//! `...-linux-aarch64.tar.gz`, `...-windows-x86_64.zip`, and every release
//! carries a GNU coreutils `SHA256SUMS`. This module owns everything needed to
//! discover a newer release, download and verify the matching asset, and
//! atomically swap the running binary.
//!
//! The background check is **notify-only**: [`check_for_update`] reports the
//! newest version and never installs anything. Installation happens only
//! through the explicit `nyan update` command ([`run_update`]). Source and
//! development builds are not replaced; they get guidance instead.
//!
//! Network and filesystem effects sit behind [`ReleaseSource`], so tests drive
//! the whole flow with local fixtures and never touch the network.

use futures::future::BoxFuture;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// GitHub repository that publishes nyan release assets. Mirrors the install
/// scripts' `NYAN_REPO` default.
pub const DEFAULT_REPO: &str = "blxzer77/nyan";

/// Release tag prefix shared by the release workflow and install scripts.
pub const RELEASE_TAG_PREFIX: &str = "nyan-v";

/// How often the background checker may re-query GitHub in one process.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Checksum manifest asset name on every release.
pub const CHECKSUM_ASSET: &str = "SHA256SUMS";

// Channel policy note: `autoUpdatesChannel` (latest/stable) stays in settings,
// but nyan has no separate channel feed yet. Both values resolve to GitHub's
// `/releases/latest`, which never returns a prerelease or draft. Offering
// prereleases by default would be a product decision, so it is deliberately
// not guessed here.

/// Whether this binary can replace itself with a release asset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateSupport {
    /// Installed from a GitHub Release (or an equivalent standalone binary).
    ReleaseBinary,
    /// `cargo build` / `cargo run` tree; rebuilding is the update mechanism.
    DevelopmentBuild { path: PathBuf },
    /// `cargo install` / npm-style install; the binary lives outside a release.
    SourceInstall { path: PathBuf },
    /// No release asset exists for this OS/architecture.
    UnsupportedPlatform { platform: String },
}

/// Result of an explicit update attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateOutcome {
    Updated {
        from: String,
        to: String,
    },
    UpToDate {
        current: String,
        latest: String,
    },
    /// The running binary is not a release asset. `message` carries the
    /// user-facing guidance for this installation type.
    NotApplicable {
        message: String,
    },
}

impl UpdateOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Updated { .. } | Self::UpToDate { .. })
    }

    pub fn message(&self) -> String {
        match self {
            Self::Updated { from, to } => {
                format!("Updated nyan {from} -> {to}. Restart nyan to use the new version.")
            }
            Self::UpToDate { current, latest } => {
                format!("nyan {current} is up to date (latest: {latest}).")
            }
            Self::NotApplicable { message } => message.clone(),
        }
    }
}

/// A newer release found by the background check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateAvailable {
    pub version: String,
}

/// Errors an update attempt can report to the user.
#[derive(Debug)]
pub enum UpdateError {
    InvalidRepo(String),
    Http {
        url: String,
        message: String,
    },
    InvalidRelease(String),
    NoCompatibleAsset {
        version: String,
        platform: String,
    },
    MissingChecksum(String),
    ChecksumMismatch {
        asset: String,
        expected: String,
        actual: String,
    },
    Archive(String),
    Io(std::io::Error),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRepo(repo) => {
                write!(f, "invalid GitHub repository {repo:?}; expected owner/name")
            }
            Self::Http { url, message } => write!(f, "request to {url} failed: {message}"),
            Self::InvalidRelease(reason) => write!(f, "invalid GitHub release: {reason}"),
            Self::NoCompatibleAsset { version, platform } => {
                write!(f, "release nyan-v{version} has no asset for {platform}")
            }
            Self::MissingChecksum(asset) => {
                write!(f, "{CHECKSUM_ASSET} has no valid entry for {asset}")
            }
            Self::ChecksumMismatch {
                asset,
                expected,
                actual,
            } => write!(
                f,
                "SHA256 mismatch for {asset}: expected {expected}, got {actual}"
            ),
            Self::Archive(message) => write!(f, "cannot unpack release archive: {message}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for UpdateError {}

impl From<std::io::Error> for UpdateError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Maps to: CC `MACRO.VERSION` (compile-time running version).
pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Resolve the repository slug, honouring `NYAN_REPO` like the install scripts.
pub fn resolve_repo(value: Option<&str>) -> Result<String, UpdateError> {
    let repo = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_REPO);
    let valid = repo
        .split_once('/')
        .is_some_and(|(owner, name)| !owner.is_empty() && !name.is_empty() && !name.contains('/'))
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if valid {
        Ok(repo.to_string())
    } else {
        Err(UpdateError::InvalidRepo(repo.to_string()))
    }
}

pub fn repo_from_env() -> Result<String, UpdateError> {
    resolve_repo(crate::utils::process_env::var("NYAN_REPO").as_deref())
}

/// Asset for the release version and platform, following `release.yml`.
pub fn asset_name(version: &str, os: &str, arch: &str) -> Option<String> {
    let suffix = match (os, arch) {
        ("linux", "x86_64") => "linux-x86_64.tar.gz",
        ("linux", "aarch64") => "linux-aarch64.tar.gz",
        ("windows", "x86_64") => "windows-x86_64.zip",
        _ => return None,
    };
    Some(format!("nyan-v{version}-{suffix}"))
}

fn platform_label(os: &str, arch: &str) -> String {
    format!("{os}-{arch}")
}

/// Classify the running binary without touching the network.
pub fn update_support_for_path(exe: &Path, os: &str, arch: &str) -> UpdateSupport {
    let path = exe.to_string_lossy().replace('\\', "/");
    let lower = path.to_ascii_lowercase();
    if lower.contains("/target/debug/") || lower.contains("/target/release/") {
        return UpdateSupport::DevelopmentBuild {
            path: exe.to_path_buf(),
        };
    }
    if lower.contains("/.cargo/bin/")
        || lower.contains("/node_modules/")
        || lower.contains("/.nvm/versions/node/")
    {
        return UpdateSupport::SourceInstall {
            path: exe.to_path_buf(),
        };
    }
    if asset_name("0.0.0", os, arch).is_some() {
        UpdateSupport::ReleaseBinary
    } else {
        UpdateSupport::UnsupportedPlatform {
            platform: platform_label(os, arch),
        }
    }
}

/// Classify this process. `NODE_ENV`/`NYAN_ENV=development` behaves like a
/// `cargo run` build even when the executable was copied elsewhere.
pub fn current_update_support() -> UpdateSupport {
    let development_env = crate::utils::process_env::var("NODE_ENV")
        .as_deref()
        .is_some_and(|v| v == "development")
        || crate::utils::process_env::var("NYAN_ENV")
            .as_deref()
            .is_some_and(|v| v == "development");
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("nyan"));
    if development_env {
        return UpdateSupport::DevelopmentBuild { path: exe };
    }
    update_support_for_path(&exe, std::env::consts::OS, std::env::consts::ARCH)
}

impl UpdateSupport {
    pub fn guidance(&self, repo: &str) -> String {
        match self {
            Self::ReleaseBinary => String::new(),
            Self::DevelopmentBuild { path } => format!(
                "nyan is a development build ({}); rebuild it from source to update.",
                path.display()
            ),
            Self::SourceInstall { path } => format!(
                "nyan was installed from source at {}; update with `cargo install --git https://github.com/{repo} --locked nyan`, or install a release build from https://github.com/{repo}/releases.",
                path.display()
            ),
            Self::UnsupportedPlatform { platform } => format!(
                "auto-update has no release asset for {platform}; download a release from https://github.com/{repo}/releases."
            ),
        }
    }
}

/// Parsed `nyan-vX.Y.Z[-pre]` release version, ordered with SemVer precedence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

impl ReleaseVersion {
    pub fn parse(value: &str) -> Option<Self> {
        let (base, pre) = match value.split_once('-') {
            Some((base, pre)) if valid_prerelease(pre) => (base, Some(pre.to_string())),
            Some(_) => return None,
            None => (value, None),
        };
        let mut parts = base.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch,
            pre,
        })
    }

    pub fn as_version_string(&self) -> String {
        let mut value = format!("{}.{}.{}", self.major, self.minor, self.patch);
        if let Some(pre) = &self.pre {
            value.push('-');
            value.push_str(pre);
        }
        value
    }
}

fn valid_prerelease(pre: &str) -> bool {
    !pre.is_empty()
        && pre
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()))
}

fn compare_prerelease(left: &str, right: &str) -> Ordering {
    for (left_part, right_part) in left.split('.').zip(right.split('.')) {
        let ordering = match (left_part.parse::<u64>(), right_part.parse::<u64>()) {
            (Ok(left), Ok(right)) => left.cmp(&right),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => left_part.cmp(right_part),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.split('.').count().cmp(&right.split('.').count())
}

impl Ord for ReleaseVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(left), Some(right)) => compare_prerelease(left, right),
            })
    }
}

impl PartialOrd for ReleaseVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn parse_release_tag(tag: &str) -> Option<ReleaseVersion> {
    ReleaseVersion::parse(tag.strip_prefix(RELEASE_TAG_PREFIX)?)
}

pub fn version_gte(candidate: &str, current: &str) -> bool {
    match (
        ReleaseVersion::parse(candidate),
        ReleaseVersion::parse(current),
    ) {
        (Some(candidate), Some(current)) => candidate >= current,
        _ => candidate >= current,
    }
}

/// Maps to: CC `shouldSkipVersion` (settings.minimumVersion gate).
pub fn should_skip_version(target_version: &str) -> bool {
    let settings = crate::utils::settings::load_settings_from_disk().settings;
    let Some(minimum) = settings
        .minimum_version
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return false;
    };
    let skip = !version_gte(target_version, minimum);
    if skip {
        crate::utils::debug::log_for_debugging(&format!(
            "Skipping update to {target_version} - below minimumVersion {minimum}"
        ));
    }
    skip
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    pub download_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub tag: String,
    pub version: ReleaseVersion,
    pub assets: Vec<ReleaseAsset>,
}

impl Release {
    pub fn asset(&self, name: &str) -> Option<&ReleaseAsset> {
        self.assets.iter().find(|asset| asset.name == name)
    }
}

#[derive(Deserialize)]
struct RawAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct RawRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<RawAsset>,
}

fn release_from_raw(raw: RawRelease) -> Option<Release> {
    let version = parse_release_tag(&raw.tag_name)?;
    Some(Release {
        tag: raw.tag_name,
        version,
        assets: raw
            .assets
            .into_iter()
            .map(|asset| ReleaseAsset {
                name: asset.name,
                download_url: asset.browser_download_url,
            })
            .collect(),
    })
}

/// Parse the `/releases/latest` object.
pub fn parse_latest_release(json: &str) -> Result<Release, UpdateError> {
    let raw: RawRelease = serde_json::from_str(json)
        .map_err(|error| UpdateError::InvalidRelease(error.to_string()))?;
    if raw.draft {
        return Err(UpdateError::InvalidRelease(
            "latest release is a draft".to_string(),
        ));
    }
    release_from_raw(raw)
        .ok_or_else(|| UpdateError::InvalidRelease("release tag is not nyan-vX.Y.Z".to_string()))
}

/// Parsed `SHA256SUMS` digest for `asset`.
pub fn parse_checksum(manifest: &str, asset: &str) -> Option<String> {
    manifest.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let digest = fields.next()?;
        let name = fields.next()?;
        (name == asset && is_sha256_hex(digest)).then(|| digest.to_ascii_lowercase())
    })
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Network/API seam. Tests substitute fixtures for both methods.
pub trait ReleaseSource: Send + Sync {
    fn fetch_release<'a>(&'a self, repo: &'a str) -> BoxFuture<'a, Result<Release, UpdateError>>;

    fn fetch_bytes<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, UpdateError>>;
}

fn latest_release_url(repo: &str) -> String {
    format!("https://api.github.com/repos/{repo}/releases/latest")
}

/// Real GitHub API/download client.
pub struct GitHubReleaseSource {
    client: reqwest::Client,
}

impl GitHubReleaseSource {
    pub fn new() -> Result<Self, UpdateError> {
        crate::utils::tls_provider::install_crypto_provider();
        let client = reqwest::Client::builder()
            .user_agent(crate::utils::http::user_agent())
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| UpdateError::Http {
                url: "https://api.github.com".to_string(),
                message: error.to_string(),
            })?;
        Ok(Self { client })
    }

    async fn get_text(&self, url: &str) -> Result<String, UpdateError> {
        let response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .map_err(|error| UpdateError::Http {
                url: url.to_string(),
                message: error.to_string(),
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(UpdateError::Http {
                url: url.to_string(),
                message: format!("HTTP {status}"),
            });
        }
        response.text().await.map_err(|error| UpdateError::Http {
            url: url.to_string(),
            message: error.to_string(),
        })
    }
}

impl ReleaseSource for GitHubReleaseSource {
    fn fetch_release<'a>(&'a self, repo: &'a str) -> BoxFuture<'a, Result<Release, UpdateError>> {
        Box::pin(async move {
            let body = self.get_text(&latest_release_url(repo)).await?;
            parse_latest_release(&body)
        })
    }

    fn fetch_bytes<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, UpdateError>> {
        Box::pin(async move {
            let response =
                self.client
                    .get(url)
                    .send()
                    .await
                    .map_err(|error| UpdateError::Http {
                        url: url.to_string(),
                        message: error.to_string(),
                    })?;
            let status = response.status();
            if !status.is_success() {
                return Err(UpdateError::Http {
                    url: url.to_string(),
                    message: format!("HTTP {status}"),
                });
            }
            let bytes = response.bytes().await.map_err(|error| UpdateError::Http {
                url: url.to_string(),
                message: error.to_string(),
            })?;
            Ok(bytes.to_vec())
        })
    }
}

#[derive(Clone)]
struct CachedCheck {
    at: Instant,
    repo: String,
    latest: Option<String>,
}

static CHECK_CACHE: LazyLock<Mutex<Option<CachedCheck>>> = LazyLock::new(|| Mutex::new(None));

fn cached_check(repo: &str) -> Option<Option<String>> {
    let cache = CHECK_CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.as_ref().and_then(|cached| {
        (cached.repo == repo && cached.at.elapsed() < CHECK_INTERVAL).then(|| cached.latest.clone())
    })
}

fn store_check(repo: &str, latest: Option<String>) {
    let mut cache = CHECK_CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *cache = Some(CachedCheck {
        at: Instant::now(),
        repo: repo.to_string(),
        latest,
    });
}

/// Query the newest release without installing anything.
pub async fn check_for_update_with(
    source: &dyn ReleaseSource,
    repo: &str,
    current: &str,
) -> Result<Option<String>, UpdateError> {
    let release = source.fetch_release(repo).await?;
    let newer = match ReleaseVersion::parse(current) {
        Some(current) => release.version > current,
        None => true,
    };
    Ok(newer.then(|| release.version.as_version_string()))
}

/// Background-check entry point: notify-only, cached for [`CHECK_INTERVAL`],
/// and silent for non-release installs and failures.
pub async fn check_for_update() -> Option<String> {
    if !matches!(current_update_support(), UpdateSupport::ReleaseBinary) {
        return None;
    }
    let repo = match repo_from_env() {
        Ok(repo) => repo,
        Err(error) => {
            crate::utils::debug::log_for_debugging(&format!("AutoUpdater: {error}"));
            return None;
        }
    };
    if let Some(cached) = cached_check(&repo) {
        return cached;
    }
    let source = match GitHubReleaseSource::new() {
        Ok(source) => source,
        Err(error) => {
            crate::utils::debug::log_for_debugging(&format!("AutoUpdater: {error}"));
            return None;
        }
    };
    match check_for_update_with(&source, &repo, &current_version()).await {
        Ok(latest) => {
            store_check(&repo, latest.clone());
            latest
        }
        Err(error) => {
            crate::utils::debug::log_for_debugging(&format!("AutoUpdater: {error}"));
            None
        }
    }
}

enum ArchiveKind {
    TarGz,
    Zip,
}

fn archive_kind(asset: &str) -> Option<ArchiveKind> {
    if asset.ends_with(".tar.gz") {
        Some(ArchiveKind::TarGz)
    } else if asset.ends_with(".zip") {
        Some(ArchiveKind::Zip)
    } else {
        None
    }
}

fn is_safe_relative(path: &Path) -> bool {
    use std::path::Component;
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn unpack_tar_gz(archive: &Path, dest: &Path) -> Result<(), UpdateError> {
    let file = std::fs::File::open(archive)?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive
        .entries()
        .map_err(|error| UpdateError::Archive(error.to_string()))?
    {
        let mut entry = entry.map_err(|error| UpdateError::Archive(error.to_string()))?;
        let path = entry
            .path()
            .map_err(|error| UpdateError::Archive(error.to_string()))?
            .into_owned();
        if !is_safe_relative(&path) {
            return Err(UpdateError::Archive(format!(
                "unsafe archive path {}",
                path.display()
            )));
        }
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            return Err(UpdateError::Archive(format!(
                "unsupported archive entry {}",
                path.display()
            )));
        }
        entry
            .unpack_in(dest)
            .map_err(|error| UpdateError::Archive(error.to_string()))?;
    }
    Ok(())
}

fn unpack_zip(archive: &Path, dest: &Path) -> Result<(), UpdateError> {
    let file = std::fs::File::open(archive)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| UpdateError::Archive(error.to_string()))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| UpdateError::Archive(error.to_string()))?;
        let entry_name = entry
            .name()
            .map(|name| name.into_owned())
            .unwrap_or_else(|_| "<unreadable>".to_string());
        let Some(relative) = entry.enclosed_name() else {
            return Err(UpdateError::Archive(format!(
                "unsafe archive entry {entry_name}"
            )));
        };
        if !is_safe_relative(&relative) {
            return Err(UpdateError::Archive(format!(
                "unsafe archive entry {entry_name}"
            )));
        }
        if let Some(mode) = entry.unix_mode()
            && mode & 0o170000 == 0o120000
        {
            return Err(UpdateError::Archive(format!(
                "unsupported archive symlink {entry_name}"
            )));
        }
        let target = dest.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut output = std::fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut output)?;
    }
    Ok(())
}

fn extract_archive(archive: &Path, kind: ArchiveKind, dest: &Path) -> Result<(), UpdateError> {
    std::fs::create_dir_all(dest)?;
    match kind {
        ArchiveKind::TarGz => unpack_tar_gz(archive, dest),
        ArchiveKind::Zip => unpack_zip(archive, dest),
    }
}

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new(root: &Path) -> Result<Self, UpdateError> {
        let path = root.join(format!("nyan-update-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(windows)]
fn copy_dir_all(source: &Path, dest: &Path) -> Result<(), UpdateError> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Replace the bundled `vendor/` directory on Windows, matching `install.ps1`.
#[cfg(windows)]
fn replace_vendor_dir(extracted: &Path, exe: &Path) -> Result<(), UpdateError> {
    let source = extracted.join("vendor");
    if !source.is_dir() {
        return Ok(());
    }
    let Some(parent) = exe.parent() else {
        return Ok(());
    };
    let vendor = parent.join("vendor");
    let staging = parent.join(format!("vendor.new-{}", uuid::Uuid::new_v4().simple()));
    copy_dir_all(&source, &staging)?;
    if vendor.exists() {
        std::fs::remove_dir_all(&vendor)?;
    }
    std::fs::rename(&staging, &vendor)?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_vendor_dir(_extracted: &Path, _exe: &Path) -> Result<(), UpdateError> {
    Ok(())
}

#[cfg(unix)]
fn install_permissions(path: &Path) -> Result<(), UpdateError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(not(unix))]
fn install_permissions(_path: &Path) -> Result<(), UpdateError> {
    Ok(())
}

/// Atomically move `new_binary` over `destination`, staging it in the
/// destination directory so the final rename stays on one filesystem.
pub fn replace_binary(new_binary: &Path, destination: &Path) -> Result<(), UpdateError> {
    let dir = destination
        .parent()
        .ok_or_else(|| UpdateError::Archive("destination has no parent directory".to_string()))?;
    let staged = dir.join(format!(
        ".{}.new-{}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("nyan"),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::copy(new_binary, &staged)?;
    install_permissions(&staged)?;

    #[cfg(windows)]
    {
        // A running exe cannot be overwritten but can be renamed aside; this is
        // the standard rename-swap. Restore it if the new binary cannot land.
        let backup = dir.join(format!(
            ".{}.old-{}",
            destination
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("nyan"),
            std::process::id()
        ));
        let _ = std::fs::remove_file(&backup);
        if let Err(error) = std::fs::rename(destination, &backup) {
            let _ = std::fs::remove_file(&staged);
            return Err(error.into());
        }
        if let Err(error) = std::fs::rename(&staged, destination) {
            let _ = std::fs::rename(&backup, destination);
            let _ = std::fs::remove_file(&staged);
            return Err(error.into());
        }
        // Deletion usually fails while the old image is still mapped; the next
        // update removes leftovers.
        let _ = std::fs::remove_file(&backup);
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        std::fs::rename(&staged, destination).inspect_err(|_| {
            let _ = std::fs::remove_file(&staged);
        })?;
        Ok(())
    }
}

/// Download, verify, unpack and install a newer release into `exe_path`.
/// Parameters keep the flow testable with local fixtures and temp paths.
pub async fn install_update_with(
    source: &dyn ReleaseSource,
    repo: &str,
    current: &str,
    exe_path: &Path,
    os: &str,
    arch: &str,
    temp_root: &Path,
) -> Result<UpdateOutcome, UpdateError> {
    let release = source.fetch_release(repo).await?;
    let from = ReleaseVersion::parse(current)
        .map(|version| version.as_version_string())
        .unwrap_or_else(|| current.to_string());
    if ReleaseVersion::parse(current).is_some_and(|current| release.version <= current) {
        return Ok(UpdateOutcome::UpToDate {
            current: from,
            latest: release.version.as_version_string(),
        });
    }

    let to = release.version.as_version_string();
    let asset = asset_name(&to, os, arch).ok_or_else(|| UpdateError::NoCompatibleAsset {
        version: to.clone(),
        platform: platform_label(os, arch),
    })?;
    let archive = release
        .asset(&asset)
        .ok_or_else(|| UpdateError::NoCompatibleAsset {
            version: to.clone(),
            platform: platform_label(os, arch),
        })?;
    let checksums = release
        .asset(CHECKSUM_ASSET)
        .ok_or_else(|| UpdateError::MissingChecksum(asset.clone()))?;

    let manifest = source.fetch_bytes(&checksums.download_url).await?;
    let manifest =
        String::from_utf8(manifest).map_err(|error| UpdateError::Archive(error.to_string()))?;
    let expected = parse_checksum(&manifest, &asset)
        .ok_or_else(|| UpdateError::MissingChecksum(asset.clone()))?;
    let bytes = source.fetch_bytes(&archive.download_url).await?;
    let actual = sha256_hex(&bytes);
    if actual != expected {
        return Err(UpdateError::ChecksumMismatch {
            asset,
            expected,
            actual,
        });
    }

    let workspace = TempWorkspace::new(temp_root)?;
    let archive_path = workspace.path().join(&asset);
    std::fs::write(&archive_path, &bytes)?;
    let extracted = workspace.path().join("unpacked");
    let kind = archive_kind(&asset)
        .ok_or_else(|| UpdateError::Archive(format!("unsupported asset {asset}")))?;
    extract_archive(&archive_path, kind, &extracted)?;

    let binary_name = if os == "windows" { "nyan.exe" } else { "nyan" };
    let extracted_binary = extracted.join(binary_name);
    if !extracted_binary.is_file() {
        return Err(UpdateError::Archive(format!(
            "archive has no {binary_name}"
        )));
    }
    replace_vendor_dir(&extracted, exe_path)?;
    replace_binary(&extracted_binary, exe_path)?;

    Ok(UpdateOutcome::Updated { from, to })
}

/// Explicit `nyan update`: reuses the real GitHub source and this process's
/// executable, but refuses non-release installs with actionable guidance.
pub async fn run_update() -> Result<UpdateOutcome, UpdateError> {
    let support = current_update_support();
    if support != UpdateSupport::ReleaseBinary {
        let repo = repo_from_env().unwrap_or_else(|_| DEFAULT_REPO.to_string());
        return Ok(UpdateOutcome::NotApplicable {
            message: support.guidance(&repo),
        });
    }
    let repo = repo_from_env()?;
    let source = GitHubReleaseSource::new()?;
    let exe = std::env::current_exe()?;
    install_update_with(
        &source,
        &repo,
        &current_version(),
        &exe,
        std::env::consts::OS,
        std::env::consts::ARCH,
        &std::env::temp_dir(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeSource {
        release: Release,
        files: HashMap<String, Vec<u8>>,
        fetched: Mutex<Vec<String>>,
    }

    impl FakeSource {
        fn new(release: Release, files: HashMap<String, Vec<u8>>) -> Self {
            Self {
                release,
                files,
                fetched: Mutex::new(Vec::new()),
            }
        }
    }

    impl ReleaseSource for FakeSource {
        fn fetch_release<'a>(
            &'a self,
            _repo: &'a str,
        ) -> BoxFuture<'a, Result<Release, UpdateError>> {
            Box::pin(async move { Ok(self.release.clone()) })
        }

        fn fetch_bytes<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, UpdateError>> {
            Box::pin(async move {
                self.fetched.lock().unwrap().push(url.to_string());
                self.files
                    .get(url)
                    .cloned()
                    .ok_or_else(|| UpdateError::Http {
                        url: url.to_string(),
                        message: "missing fixture".to_string(),
                    })
            })
        }
    }

    fn fixture_release(tag: &str, assets: &[(&str, &str)]) -> Release {
        Release {
            tag: tag.to_string(),
            version: parse_release_tag(tag).expect("fixture tag"),
            assets: assets
                .iter()
                .map(|(name, url)| ReleaseAsset {
                    name: (*name).to_string(),
                    download_url: (*url).to_string(),
                })
                .collect(),
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nyan-auto-update-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn tar_gz_fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut encoder);
            for (name, contents) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(contents.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder
                    .append_data(&mut header, name, *contents)
                    .expect("tar entry");
            }
            builder.finish().expect("tar finish");
        }
        encoder.finish().expect("gzip finish")
    }

    fn zip_fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, contents) in entries {
            writer.start_file(*name, options).expect("zip entry");
            std::io::Write::write_all(&mut writer, contents).expect("zip write");
        }
        writer.finish().expect("zip finish").into_inner()
    }

    #[test]
    fn asset_names_follow_the_release_workflow() {
        assert_eq!(
            asset_name("0.2.0", "linux", "x86_64").as_deref(),
            Some("nyan-v0.2.0-linux-x86_64.tar.gz")
        );
        assert_eq!(
            asset_name("0.2.0", "linux", "aarch64").as_deref(),
            Some("nyan-v0.2.0-linux-aarch64.tar.gz")
        );
        assert_eq!(
            asset_name("0.2.0", "windows", "x86_64").as_deref(),
            Some("nyan-v0.2.0-windows-x86_64.zip")
        );
        assert_eq!(asset_name("0.2.0", "macos", "aarch64"), None);
        assert_eq!(asset_name("0.2.0", "windows", "aarch64"), None);
    }

    #[test]
    fn release_tags_parse_and_order_semver() {
        assert_eq!(
            parse_release_tag("nyan-v0.2.0"),
            Some(ReleaseVersion {
                major: 0,
                minor: 2,
                patch: 0,
                pre: None
            })
        );
        assert_eq!(parse_release_tag("v0.2.0"), None);
        assert_eq!(parse_release_tag("nyan-v0.2"), None);
        assert_eq!(parse_release_tag("nyan-v0.2.0-"), None);

        let version = |value: &str| ReleaseVersion::parse(value).expect(value);
        assert!(version("0.2.1") > version("0.2.0"));
        assert!(version("0.2.0") == version("0.2.0"));
        assert!(version("0.2.0") > version("0.2.0-rc.1"));
        assert!(version("0.2.1-rc.2") > version("0.2.1-rc.1"));
        assert!(version("0.2.1-rc.10") > version("0.2.1-rc.2"));
        assert!(version("0.2.1-beta") > version("0.2.1-alpha"));
        assert!(version_gte("0.2.0", "0.2.0"));
    }

    #[test]
    fn latest_release_payload_parses_tag_and_assets() {
        let json = r#"{
            "tag_name": "nyan-v0.3.0",
            "draft": false,
            "assets": [
                {"name": "nyan-v0.3.0-linux-x86_64.tar.gz", "browser_download_url": "https://example.test/linux"},
                {"name": "SHA256SUMS", "browser_download_url": "https://example.test/sums"}
            ]
        }"#;
        let release = parse_latest_release(json).expect("parse");
        assert_eq!(release.tag, "nyan-v0.3.0");
        assert_eq!(release.version.as_version_string(), "0.3.0");
        assert_eq!(release.assets.len(), 2);
    }

    #[test]
    fn checksum_manifest_picks_exact_asset_only() {
        let digest = "a".repeat(64);
        let manifest = format!(
            "{}  nyan-v0.2.0-linux-x86_64.tar.gz\n{}  other.zip\n",
            digest,
            "b".repeat(64)
        );
        assert_eq!(
            parse_checksum(&manifest, "nyan-v0.2.0-linux-x86_64.tar.gz"),
            Some(digest.clone())
        );
        assert_eq!(parse_checksum(&manifest, "nyan-v0.2.0-linux-x86_64"), None);
        assert_eq!(parse_checksum(&format!("short  asset"), "asset"), None);
    }

    #[test]
    fn repo_resolution_matches_install_scripts() {
        assert_eq!(resolve_repo(None).unwrap(), DEFAULT_REPO);
        assert_eq!(resolve_repo(Some("owner/repo")).unwrap(), "owner/repo");
        assert_eq!(resolve_repo(Some(" ")).unwrap(), DEFAULT_REPO);
        assert!(matches!(
            resolve_repo(Some("owner/repo/extra")),
            Err(UpdateError::InvalidRepo(_))
        ));
        assert!(matches!(
            resolve_repo(Some("owner repo")),
            Err(UpdateError::InvalidRepo(_))
        ));
    }

    #[test]
    fn update_support_distinguishes_release_and_source_builds() {
        assert_eq!(
            update_support_for_path(Path::new("/home/u/.local/bin/nyan"), "linux", "x86_64"),
            UpdateSupport::ReleaseBinary
        );
        assert!(matches!(
            update_support_for_path(
                Path::new("/src/nyan/target/release/nyan"),
                "linux",
                "x86_64"
            ),
            UpdateSupport::DevelopmentBuild { .. }
        ));
        assert!(matches!(
            update_support_for_path(Path::new("/home/u/.cargo/bin/nyan"), "linux", "x86_64"),
            UpdateSupport::SourceInstall { .. }
        ));
        assert!(matches!(
            update_support_for_path(Path::new("/home/u/.local/bin/nyan"), "macos", "aarch64"),
            UpdateSupport::UnsupportedPlatform { .. }
        ));
    }

    #[tokio::test]
    async fn check_reports_only_newer_releases() {
        let release = fixture_release("nyan-v0.3.0", &[]);
        let source = FakeSource::new(release, HashMap::new());
        assert_eq!(
            check_for_update_with(&source, DEFAULT_REPO, "0.2.0")
                .await
                .unwrap(),
            Some("0.3.0".to_string())
        );
        assert_eq!(
            check_for_update_with(&source, DEFAULT_REPO, "0.3.0")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            check_for_update_with(&source, DEFAULT_REPO, "0.4.0")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn install_tar_gz_verifies_checksum_and_replaces_binary() {
        let root = temp_root("tar");
        let version = "0.3.0";
        let asset = asset_name(version, "linux", "x86_64").unwrap();
        let archive = tar_gz_fixture(&[("nyan", b"new-binary"), ("LICENSE", b"license")]);
        let manifest = format!("{}  {asset}\n", sha256_hex(&archive));
        let release = fixture_release(
            "nyan-v0.3.0",
            &[
                (&asset, "https://example.test/archive"),
                (CHECKSUM_ASSET, "https://example.test/sums"),
            ],
        );
        let source = FakeSource::new(
            release,
            HashMap::from([
                ("https://example.test/archive".to_string(), archive),
                (
                    "https://example.test/sums".to_string(),
                    manifest.into_bytes(),
                ),
            ]),
        );
        let exe = root.join("nyan");
        std::fs::write(&exe, b"old-binary").unwrap();

        let outcome = install_update_with(
            &source,
            DEFAULT_REPO,
            "0.2.0",
            &exe,
            "linux",
            "x86_64",
            &root,
        )
        .await
        .expect("install");

        assert_eq!(
            outcome,
            UpdateOutcome::Updated {
                from: "0.2.0".to_string(),
                to: "0.3.0".to_string()
            }
        );
        assert_eq!(std::fs::read(&exe).unwrap(), b"new-binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn install_zip_replaces_windows_binary_fixture() {
        let root = temp_root("zip");
        let asset = asset_name("0.3.0", "windows", "x86_64").unwrap();
        let archive = zip_fixture(&[("nyan.exe", b"new-exe"), ("LICENSE", b"license")]);
        let manifest = format!("{}  {asset}\n", sha256_hex(&archive));
        let release = fixture_release(
            "nyan-v0.3.0",
            &[
                (&asset, "https://example.test/archive"),
                (CHECKSUM_ASSET, "https://example.test/sums"),
            ],
        );
        let source = FakeSource::new(
            release,
            HashMap::from([
                ("https://example.test/archive".to_string(), archive),
                (
                    "https://example.test/sums".to_string(),
                    manifest.into_bytes(),
                ),
            ]),
        );
        let exe = root.join("nyan.exe");
        std::fs::write(&exe, b"old-exe").unwrap();

        install_update_with(
            &source,
            DEFAULT_REPO,
            "0.2.0",
            &exe,
            "windows",
            "x86_64",
            &root,
        )
        .await
        .expect("install");

        assert_eq!(std::fs::read(&exe).unwrap(), b"new-exe");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn install_rejects_checksum_mismatch_without_touching_binary() {
        let root = temp_root("mismatch");
        let asset = asset_name("0.3.0", "linux", "x86_64").unwrap();
        let archive = tar_gz_fixture(&[("nyan", b"new-binary")]);
        let manifest = format!("{}  {asset}\n", "0".repeat(64));
        let release = fixture_release(
            "nyan-v0.3.0",
            &[
                (&asset, "https://example.test/archive"),
                (CHECKSUM_ASSET, "https://example.test/sums"),
            ],
        );
        let source = FakeSource::new(
            release,
            HashMap::from([
                ("https://example.test/archive".to_string(), archive),
                (
                    "https://example.test/sums".to_string(),
                    manifest.into_bytes(),
                ),
            ]),
        );
        let exe = root.join("nyan");
        std::fs::write(&exe, b"old-binary").unwrap();

        let error = install_update_with(
            &source,
            DEFAULT_REPO,
            "0.2.0",
            &exe,
            "linux",
            "x86_64",
            &root,
        )
        .await
        .expect_err("checksum mismatch");
        assert!(matches!(error, UpdateError::ChecksumMismatch { .. }));
        assert_eq!(std::fs::read(&exe).unwrap(), b"old-binary");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn install_reports_up_to_date_without_downloading() {
        let root = temp_root("current");
        let source = FakeSource::new(fixture_release("nyan-v0.2.0", &[]), HashMap::new());
        let exe = root.join("nyan");
        std::fs::write(&exe, b"old-binary").unwrap();

        let outcome = install_update_with(
            &source,
            DEFAULT_REPO,
            "0.2.0",
            &exe,
            "linux",
            "x86_64",
            &root,
        )
        .await
        .expect("up to date");

        assert_eq!(
            outcome,
            UpdateOutcome::UpToDate {
                current: "0.2.0".to_string(),
                latest: "0.2.0".to_string()
            }
        );
        assert!(source.fetched.lock().unwrap().is_empty());
        assert_eq!(std::fs::read(&exe).unwrap(), b"old-binary");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn install_reports_missing_asset_for_platform() {
        let root = temp_root("asset");
        let source = FakeSource::new(fixture_release("nyan-v0.3.0", &[]), HashMap::new());
        let exe = root.join("nyan");
        std::fs::write(&exe, b"old-binary").unwrap();

        let error = install_update_with(
            &source,
            DEFAULT_REPO,
            "0.2.0",
            &exe,
            "linux",
            "x86_64",
            &root,
        )
        .await
        .expect_err("missing asset");
        assert!(matches!(error, UpdateError::NoCompatibleAsset { .. }));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn archive_paths_must_stay_relative() {
        assert!(is_safe_relative(Path::new("nyan")));
        assert!(is_safe_relative(Path::new("vendor/ripgrep/rg.exe")));
        assert!(!is_safe_relative(Path::new("../nyan")));
        assert!(!is_safe_relative(Path::new("/etc/passwd")));
    }
}
