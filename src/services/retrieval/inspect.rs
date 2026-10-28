use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::outcome::Candidate;

#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedCandidate {
    pub candidate: Candidate,
    pub snippet: String,
}

/// Re-read and hash a candidate before it can enter the result. Indexes carry
/// ranges and hashes only; no indexed source text is trusted here.
pub fn inspect_candidate(root: &Path, candidate: &Candidate) -> Result<VerifiedCandidate, String> {
    let relative = normalize_relative_path(&candidate.path)?;
    let absolute = root.join(&relative);
    let root = root
        .canonicalize()
        .map_err(|error| format!("root unavailable: {error}"))?;
    let canonical = absolute
        .canonicalize()
        .map_err(|error| format!("file unavailable: {error}"))?;
    if !canonical.starts_with(&root) {
        return Err("path outside worktree".to_string());
    }
    let bytes = std::fs::read(&canonical).map_err(|error| error.to_string())?;
    let hash = hex_hash(&bytes);
    if !candidate.file_hash_raw.is_empty() && candidate.file_hash_raw != hash {
        return Err("file changed since indexing".to_string());
    }
    let text = String::from_utf8(bytes).map_err(|_| "binary or invalid UTF-8 file".to_string())?;
    let lines = text.lines().collect::<Vec<_>>();
    if candidate.start_line == 0
        || candidate.end_line < candidate.start_line
        || candidate.end_line > lines.len()
    {
        return Err("line range no longer exists".to_string());
    }
    let snippet = lines[candidate.start_line - 1..candidate.end_line].join("\n");
    let mut verified = candidate.clone();
    verified.file_hash_raw = hash;
    verified.snippet = Some(snippet.clone());
    Ok(VerifiedCandidate {
        candidate: verified,
        snippet,
    })
}

pub fn normalize_relative_path(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Err("absolute candidate path".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir => return Err("candidate path escapes worktree".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute candidate path".to_string());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("empty candidate path".to_string());
    }
    Ok(normalized)
}

pub fn hex_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_cannot_escape_and_hashes_are_raw_byte_hashes() {
        assert!(normalize_relative_path("../secret").is_err());
        assert!(normalize_relative_path("/tmp/secret").is_err());
        assert_eq!(
            hex_hash(b"nyan"),
            "f55b080c8b804ab13085ab5773040b6f5627bc09b27665c9be9410f095af20f8"
        );
    }
}
