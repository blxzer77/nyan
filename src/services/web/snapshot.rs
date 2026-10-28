//! Content-addressed WebFetch snapshots and local range reads.
//!
//! @nyan: the old in-process body LRU is replaced by a URL → latest hash index;
//! the body is durable, globally scoped under `$CLAUDE_CONFIG_DIR`, and never
//! overwritten when a page changes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use super::fetcher::FetchedPage;

const INDEX_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotMetadata {
    pub url: String,
    pub final_url: String,
    pub redirects: Vec<String>,
    pub status: u16,
    pub content_type: String,
    pub fetched_at: DateTime<Utc>,
    pub fetched_by: String,
    pub sha256: String,
    pub bytes: usize,
    pub provider_format: Option<String>,
    pub freshness: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub hash: String,
    pub metadata: SnapshotMetadata,
    pub text: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSnapshotInput {
    pub url: String,
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    pub fetched_at: DateTime<Utc>,
    pub fetched_by: String,
    pub text: String,
    pub provider_format: String,
    pub freshness: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RangeSpec {
    Chars { start: usize, end: Option<usize> },
    Section(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedRange {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub total: usize,
    pub section: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RangeError {
    Invalid,
    OutOfBounds(usize),
    SectionNotFound {
        requested: String,
        headings: Vec<String>,
    },
}

impl std::fmt::Display for RangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid => f.write_str("range_invalid"),
            Self::OutOfBounds(total) => write!(f, "range_out_of_bounds: page has {total} chars"),
            Self::SectionNotFound { headings, .. } => {
                if headings.is_empty() {
                    f.write_str("section_not_found")
                } else {
                    write!(f, "section_not_found; headings: {}", headings.join(", "))
                }
            }
        }
    }
}

impl std::error::Error for RangeError {}

#[derive(Clone, Debug)]
struct UrlIndexEntry {
    hash: String,
    fetched_at: DateTime<Utc>,
}

fn index() -> &'static Mutex<HashMap<String, UrlIndexEntry>> {
    static INDEX: OnceLock<Mutex<HashMap<String, UrlIndexEntry>>> = OnceLock::new();
    INDEX.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn snapshots_root() -> PathBuf {
    crate::utils::env_utils::get_claude_config_home_dir().join("web-snapshots")
}

pub fn save_nyan(page: &FetchedPage) -> Result<Snapshot, std::io::Error> {
    let hash = sha256_hex(&page.raw_body);
    let metadata = SnapshotMetadata {
        url: page.original_url.clone(),
        final_url: page.final_url.clone(),
        redirects: page.redirects.iter().map(|hop| hop.to.clone()).collect(),
        status: page.status,
        content_type: page.content_type.clone(),
        fetched_at: page.fetched_at,
        fetched_by: "nyan".to_string(),
        sha256: hash.clone(),
        bytes: page.raw_body.len(),
        provider_format: None,
        freshness: None,
    };
    save(metadata, page.text.clone(), &page.original_url, &hash)
}

pub fn save_provider(input: ProviderSnapshotInput) -> Result<Snapshot, std::io::Error> {
    let hash = sha256_hex(input.text.as_bytes());
    let metadata = SnapshotMetadata {
        url: input.url.clone(),
        final_url: input.final_url,
        redirects: Vec::new(),
        status: input.status,
        content_type: input.content_type,
        fetched_at: input.fetched_at,
        fetched_by: input.fetched_by,
        sha256: hash.clone(),
        bytes: input.text.len(),
        provider_format: Some(input.provider_format),
        freshness: input.freshness,
    };
    save(metadata, input.text, &input.url, &hash)
}

fn save(
    metadata: SnapshotMetadata,
    text: String,
    index_url: &str,
    hash: &str,
) -> Result<Snapshot, std::io::Error> {
    let root = snapshots_root();
    ensure_private_dir(&root)?;
    let hash_dir = root.join(&hash[..2]);
    ensure_private_dir(&hash_dir)?;
    let path = hash_dir.join(format!("{hash}.md"));
    if !path.exists() {
        let temp = hash_dir.join(format!(".{hash}.tmp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&temp, serialize_snapshot(&metadata, &text))?;
        set_private_file_permissions(&temp);
        std::fs::rename(&temp, &path)?;
        set_private_file_permissions(&path);
    }
    if let Ok(mut entries) = index().lock() {
        let key = normalize_index_url(index_url);
        entries.insert(
            key,
            UrlIndexEntry {
                hash: hash.to_string(),
                fetched_at: metadata.fetched_at,
            },
        );
    }
    Ok(Snapshot {
        hash: hash.to_string(),
        metadata,
        text,
        path,
    })
}

pub fn lookup_latest(url: &str) -> Option<Snapshot> {
    let key = normalize_index_url(url);
    let entry = index().lock().ok()?.get(&key).cloned()?;
    let age = Utc::now().signed_duration_since(entry.fetched_at);
    if age < chrono::Duration::zero() || age.to_std().ok()? > INDEX_TTL {
        return None;
    }
    read(&entry.hash).ok()
}

pub fn read(hash: &str) -> Result<Snapshot, std::io::Error> {
    if hash.len() < 2 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid snapshot hash",
        ));
    }
    let path = snapshots_root().join(&hash[..2]).join(format!("{hash}.md"));
    let content = std::fs::read_to_string(&path)?;
    let (metadata, text) = parse_snapshot(&content).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid snapshot metadata")
    })?;
    Ok(Snapshot {
        hash: hash.to_string(),
        metadata,
        text,
        path,
    })
}

