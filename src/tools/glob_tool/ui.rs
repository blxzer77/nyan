//! UI-only port of official `tools/GlobTool/UI.tsx`.
//! Official Glob reuses Grep's result renderer while keeping Glob-specific
//! tool-use naming/summary elsewhere. Keep that ownership explicit instead of
//! folding Glob behavior into the UserToolResultMessage boundary.

use super::Output;
use crate::components::messages::user_tool_result_message::utils::{
    ToolRenderLine, ToolRenderOptions,
};
use crate::tools::grep_tool;
use crate::types::message::ToolResultStatus;

/// Maps to CC `tools/GlobTool/UI.tsx:12-14`.
pub fn user_facing_name() -> &'static str {
    "Search"
}

/// Maps to CC `tools/GlobTool/UI.tsx:16-29`.
pub fn render_tool_use_message(input: &serde_json::Value, verbose: bool) -> Option<String> {
    let pattern = input
        .get("pattern")
        .and_then(serde_json::Value::as_str)
        .filter(|pattern| !pattern.is_empty())?;
    let Some(path) = input
        .get("path")
        .and_then(serde_json::Value::as_str)
        .filter(|path| !path.is_empty())
    else {
        return Some(format!("pattern: \"{pattern}\""));
    };
    let path = if verbose {
        path.to_string()
    } else {
        crate::utils::file::get_display_path(path)
    };
    Some(format!("pattern: \"{pattern}\", path: \"{path}\""))
}

/// Maps to CC `tools/GlobTool/UI.tsx:31-53`.
pub fn render_tool_use_error_message(result: &str, verbose: bool) -> Option<&'static str> {
    if verbose {
        return None;
    }
    let error = crate::utils::messages::extract_tag(result, "tool_use_error")?;
    if error.contains(crate::utils::file::FILE_NOT_FOUND_CWD_NOTE) {
        Some("File not found")
    } else {
        Some("Error searching files")
    }
}

/// The Rust stand-in for CC's `outputSchema.safeParse(toolUseResult)`
/// (`UserToolSuccessMessage.tsx:80`): all four declared fields are required
/// (`GlobTool.ts:39-52`); unknown object keys are stripped exactly as Zod's
/// default object behavior.
pub fn parse_output(value: &serde_json::Value) -> Option<Output> {
    let duration_ms = value.get("durationMs")?.as_number()?.clone();
    let num_files = value.get("numFiles")?.as_number()?.clone();
    let filenames = value
        .get("filenames")?
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    Some(Output {
        duration_ms,
        num_files,
        filenames,
        truncated: value.get("truncated")?.as_bool()?,
        completion_note: None,
        unreachable_paths: Vec::new(),
    })
}

/// Serializes [`Output`] back to CC's exact `toolUseResult` wire shape.
pub(crate) fn output_to_value(output: &Output) -> serde_json::Value {
    serde_json::json!({
        "durationMs": output.duration_ms,
        "numFiles": output.num_files,
        "filenames": output.filenames,
        "truncated": output.truncated,
    })
}

/// Maps to CC `tools/GlobTool/UI.tsx:58-65`.
pub fn get_tool_use_summary(input: Option<&serde_json::Value>) -> Option<String> {
    let pattern = input?
        .get("pattern")?
        .as_str()
        .filter(|pattern| !pattern.is_empty())?;
    Some(crate::utils::truncate::truncate_to_width(
        pattern,
        crate::constants::tool_limits::TOOL_SUMMARY_MAX_LENGTH,
    ))
}

