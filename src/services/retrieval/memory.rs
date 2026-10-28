use std::path::Path;

use crate::types::message::RelevantMemory;

use super::index::natural_tokens;

/// Library seam for memory M6. Memory retrieval is not a tool call: callers
/// inject the returned attachment through the existing `RelevantMemories`
/// attachment type.
pub fn search_memory_directory(query: &str, max_results: usize) -> Vec<RelevantMemory> {
    let root = crate::memdir::paths::get_auto_mem_path();
    let query_tokens = natural_tokens(query);
    if query_tokens.is_empty() || !root.is_dir() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    let Ok(entries) = walk_memory_files(&root) else {
        return Vec::new();
    };
    for path in entries {
        if path.file_name().and_then(|name| name.to_str()) == Some("MEMORY.md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let tokens = natural_tokens(&content);
        let score = query_tokens
            .iter()
            .filter(|token| tokens.contains(token))
            .count();
        if score == 0 {
            continue;
        }
        hits.push((score, path, content));
    }
    hits.sort_by(|(left_score, left_path, _), (right_score, right_path, _)| {
        right_score
            .cmp(left_score)
            .then_with(|| left_path.as_os_str().cmp(right_path.as_os_str()))
    });
    hits.into_iter()
        .take(max_results)
        .map(|(_, path, content)| RelevantMemory {
            path: path.to_string_lossy().to_string(),
            content,
            mtime_ms: std::fs::metadata(&path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64),
            header: None,
            limit: None,
        })
        .collect()
}

fn walk_memory_files(root: &Path) -> Result<Vec<std::path::PathBuf>, std::io::Error> {
    let mut files = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .hidden(false)
        .build()
        .filter_map(Result::ok)
    {
        if entry.path().is_file() {
            files.push(entry.into_path());
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_queries_do_not_read_memory() {
        assert!(search_memory_directory("", 10).is_empty());
    }
}