pub fn clear_index() {
    if let Ok(mut entries) = index().lock() {
        entries.clear();
    }
}

pub fn cleanup_retention(days: u32) -> Result<usize, std::io::Error> {
    let root = snapshots_root();
    if !root.exists() {
        return Ok(0);
    }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(u64::from(days) * 24 * 60 * 60))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let mut removed = 0;
    for prefix in std::fs::read_dir(&root)? {
        let prefix = prefix?;
        if !prefix.file_type()?.is_dir() || prefix.file_name() == "tmp" {
            continue;
        }
        for file in std::fs::read_dir(prefix.path())? {
            let file = file?;
            if !file.file_type()?.is_file() {
                continue;
            }
            if file
                .metadata()?
                .modified()
                .is_ok_and(|modified| modified < cutoff)
            {
                std::fs::remove_file(file.path())?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

pub fn parse_range(spec: Option<&str>) -> Result<Option<RangeSpec>, RangeError> {
    let Some(spec) = spec.filter(|spec| !spec.is_empty()) else {
        return Ok(None);
    };
    if let Some(chars) = spec.strip_prefix("chars:") {
        let (start, end) = chars.split_once('-').ok_or(RangeError::Invalid)?;
        let start = start.parse::<usize>().map_err(|_| RangeError::Invalid)?;
        let end = if end.is_empty() {
            None
        } else {
            Some(end.parse::<usize>().map_err(|_| RangeError::Invalid)?)
        };
        if end.is_some_and(|end| start > end) {
            return Err(RangeError::Invalid);
        }
        return Ok(Some(RangeSpec::Chars { start, end }));
    }
    if let Some(section) = spec.strip_prefix('#').filter(|value| !value.is_empty()) {
        return Ok(Some(RangeSpec::Section(section.to_string())));
    }
    Err(RangeError::Invalid)
}

pub fn select_range(
    text: &str,
    spec: Option<&RangeSpec>,
    max_chars: usize,
) -> Result<SelectedRange, RangeError> {
    let chars = text.chars().collect::<Vec<_>>();
    let total = chars.len();
    let (start, end, section) = match spec {
        None => (0, total, None),
        Some(RangeSpec::Chars { start, end }) => {
            if *start >= total && total != 0 {
                return Err(RangeError::OutOfBounds(total));
            }
            if *start > total {
                return Err(RangeError::OutOfBounds(total));
            }
            let end = end.unwrap_or(total).min(total);
            (*start, end, None)
        }
        Some(RangeSpec::Section(requested)) => section_bounds(text, requested)?,
    };
    let capped_end = start.saturating_add(max_chars).min(end);
    Ok(SelectedRange {
        text: chars[start..capped_end].iter().collect(),
        start,
        end: capped_end,
        total,
        section,
    })
}

fn section_bounds(
    text: &str,
    requested: &str,
) -> Result<(usize, usize, Option<String>), RangeError> {
    let mut headings = Vec::new();
    let mut candidates = Vec::new();
    let mut char_offset = 0usize;
    for line in text.split_inclusive('\n') {
        let without_newline = line.trim_end_matches(['\r', '\n']);
        let bytes = without_newline.as_bytes();
        let level = bytes.iter().take_while(|byte| **byte == b'#').count();
        if (1..=6).contains(&level) && bytes.get(level) == Some(&b' ') {
            let title = without_newline[level + 1..].trim().to_string();
            headings.push(title.clone());
            candidates.push((slug(&title), title, level, char_offset));
        }
        char_offset += line.chars().count();
    }
    let requested_slug = slug(requested);
    let selected = candidates
        .iter()
        .find(|(candidate, _, _, _)| candidate == &requested_slug)
        .or_else(|| {
            let lowered = requested.to_lowercase();
            candidates
                .iter()
                .find(|(_, title, _, _)| title.to_lowercase().contains(&lowered))
        });
    let Some((_, title, level, start)) = selected else {
        return Err(RangeError::SectionNotFound {
            requested: requested.to_string(),
            headings: headings.into_iter().take(30).collect(),
        });
    };
    let end = candidates
        .iter()
        .filter(|(_, _, other_level, other_start)| *other_start > *start && *other_level <= *level)
        .map(|(_, _, _, other_start)| *other_start)
        .next()
        .unwrap_or_else(|| text.chars().count());
    Ok((*start, end, Some(title.clone())))
}

fn slug(value: &str) -> String {
    let mut result = String::new();
    let mut pending_dash = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if pending_dash && !result.is_empty() {
                result.push('-');
            }
            pending_dash = false;
            result.push(character);
        } else if !result.is_empty() {
            pending_dash = true;
        }
    }
    result
}

fn normalize_index_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    if parsed.scheme() == "http" {
        let _ = parsed.set_scheme("https");
    }
    parsed.set_fragment(None);
    parsed.to_string()
}

