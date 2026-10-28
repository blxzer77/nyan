//! Local, rebuildable retrieval index. It stores metadata, symbol ranges and
//! token postings under the config directory; source text is always read from
//! the active worktree during Inspect.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::utils::permissions::filesystem::read_deny_rg_globs;

use super::inspect::hex_hash;
use super::outcome::{Branch, Candidate};

const INDEX_SCHEMA_VERSION: &str = "nyan-retrieval-index-v1";
const MAX_CHUNK_LINES: usize = 60;
const MAX_CHUNK_TOKENS: usize = 400;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IndexState {
    Ready,
    Building,
    Rebuilding,
}

#[derive(Clone, Debug, Default)]
pub struct SkipCounts {
    pub binary: usize,
    pub too_large: usize,
    pub sensitive: usize,
    pub denied: usize,
    pub unsupported: usize,
}

impl SkipCounts {
    pub fn total(&self) -> usize {
        self.binary + self.too_large + self.sensitive + self.denied + self.unsupported
    }
}

#[derive(Clone, Debug)]
pub struct LocalIndex {
    root: PathBuf,
    storage: PathBuf,
    files: Vec<IndexedFile>,
    pub state: IndexState,
    pub skipped: SkipCounts,
    pub generation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistedIndex {
    schema: String,
    generation: String,
    files: Vec<IndexedFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IndexedFile {
    pub path: String,
    pub file_hash_raw: String,
    pub size: u64,
    pub mtime_ms: u128,
    pub language: String,
    pub symbol_checked: bool,
    pub symbols: Vec<SymbolRecord>,
    pub chunks: Vec<ChunkRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SymbolRecord {
    pub name: String,
    pub kind: String,
    pub start_line: usize,
    pub end_line: usize,
    pub parent: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChunkRecord {
    pub start_line: usize,
    pub end_line: usize,
    pub symbol: Option<String>,
    pub tokens: Vec<String>,
}

struct IndexLock {
    path: PathBuf,
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl LocalIndex {
    pub fn open(
        root: impl Into<PathBuf>,
        max_file_bytes: u64,
        permission_context: &crate::tool::ToolPermissionContext,
    ) -> Result<Self, String> {
        let root = root
            .into()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let storage = crate::utils::session_storage::get_project_dir(&root.to_string_lossy())
            .join("retrieval");
        std::fs::create_dir_all(&storage).map_err(|error| error.to_string())?;
        let generation = generation_for(&root, max_file_bytes);
        let persisted = load_persisted(&storage);
        let state = match persisted.as_ref() {
            Some(index) if index.generation == generation => IndexState::Ready,
            Some(_) => IndexState::Rebuilding,
            None => IndexState::Building,
        };
        let previous = persisted.filter(|index| index.generation == generation);
        let lock = acquire_lock(&storage);
        let files = refresh_files(
            &root,
            max_file_bytes,
            permission_context,
            previous.as_ref().map(|index| index.files.as_slice()),
        )?;
        let index = Self {
            root,
            storage,
            files,
            state,
            skipped: SkipCounts::default(),
            generation,
        };
        if lock.is_some() {
            index.persist()?;
        }
        Ok(index)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn storage(&self) -> &Path {
        &self.storage
    }

    pub fn files(&self) -> &[IndexedFile] {
        &self.files
    }

    pub fn search_symbols(
        &self,
        query: &str,
        relation_query: bool,
        max_results: usize,
    ) -> Vec<Candidate> {
        let query_tokens = identifier_tokens(query);
        if query_tokens.is_empty() {
            return Vec::new();
        }
        let query_lower = query.to_ascii_lowercase();
        let mut results = Vec::new();
        for file in &self.files {
            for symbol in &file.symbols {
                let name_lower = symbol.name.to_ascii_lowercase();
                let exact = name_lower == query_lower
                    || normalize_identifier(&symbol.name) == normalize_identifier(query);
                let token_match = query_tokens.iter().all(|token| name_lower.contains(token));
                if exact || token_match {
                    results.push(Candidate {
                        branch: Branch::Symbol,
                        path: file.path.clone(),
                        start_line: symbol.start_line,
                        end_line: symbol.end_line,
                        symbol: Some(symbol.name.clone()),
                        file_hash_raw: file.file_hash_raw.clone(),
                        no_symbol_check: !file.symbol_checked,
                        ..Candidate::default()
                    });
                }
            }
            if relation_query {
                let text = match std::fs::read_to_string(self.root.join(&file.path)) {
                    Ok(text) => text,
                    Err(_) => continue,
                };
                for (line_index, line) in text.lines().enumerate() {
                    if query_tokens
                        .iter()
                        .all(|token| line.to_ascii_lowercase().contains(token))
                        && !file
                            .symbols
                            .iter()
                            .any(|symbol| symbol.start_line == line_index + 1)
                    {
                        results.push(Candidate {
                            branch: Branch::Symbol,
                            path: file.path.clone(),
                            start_line: line_index + 1,
                            end_line: line_index + 1,
                            file_hash_raw: file.file_hash_raw.clone(),
                            no_symbol_check: !file.symbol_checked,
                            ..Candidate::default()
                        });
                    }
                }
            }
        }
        results.sort_by(|left, right| {
            left.path
                .as_bytes()
                .cmp(right.path.as_bytes())
                .then_with(|| left.start_line.cmp(&right.start_line))
                .then_with(|| left.end_line.cmp(&right.end_line))
        });
        results.truncate(max_results);
        for (index, candidate) in results.iter_mut().enumerate() {
            candidate.rank = index + 1;
        }
        results
    }

    pub fn search_text(&self, query: &str, max_results: usize) -> Vec<Candidate> {
        let query_tokens = natural_tokens(query);
        if query_tokens.is_empty() {
            return Vec::new();
        }
        let mut scored = Vec::new();
        for file in &self.files {
            let document = match std::fs::read_to_string(self.root.join(&file.path)) {
                Ok(text) => text,
                Err(_) => continue,
            };
            let document_tokens = natural_tokens(&document);
            let document_set = document_tokens.iter().collect::<BTreeSet<_>>();
            let mut score = 0.0;
            for token in &query_tokens {
                if document_set.contains(token) {
                    score += 1.0;
                }
            }
            if score == 0.0 {
                continue;
            }
            let best_chunk = file
                .chunks
                .iter()
                .filter_map(|chunk| {
                    let overlap = query_tokens
                        .iter()
                        .filter(|token| chunk.tokens.contains(token))
                        .count() as f64;
                    (overlap > 0.0).then_some((overlap, chunk))
                })
                .max_by(|(left_score, left), (right_score, right)| {
                    left_score
                        .partial_cmp(right_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| right.start_line.cmp(&left.start_line))
                });
            let Some((chunk_score, chunk)) = best_chunk else {
                continue;
            };
            scored.push((score + chunk_score, file, chunk));
        }
        scored.sort_by(
            |(left_score, left_file, left_chunk), (right_score, right_file, right_chunk)| {
                right_score
                    .partial_cmp(left_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| left_file.path.as_bytes().cmp(right_file.path.as_bytes()))
                    .then_with(|| left_chunk.start_line.cmp(&right_chunk.start_line))
            },
        );
        scored
            .into_iter()
            .take(max_results)
            .enumerate()
            .map(|(index, (_, file, chunk))| Candidate {
                branch: Branch::Text,
                path: file.path.clone(),
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                symbol: chunk.symbol.clone(),
                file_hash_raw: file.file_hash_raw.clone(),
                rank: index + 1,
                no_symbol_check: !file.symbol_checked,
                ..Candidate::default()
            })
            .collect()
    }

    fn persist(&self) -> Result<(), String> {
        let value = PersistedIndex {
            schema: INDEX_SCHEMA_VERSION.to_string(),
            generation: self.generation.clone(),
            files: self.files.clone(),
        };
        let temporary = self.storage.join("index.json.tmp");
        let final_path = self.storage.join("index.json");
        std::fs::write(
            &temporary,
            serde_json::to_vec(&value).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        std::fs::rename(temporary, final_path).map_err(|error| error.to_string())
    }
}

fn load_persisted(storage: &Path) -> Option<PersistedIndex> {
    let bytes = std::fs::read(storage.join("index.json")).ok()?;
    let index: PersistedIndex = serde_json::from_slice(&bytes).ok()?;
    (index.schema == INDEX_SCHEMA_VERSION).then_some(index)
}

fn acquire_lock(storage: &Path) -> Option<IndexLock> {
    let path = storage.join("index.lock");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .ok()
        .map(|_| IndexLock { path })
}

fn refresh_files(
    root: &Path,
    max_file_bytes: u64,
    permission_context: &crate::tool::ToolPermissionContext,
    previous: Option<&[IndexedFile]>,
) -> Result<Vec<IndexedFile>, String> {
    let deny_patterns = read_deny_rg_globs(permission_context, root, root);
    let previous = previous
        .unwrap_or_default()
        .iter()
        .map(|file| (file.path.clone(), file))
        .collect::<HashMap<_, _>>();
    let mut files = Vec::new();
    let mut walker = WalkBuilder::new(root);
    walker
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .follow_links(false);
    for entry in walker.build().filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(relative) = path.strip_prefix(root).ok() else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.starts_with(".git/")
            || sensitive_path(&relative)
            || denied_path(&relative, path, &deny_patterns)
        {
            continue;
        }
        let Ok(metadata) = std::fs::metadata(path) else {
            continue;
        };
        if metadata.len() > max_file_bytes {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        if bytes[..bytes.len().min(8192)].contains(&0) {
            continue;
        }
        let hash = hex_hash(&bytes);
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_millis());
        if let Some(existing) = previous.get(&relative) {
            if existing.file_hash_raw == hash
                && existing.size == metadata.len()
                && existing.mtime_ms == mtime_ms
            {
                files.push((*existing).clone());
                continue;
            }
        }
        let text = String::from_utf8_lossy(&bytes);
        let language = language_for(&relative);
        let symbol_checked = supports_symbols(&language);
        let symbols = if symbol_checked {
            parse_symbols(&text, &language)
        } else {
            Vec::new()
        };
        let chunks = make_chunks(&text, &symbols, symbol_checked);
        files.push(IndexedFile {
            path: relative,
            file_hash_raw: hash,
            size: metadata.len(),
            mtime_ms,
            language,
            symbol_checked,
            symbols,
            chunks,
        });
    }
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    Ok(files)
}

fn denied_path(relative: &str, absolute: &Path, patterns: &[String]) -> bool {
    let absolute = absolute.to_string_lossy();
    patterns.iter().any(|pattern| {
        let pattern = pattern.trim_start_matches('!');
        let matches_glob = globset::Glob::new(pattern)
            .ok()
            .and_then(|glob| glob.compile_matcher().is_match(relative).then_some(()))
            .is_some()
            || globset::Glob::new(pattern)
                .ok()
                .and_then(|glob| {
                    glob.compile_matcher()
                        .is_match(absolute.as_ref())
                        .then_some(())
                })
                .is_some();
        matches_glob
            || relative == pattern.trim_start_matches("**/")
            || relative.ends_with(&format!("/{}", pattern.trim_start_matches("**/")))
    })
}

fn sensitive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let basename = lower.rsplit('/').next().unwrap_or(&lower);
    basename == ".env"
        || basename.starts_with(".env.")
        || basename.ends_with(".pem")
        || basename.ends_with(".key")
        || basename.ends_with(".p12")
        || basename == "id_rsa"
        || basename == "id_ed25519"
        || lower.contains("private_key")
        || lower.contains("private-key")
}

fn language_for(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".rs") {
        "rust"
    } else if lower.ends_with(".ts") || lower.ends_with(".tsx") {
        "typescript"
    } else if lower.ends_with(".js") || lower.ends_with(".jsx") {
        "javascript"
    } else if lower.ends_with(".py") {
        "python"
    } else if lower.ends_with(".go") {
        "go"
    } else if lower.ends_with(".java") {
        "java"
    } else if lower.ends_with(".c")
        || lower.ends_with(".h")
        || lower.ends_with(".cc")
        || lower.ends_with(".cpp")
        || lower.ends_with(".hpp")
    {
        "cpp"
    } else if lower.ends_with(".sh") || lower.ends_with(".bash") {
        "bash"
    } else if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "markdown"
    } else {
        "unknown"
    }
    .to_string()
}

fn supports_symbols(language: &str) -> bool {
    matches!(
        language,
        "rust"
            | "typescript"
            | "javascript"
            | "python"
            | "go"
            | "java"
            | "cpp"
            | "bash"
            | "markdown"
    )
}

fn parse_symbols(text: &str, language: &str) -> Vec<SymbolRecord> {
    let lines = text.lines().collect::<Vec<_>>();
    let mut symbols = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        let (kind, name) = if language == "markdown" {
            let hashes = trimmed
                .chars()
                .take_while(|character| *character == '#')
                .count();
            (hashes > 0)
                .then(|| ("heading".to_string(), trimmed[hashes..].trim().to_string()))
                .unwrap_or_else(|| {
                    (false)
                        .then(|| (String::new(), String::new()))
                        .unwrap_or_default()
                })
        } else {
            symbol_from_line(trimmed, language)
        };
        if name.is_empty() {
            continue;
        }
        let end_line = find_symbol_end(&lines, index, language, indent);
        symbols.push(SymbolRecord {
            name,
            kind,
            start_line: index + 1,
            end_line,
            parent: None,
        });
    }
    symbols
}

fn symbol_from_line(line: &str, language: &str) -> (String, String) {
    let line = line
        .strip_prefix("pub ")
        .or_else(|| line.strip_prefix("export "))
        .or_else(|| line.strip_prefix("async "))
        .unwrap_or(line);
    let patterns: &[(&str, &str)] = match language {
        "rust" => &[
            ("fn ", "function"),
            ("struct ", "struct"),
            ("enum ", "enum"),
            ("trait ", "trait"),
            ("impl ", "impl"),
            ("mod ", "module"),
            ("type ", "type"),
            ("const ", "const"),
        ],
        "typescript" | "javascript" => &[
            ("function ", "function"),
            ("class ", "class"),
            ("interface ", "interface"),
            ("type ", "type"),
            ("const ", "const"),
            ("let ", "variable"),
        ],
        "python" => &[
            ("def ", "function"),
            ("async def ", "function"),
            ("class ", "class"),
        ],
        "go" => &[("func ", "function"), ("type ", "type")],
        "java" | "cpp" => &[
            ("class ", "class"),
            ("struct ", "struct"),
            ("interface ", "interface"),
            ("enum ", "enum"),
            ("void ", "function"),
            ("int ", "function"),
        ],
        "bash" => &[("function ", "function")],
        _ => &[],
    };
    if language == "go" {
        if let Some(rest) = line.strip_prefix("func ") {
            let rest = if rest.starts_with('(') {
                rest.split_once(')')
                    .map_or(rest, |(_, remainder)| remainder.trim_start())
            } else {
                rest
            };
            let name = rest
                .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
                .next()
                .unwrap_or_default();
            if !name.is_empty() {
                return ("function".to_string(), name.to_string());
            }
        }
    }
    for (prefix, kind) in patterns {
        if let Some(rest) = line.strip_prefix(prefix) {
            let name = rest
                .trim_start_matches(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '_'
                })
                .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
                .next()
                .unwrap_or_default();
            if !name.is_empty() {
                return ((*kind).to_string(), name.to_string());
            }
        }
    }
    if language == "bash" && line.ends_with("() {") {
        let name = line.trim_end_matches("() {").trim();
        if !name.is_empty() {
            return ("function".to_string(), name.to_string());
        }
    }
    (String::new(), String::new())
}

fn find_symbol_end(lines: &[&str], start: usize, language: &str, indent: usize) -> usize {
    if language == "markdown" {
        let level = lines[start]
            .trim_start()
            .chars()
            .take_while(|character| *character == '#')
            .count();
        for (index, line) in lines.iter().enumerate().skip(start + 1) {
            let other = line
                .trim_start()
                .chars()
                .take_while(|character| *character == '#')
                .count();
            if other > 0 && other <= level {
                return index;
            }
        }
        return lines.len();
    }
    let mut depth = 0i32;
    let mut saw_brace = false;
    for (index, line) in lines.iter().enumerate().skip(start) {
        for character in line.chars() {
            if character == '{' {
                depth += 1;
                saw_brace = true;
            }
            if character == '}' {
                depth -= 1;
            }
        }
        if saw_brace && depth <= 0 {
            return index + 1;
        }
        if index > start
            && !saw_brace
            && !line.trim().is_empty()
            && line.len() - line.trim_start().len() <= indent
        {
            return index;
        }
    }
    lines.len().max(start + 1)
}

fn make_chunks(text: &str, symbols: &[SymbolRecord], symbol_checked: bool) -> Vec<ChunkRecord> {
    let lines = text.lines().collect::<Vec<_>>();
    if lines.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    if symbol_checked {
        for symbol in symbols {
            ranges.push((
                symbol.start_line,
                symbol.end_line,
                Some(symbol.name.clone()),
            ));
        }
    }
    if ranges.is_empty() {
        let mut start = 1;
        while start <= lines.len() {
            let end = (start + MAX_CHUNK_LINES - 1).min(lines.len());
            ranges.push((start, end, None));
            start = end + 1;
        }
    }
    let mut chunks = Vec::new();
    for (start, end, symbol) in ranges {
        if end < start {
            continue;
        }
        let mut cursor = start;
        while cursor <= end {
            let sub_end = (cursor + MAX_CHUNK_LINES - 1).min(end);
            let content = lines[cursor - 1..sub_end].join("\n");
            let mut tokens = natural_tokens(&content);
            if tokens.len() > MAX_CHUNK_TOKENS {
                tokens.truncate(MAX_CHUNK_TOKENS);
            }
            chunks.push(ChunkRecord {
                start_line: cursor,
                end_line: sub_end,
                symbol: symbol.clone(),
                tokens,
            });
            cursor = sub_end + 1;
        }
    }
    chunks
}

pub fn natural_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for raw in text.split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
    {
        if raw.is_empty() {
            continue;
        }
        let split = split_identifier(raw);
        if split.is_empty() {
            tokens.push(raw.to_ascii_lowercase());
        } else {
            tokens.extend(split);
        }
    }
    tokens
}