/// Maps to: CC `GlobTool/UI.tsx:56` `renderToolResultMessage =
/// GrepTool.renderToolResultMessage`, as invoked by
/// `UserToolSuccessMessage.tsx:80-96` — parse the raw `toolUseResult` with
/// **Glob's** own output schema, then hand the parsed object to Grep's
/// renderer. Glob output has no `mode`, so Grep's destructuring default
/// `files_with_matches` applies and the file list comes from `filenames`.
///
/// This is the by-tool-name entry the dispatch calls — the only Glob
/// render path now that the Glob display shapes are gone.
pub(crate) fn render_tool_result_message(
    raw_output: Option<&serde_json::Value>,
    status: ToolResultStatus,
    fallback: &str,
    options: &ToolRenderOptions,
) -> Vec<ToolRenderLine> {
    // CC bails on a missing `toolUseResult` before touching the tool
    // (`UserToolSuccessMessage.tsx:72`).
    let Some(raw_output) = raw_output else {
        return Vec::new();
    };
    if status != ToolResultStatus::Success {
        return grep_tool::ui::render_tool_result_message(
            Some(raw_output),
            status,
            fallback,
            options,
        );
    }
    // CC: `safeParse` failure returns null, i.e. the row renders nothing
    // (`UserToolSuccessMessage.tsx:81`).
    let Some(output) = parse_output(raw_output) else {
        return Vec::new();
    };
    // CC passes the Glob `Output` object straight into Grep's render function;
    // under Rust's typed carrier that is the projection of exactly the fields
    // the function reads (`durationMs`/`truncated` are never consumed there).
    grep_tool::ui::render_output(
        &grep_tool::Output {
            mode: None,
            num_files: output.num_files,
            filenames: output.filenames,
            content: None,
            num_lines: None,
            num_matches: None,
            applied_limit: None,
            applied_offset: None,
            completion_note: None,
            unreachable_paths: Vec::new(),
            skipped_encoding: 0,
        },
        options,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_tool_use_message_matches_official_path_and_truthiness() {
        assert_eq!(user_facing_name(), "Search");
        assert_eq!(
            render_tool_use_message(&serde_json::json!({"pattern": "**/*.rs"}), false),
            Some("pattern: \"**/*.rs\"".to_string())
        );
        assert_eq!(
            render_tool_use_message(
                &serde_json::json!({"pattern": "**/*.rs", "path": "/outside/project"}),
                true,
            ),
            Some("pattern: \"**/*.rs\", path: \"/outside/project\"".to_string())
        );
        assert_eq!(
            render_tool_use_message(&serde_json::json!({"pattern": ""}), false),
            None
        );
    }

    #[test]
    fn glob_tool_use_error_message_uses_official_compact_copy() {
        assert_eq!(
            render_tool_use_error_message(
                "<tool_use_error>Directory missing. Note: your current working directory is /repo.</tool_use_error>",
                false,
            ),
            Some("File not found")
        );
        assert_eq!(
            render_tool_use_error_message(
                "<tool_use_error>permission denied</tool_use_error>",
                false
            ),
            Some("Error searching files")
        );
        assert_eq!(
            render_tool_use_error_message(
                "<tool_use_error>permission denied</tool_use_error>",
                true
            ),
            None
        );
        assert_eq!(render_tool_use_error_message("plain error", false), None);
    }

    #[test]
    fn glob_output_parser_enforces_output_schema_and_preserves_paths() {
        assert_eq!(
            parse_output(&serde_json::json!({
                "durationMs": 4,
                "numFiles": 1,
                "filenames": ["/outside/project/file.rs"],
                "truncated": false,
                "unknown": "allowed"
            })),
            Some(Output {
                duration_ms: serde_json::Number::from(4),
                num_files: serde_json::Number::from(1),
                filenames: vec!["/outside/project/file.rs".to_string()],
                truncated: false,
                completion_note: None,
                unreachable_paths: Vec::new(),
            })
        );
        assert!(
            parse_output(&serde_json::json!({
                "durationMs": 4,
                "numFiles": 1,
                "filenames": ["file.rs"]
            }))
            .is_none()
        );
        assert!(
            parse_output(&serde_json::json!({
                "durationMs": 4,
                "numFiles": 1,
                "filenames": [1],
                "truncated": false
            }))
            .is_none()
        );
        let unusual = parse_output(&serde_json::json!({
            "durationMs": -0.5,
            "numFiles": 1.5,
            "filenames": ["file.rs"],
            "truncated": false
        }))
        .expect("ordinary Zod number values remain valid");
        assert_eq!(unusual.duration_ms.as_f64(), Some(-0.5));
        assert_eq!(unusual.num_files.as_f64(), Some(1.5));
    }

    /// Maps to: CC Glob reusing Grep's `renderToolResultMessage`
    /// (`GlobTool/UI.tsx:56`) — verbose keeps complete paths, collapsed keeps
    /// the bold count summary, and unrestricted Zod numbers survive replay.
    #[test]
    fn glob_expanded_results_keep_complete_paths_and_bold_count() {
        let long_tail = "x".repeat(5_000);
        let raw = serde_json::json!({
            "durationMs": 3,
            "numFiles": 2,
            "filenames": ["first.rs", long_tail.clone()],
            "truncated": false
        });
        let lines = render_tool_result_message(
            Some(&raw),
            ToolResultStatus::Success,
            "",
            &ToolRenderOptions {
                verbose: true,
                ..ToolRenderOptions::default()
            },
        );
        assert_eq!(lines[1].text, format!("first.rs\n{long_tail}"));
        assert!(
            lines[0]
                .segments
                .iter()
                .any(|segment| segment.bold && segment.text == "2 ")
        );

        let replayed = render_tool_result_message(
            Some(&serde_json::json!({
                "durationMs": -0.5,
                "numFiles": 1.5,
                "filenames": ["first.rs"],
                "truncated": false
            })),
            ToolResultStatus::Success,
            "",
            &ToolRenderOptions::default(),
        );
        assert!(replayed[0].text.starts_with("Found 1.5 files"));
        assert!(replayed[0].text.contains("ctrl+o to expand"));
    }

    #[test]
    fn glob_tool_use_summary_uses_official_fifty_column_ellipsis() {
        let pattern = "a".repeat(60);
        let summary =
            get_tool_use_summary(Some(&serde_json::json!({"pattern": pattern}))).expect("summary");
        assert_eq!(unicode_width::UnicodeWidthStr::width(summary.as_str()), 50);
        assert!(summary.ends_with('…'));

        let family = "👨‍👩‍👧‍👦";
        let emoji_pattern = family.repeat(30);
        let emoji_summary = get_tool_use_summary(Some(&serde_json::json!({
            "pattern": emoji_pattern
        })))
        .expect("emoji summary");
        let prefix = emoji_summary.trim_end_matches('…');
        assert!(
            unicode_segmentation::UnicodeSegmentation::graphemes(prefix, true)
                .all(|grapheme| grapheme == family)
        );
    }
}
