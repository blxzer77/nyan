use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::tool::AbortController;
use crate::utils::permissions::filesystem::read_deny_rg_globs;
use crate::utils::ripgrep::rip_grep_detailed;

use super::inspect::hex_hash;
use super::outcome::{Branch, Candidate, SearchRequest};

const MAX_BRANCH_CANDIDATES: usize = 50;
const MAX_PER_FILE: usize = 3;

pub fn search_exact(
    root: &Path,
    request: &SearchRequest,
    abort: &AbortController,
    permission_context: &crate::tool::ToolPermissionContext,
) -> Result<Vec<Candidate>, String> {
    let search_root = request
        .path
        .as_deref()
        .map(|path| crate::utils::path::expand_path(path, Some(root)))
        .transpose()?
        .unwrap_or_else(|| root.to_path_buf());
    if !search_root.starts_with(root) {
        return Err("search path is outside worktree".to_string());
    }
    let variants = query_variants(&request.query);
    let mut args = vec![
        "--hidden".to_string(),
        "--no-heading".to_string(),
        "--color=never".to_string(),
        "--line-number".to_string(),
        "--with-filename".to_string(),
        "--fixed-strings".to_string(),
        "--sort=path".to_string(),
    ];
    for directory in [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] {
        args.extend(["--glob".to_string(), format!("!{directory}")]);
    }
    if let Some(glob) = request.glob.as_deref().filter(|value| !value.is_empty()) {
        args.extend(["--glob".to_string(), glob.to_string()]);
    }
    for pattern in read_deny_rg_globs(permission_context, root, &search_root) {
        args.extend(["--glob".to_string(), format!("!{pattern}")]);
    }
    for variant in variants {
        args.extend(["-e".to_string(), variant]);
    }

    let run = rip_grep_detailed(&args, &search_root, abort)?;
    let mut candidates = Vec::new();
    let mut per_file = std::collections::HashMap::<String, usize>::new();
    let mut seen = BTreeSet::new();
    for line in run.lines {
        let Some((path, line_number, _text)) = parse_rg_line(&line) else {
            continue;
        };
        let absolute = if Path::new(&path).is_absolute() {
            PathBuf::from(&path)
        } else {
            search_root.join(&path)
        };
        let Ok(relative) = absolute
            .canonicalize()
            .ok()
            .and_then(|path| {
                path.strip_prefix(root.canonicalize().ok()?)
                    .ok()
                    .map(Path::to_path_buf)
            })
            .ok_or(())
        else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let count = per_file.entry(relative.clone()).or_default();
        if *count >= MAX_PER_FILE {
            continue;
        }
        let key = (relative.clone(), line_number);
        if !seen.insert(key) {
            continue;
        }
        let bytes = match std::fs::read(root.join(&relative)) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        *count += 1;
        candidates.push(Candidate {
            branch: Branch::Exact,
            path: relative,
            start_line: line_number,
            end_line: line_number,
            file_hash_raw: hex_hash(&bytes),
            rank: candidates.len() + 1,
            ..Candidate::default()
        });
        if candidates.len() >= MAX_BRANCH_CANDIDATES {
            break;
        }
    }
    candidates.sort_by(|left, right| {
        left.path
            .as_bytes()
            .cmp(right.path.as_bytes())
            .then_with(|| left.start_line.cmp(&right.start_line))
    });
    for (index, candidate) in candidates.iter_mut().enumerate() {
        candidate.rank = index + 1;
    }
    Ok(candidates)
}

fn parse_rg_line(line: &str) -> Option<(String, usize, &str)> {
    let mut parts = line.splitn(3, ':');
    let path = parts.next()?.to_string();
    let line_number = parts.next()?.parse().ok()?;
    Some((path, line_number, parts.next().unwrap_or_default()))
}

pub fn query_variants(query: &str) -> Vec<String> {
    let mut variants = BTreeSet::new();
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    variants.insert(trimmed.to_string());
    let words = trimmed
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if words.len() > 1 {
        variants.insert(words.join("_"));
        variants.insert(
            words
                .iter()
                .enumerate()
                .map(|(index, word)| {
                    if index == 0 {
                        word.clone()
                    } else {
                        capitalize(word)
                    }
                })
                .collect(),
        );
        variants.insert(words.join(""));
    }
    variants.into_iter().collect()
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_variants_cover_snake_and_camel_identifiers() {
        let variants = query_variants("auto compact if needed");
        assert!(variants.contains(&"auto_compact_if_needed".to_string()));
        assert!(variants.contains(&"autoCompactIfNeeded".to_string()));
    }
}