pub fn identifier_tokens(text: &str) -> Vec<String> {
    split_identifier(text)
}

fn split_identifier(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if character == '_' || character == '-' {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else if character.is_ascii_uppercase() && !current.is_empty() {
            words.push(std::mem::take(&mut current));
            current.push(character.to_ascii_lowercase());
        } else if character.is_ascii_alphanumeric() {
            current.push(character.to_ascii_lowercase());
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn normalize_identifier(value: &str) -> String {
    identifier_tokens(value).join("")
}

fn generation_for(root: &Path, max_file_bytes: u64) -> String {
    let canonical = serde_json::json!({
        "schema": INDEX_SCHEMA_VERSION,
        "chunkerVersion": "line-symbol-v1",
        "maxFileBytes": max_file_bytes,
        "worktree": root.to_string_lossy(),
    });
    Sha256::digest(canonical.to_string().as_bytes())
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_env::{EnvVarGuard, TEST_ENV_LOCK};

    #[test]
    fn tokenization_handles_snake_camel_and_natural_language() {
        assert_eq!(
            identifier_tokens("autoCompactIfNeeded"),
            vec!["auto", "compact", "if", "needed"]
        );
        assert!(natural_tokens("auto compact if needed").contains(&"compact".to_string()));
    }

    #[test]
    fn sensitive_paths_are_skipped() {
        assert!(sensitive_path(".env"));
        assert!(sensitive_path("keys/id_rsa"));
        assert!(!sensitive_path("src/main.rs"));
    }

    #[test]
    fn index_lives_under_config_projects_not_worktree() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let root =
            std::env::temp_dir().join(format!("nyan-index-{}", uuid::Uuid::new_v4().simple()));
        let config = root.join("config");
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("lib.rs"), "fn hello() {}\n").unwrap();
        let _config = EnvVarGuard::set("CLAUDE_CONFIG_DIR", &config);
        let index = LocalIndex::open(
            &project,
            1_048_576,
            &crate::tool::ToolPermissionContext::default(),
        )
        .unwrap();
        assert!(index.storage().starts_with(&config));
        assert!(!index.storage().starts_with(&project));
        let _ = std::fs::remove_dir_all(root);
    }
}