fn sha256_hex(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn serialize_snapshot(metadata: &SnapshotMetadata, text: &str) -> String {
    let redirects = serde_json::to_string(&metadata.redirects).unwrap_or_else(|_| "[]".to_string());
    let provider_format = metadata.provider_format.as_deref().unwrap_or("");
    let freshness = metadata.freshness.as_deref().unwrap_or("");
    format!(
        "url: {}\nfinal_url: {}\nredirects: {}\nstatus: {}\ncontent_type: {}\nfetched_at: {}\nfetched_by: {}\nsha256: {}\nbytes: {}\nprovider_format: {}\nfreshness: {}\n\n{}",
        header_value(&metadata.url),
        header_value(&metadata.final_url),
        redirects,
        metadata.status,
        header_value(&metadata.content_type),
        metadata.fetched_at.to_rfc3339(),
        header_value(&metadata.fetched_by),
        metadata.sha256,
        metadata.bytes,
        header_value(provider_format),
        header_value(freshness),
        text,
    )
}

fn header_value(value: &str) -> String {
    value.replace('\n', "%0A").replace('\r', "%0D")
}

fn parse_snapshot(value: &str) -> Option<(SnapshotMetadata, String)> {
    let (header, text) = value.split_once("\n\n")?;
    let mut fields = HashMap::new();
    for line in header.lines() {
        let (key, value) = line.split_once(": ")?;
        fields.insert(key, value);
    }
    let redirects = serde_json::from_str(fields.get("redirects")?).ok()?;
    Some((
        SnapshotMetadata {
            url: fields.get("url")?.to_string(),
            final_url: fields.get("final_url")?.to_string(),
            redirects,
            status: fields.get("status")?.parse().ok()?,
            content_type: fields.get("content_type")?.to_string(),
            fetched_at: fields.get("fetched_at")?.parse().ok()?,
            fetched_by: fields.get("fetched_by")?.to_string(),
            sha256: fields.get("sha256")?.to_string(),
            bytes: fields.get("bytes")?.parse().ok()?,
            provider_format: non_empty(fields.get("provider_format").copied()),
            freshness: non_empty(fields.get("freshness").copied()),
        },
        text.to_string(),
    ))
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|value| !value.is_empty()).map(str::to_string)
}

fn ensure_private_dir(path: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unicode_ranges_without_splitting_scalars() {
        let spec = parse_range(Some("chars:1-3")).unwrap().unwrap();
        let selected = select_range("a🙂中b", Some(&spec), 40).unwrap();
        assert_eq!(selected.text, "🙂中");
        assert_eq!(selected.total, 4);
    }

    #[test]
    fn range_errors_are_named_and_half_open() {
        assert_eq!(parse_range(Some("chars:4-2")), Err(RangeError::Invalid));
        let spec = parse_range(Some("chars:10-")).unwrap().unwrap();
        assert_eq!(
            select_range("abc", Some(&spec), 20),
            Err(RangeError::OutOfBounds(3))
        );
        assert_eq!(parse_range(Some("chars:nope")), Err(RangeError::Invalid));
    }

    #[test]
    fn section_selection_matches_slug_then_substring_and_stops_at_same_level() {
        let page =
            "# Intro\nintro text\n## API Reference\napi text\n### Detail\ndetail\n## Next\nnext";
        let spec = parse_range(Some("#api-reference")).unwrap().unwrap();
        let selected = select_range(page, Some(&spec), 100).unwrap();
        assert_eq!(
            selected.text,
            "## API Reference\napi text\n### Detail\ndetail\n"
        );
        let substring = parse_range(Some("#reference")).unwrap().unwrap();
        assert_eq!(
            select_range(page, Some(&substring), 100).unwrap().section,
            Some("API Reference".to_string())
        );
    }

    #[test]
    fn section_not_found_lists_at_most_thirty_headings() {
        let page = (0..40).map(|i| format!("# H{i}\n")).collect::<String>();
        let spec = RangeSpec::Section("missing".to_string());
        let error = select_range(&page, Some(&spec), 100).unwrap_err();
        assert!(
            matches!(error, RangeError::SectionNotFound { headings, .. } if headings.len() == 30)
        );
    }

    #[test]
    fn snapshot_serialization_round_trips_metadata_and_text() {
        let metadata = SnapshotMetadata {
            url: "https://example.com".to_string(),
            final_url: "https://example.com/docs".to_string(),
            redirects: vec!["https://example.com/docs".to_string()],
            status: 200,
            content_type: "text/html".to_string(),
            fetched_at: Utc::now(),
            fetched_by: "nyan".to_string(),
            sha256: "a".repeat(64),
            bytes: 12,
            provider_format: None,
            freshness: None,
        };
        let encoded = serialize_snapshot(&metadata, "# title\nbody");
        let (decoded, text) = parse_snapshot(&encoded).unwrap();
        assert_eq!(decoded, metadata);
        assert_eq!(text, "# title\nbody");
    }
}
