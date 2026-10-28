//! Tool I/O configuration and the shared completion-note contract.
//!
//! @nyan: new module (docs/nyan/tool-io.md section 5 and T1). Every behavior
//! added to Read / Grep / Glob / Bash is switchable here; turning a switch off
//! restores the CC code path byte for byte.
//!
//! The configuration lives under the passthrough settings key `nyan.toolIo`.
//! `SettingsJson` has no typed field for it yet (batch 0 owns the shared
//! schema), so this module reads the already-validated raw JSON each source
//! kept in the settings cache. Sources merge in the same order the loader uses
//! (user → project → local → flag → policy), later sources winning.

use crate::utils::settings::{SettingSource, get_enabled_setting_sources, settings_cache};

/// `settings.nyan.toolIo`, after merging every enabled source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolIoConfig {
    /// T1 — `(Complete …)` / `(Partial …)` as the last result line.
    pub completion_notes: bool,
    /// T2 — `--sort=path` for Grep content / count.
    pub stable_grep_order: bool,
    /// T3 — return a line prefix instead of a token-limit error.
    pub read_partial_on_overflow: bool,
    /// T4 — maximum files in one batch Read; 0 disables the batch form.
    pub read_batch_max: usize,
    /// T5 — automatic encoding detection (an explicit `encoding` is always
    /// honored: it is a caller instruction, not an inference).
    pub encoding_detection: bool,
    /// T6 — content-level binary sniffing.
    pub content_binary_check: bool,
    /// T6 — per-line cap for Read text output.
    pub max_line_chars_read: usize,
    /// T6 — per-line cap for Grep content output.
    pub max_line_chars_grep: usize,
    /// T7 — Bash head/tail retention and the related prompt text.
    pub bash_head_tail: bool,
    /// T8 — report rg traversal failures in the tail line.
    pub report_unreachable: bool,
}

/// Design defaults (docs/nyan/tool-io.md section 5).
pub const DEFAULT_TOOL_IO_CONFIG: ToolIoConfig = ToolIoConfig {
    completion_notes: true,
    stable_grep_order: true,
    read_partial_on_overflow: true,
    read_batch_max: 16,
    encoding_detection: true,
    content_binary_check: true,
    max_line_chars_read: 2000,
    max_line_chars_grep: 500,
    bash_head_tail: true,
    report_unreachable: true,
};

/// Read and merge `nyan.toolIo` from every enabled settings source.
pub fn config() -> ToolIoConfig {
    let mut config = DEFAULT_TOOL_IO_CONFIG;
    for source in get_enabled_setting_sources() {
        let Some(value) = source_tool_io_value(source) else {
            continue;
        };
        apply_value(&mut config, &value);
    }
    config
}

fn source_tool_io_value(source: SettingSource) -> Option<serde_json::Value> {
    let path = crate::utils::settings::get_settings_file_path_for_source(source)?;
    crate::utils::settings::parse_settings_file(&path);
    settings_cache::get_cached_parsed_file(&path)?
        .value
        .as_ref()?
        .get("nyan")?
        .get("toolIo")
        .cloned()
}

fn apply_value(config: &mut ToolIoConfig, value: &serde_json::Value) {
    let Some(object) = value.as_object() else {
        return;
    };
    macro_rules! boolean {
        ($field:ident, $key:literal) => {
            if let Some(setting) = object.get($key).and_then(serde_json::Value::as_bool) {
                config.$field = setting;
            }
        };
    }
    macro_rules! count {
        ($field:ident, $key:literal) => {
            if let Some(setting) = object
                .get($key)
                .and_then(serde_json::Value::as_f64)
                .filter(|setting| setting.is_finite() && *setting >= 0.0)
            {
                config.$field = setting as usize;
            }
        };
    }
    boolean!(completion_notes, "completionNotes");
    boolean!(stable_grep_order, "stableGrepOrder");
    boolean!(read_partial_on_overflow, "readPartialOnOverflow");
    count!(read_batch_max, "readBatchMax");
    boolean!(encoding_detection, "encodingDetection");
    boolean!(content_binary_check, "contentBinaryCheck");
    boolean!(bash_head_tail, "bashHeadTail");
    boolean!(report_unreachable, "reportUnreachable");
    if let Some(max_line_chars) = object.get("maxLineChars").and_then(|v| v.as_object()) {
        if let Some(read) = max_line_chars
            .get("read")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
        {
            config.max_line_chars_read = read as usize;
        }
        if let Some(grep) = max_line_chars
            .get("grep")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
        {
            config.max_line_chars_grep = grep as usize;
        }
    }
}

// ── T1 completion notes ──────────────────────────────────────────────────

/// Skips and unreachable-path counts that ride the completion line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NoteIssues {
    pub skipped_encoding: usize,
    pub unreachable: usize,
}

impl NoteIssues {
    fn suffix(&self) -> String {
        let mut parts = Vec::new();
        if self.skipped_encoding > 0 {
            parts.push(format!(
                "{} files skipped (encoding)",
                self.skipped_encoding
            ));
        }
        if self.unreachable > 0 {
            parts.push(format!("{} paths unreachable", self.unreachable));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!("; {}", parts.join(", "))
        }
    }
}

/// Read's tail line. `start` is the 1-based first line of the `shown` lines;
/// `total` is the file's line count as CC reports it (a trailing newline adds
/// one empty final fragment).
pub fn read_note(start: usize, shown: usize, total: usize) -> String {
    if shown == 0 {
        return "(Complete: no lines in range.)".to_string();
    }
    let end = start.saturating_add(shown).saturating_sub(1);
    if end >= total {
        format!("(Complete: reached end of file; lines {start}-{end} of {total} shown.)")
    } else {
        let next = end + 1;
        format!("(Partial: lines {start}-{end} of {total} shown. Continue with offset={next}.)")
    }
}

/// Hex-view tail; rows are 16-byte lines, so the "line" wording is the same.
pub fn hex_note(start: usize, shown: usize, total: usize) -> String {
    read_note(start, shown, total)
}

/// Grep content tail. `offset` is the model-facing `offset` parameter, which
/// counts matching lines (not file lines).
pub fn grep_content_note(total: usize, shown: usize, offset: usize, issues: NoteIssues) -> String {
    if total == 0 {
        return format!("(Complete: no matches found{}.)", issues.suffix());
    }
    let first = offset.saturating_add(1);
    let last = offset.saturating_add(shown);
    if last >= total {
        format!(
            "(Complete: all {total} matching lines shown{}.)",
            issues.suffix()
        )
    } else {
        format!(
            "(Partial: lines {first}-{last} of {total} shown{}. Continue with offset={}.)",
            issues.suffix(),
            last
        )
    }
}

/// Grep count / files_with_matches tail; `offset` counts result files.
pub fn grep_files_note(total: usize, shown: usize, offset: usize, issues: NoteIssues) -> String {
    if total == 0 {
        return format!("(Complete: no files found{}.)", issues.suffix());
    }
    let first = offset.saturating_add(1);
    let last = offset.saturating_add(shown);
    if last >= total {
        format!("(Complete: all {total} files shown{}.)", issues.suffix())
    } else {
        format!(
            "(Partial: files {first}-{last} of {total} shown{}. Continue with offset={}.)",
            issues.suffix(),
            last
        )
    }
}

/// Glob has no continuation parameter, so a partial note names the way out.
pub fn glob_note(total: usize, shown: usize, issues: NoteIssues) -> String {
    if total == 0 {
        return format!("(Complete: no files found{}.)", issues.suffix());
    }
    if shown >= total {
        format!("(Complete: all {total} files shown{}.)", issues.suffix())
    } else {
        format!(
            "(Partial: files 1-{shown} of {total} shown{}. Use a more specific path or pattern.)",
            issues.suffix()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_env::{EnvVarGuard, TEST_ENV_LOCK};

    struct ConfigHomeGuard {
        _home: EnvVarGuard,
        _lock: crate::utils::test_env::TestEnvGuard<'static>,
    }

    fn config_home_with(tool_io: &str) -> ConfigHomeGuard {
        let lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root =
            std::env::temp_dir().join(format!("cometix-tool-io-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::write(
            root.join("settings.json"),
            format!("{{\"nyan\": {{\"toolIo\": {tool_io}}}}}"),
        )
        .unwrap();
        let home = EnvVarGuard::set("CLAUDE_CONFIG_DIR", root.to_str().unwrap());
        ConfigHomeGuard {
            _home: home,
            _lock: lock,
        }
    }

    #[test]
    fn defaults_match_the_design_table() {
        let config = DEFAULT_TOOL_IO_CONFIG;
        assert!(config.completion_notes);
        assert!(config.stable_grep_order);
        assert!(config.read_partial_on_overflow);
        assert_eq!(config.read_batch_max, 16);
        assert!(config.encoding_detection);
        assert!(config.content_binary_check);
        assert_eq!(config.max_line_chars_read, 2000);
        assert_eq!(config.max_line_chars_grep, 500);
        assert!(config.bash_head_tail);
        assert!(config.report_unreachable);
    }

    #[test]
    fn settings_switch_each_behavior_independently() {
        let _home = config_home_with(
            r#"{"completionNotes": false, "stableGrepOrder": false,
                "readPartialOnOverflow": false, "readBatchMax": 0,
                "encodingDetection": false, "contentBinaryCheck": false,
                "maxLineChars": {"read": 120, "grep": 40},
                "bashHeadTail": false, "reportUnreachable": false}"#,
        );
        let config = config();
        assert!(!config.completion_notes);
        assert!(!config.stable_grep_order);
        assert!(!config.read_partial_on_overflow);
        assert_eq!(config.read_batch_max, 0);
        assert!(!config.encoding_detection);
        assert!(!config.content_binary_check);
        assert_eq!(config.max_line_chars_read, 120);
        assert_eq!(config.max_line_chars_grep, 40);
        assert!(!config.bash_head_tail);
        assert!(!config.report_unreachable);
    }

    #[test]
    fn unknown_and_malformed_values_keep_the_default() {
        let _home = config_home_with(
            r#"{"completionNotes": "yes", "readBatchMax": -1,
                "maxLineChars": {"read": 0, "grep": "wide"}}"#,
        );
        let config = config();
        assert!(config.completion_notes);
        assert_eq!(config.read_batch_max, DEFAULT_TOOL_IO_CONFIG.read_batch_max);
        assert_eq!(
            config.max_line_chars_read,
            DEFAULT_TOOL_IO_CONFIG.max_line_chars_read
        );
        assert_eq!(
            config.max_line_chars_grep,
            DEFAULT_TOOL_IO_CONFIG.max_line_chars_grep
        );
    }

    #[test]
    fn completion_note_copy_matches_the_design() {
        assert_eq!(
            read_note(1, 212, 212),
            "(Complete: reached end of file; lines 1-212 of 212 shown.)"
        );
        assert_eq!(
            read_note(120, 40, 512),
            "(Partial: lines 120-159 of 512 shown. Continue with offset=160.)"
        );
        assert_eq!(
            grep_files_note(37, 37, 0, NoteIssues::default()),
            "(Complete: all 37 files shown.)"
        );
        assert_eq!(
            grep_files_note(
                37,
                37,
                0,
                NoteIssues {
                    skipped_encoding: 2,
                    unreachable: 1
                }
            ),
            "(Complete: all 37 files shown; 2 files skipped (encoding), 1 paths unreachable.)"
        );
        assert_eq!(
            grep_files_note(37, 2, 0, NoteIssues::default()),
            "(Partial: files 1-2 of 37 shown. Continue with offset=2.)"
        );
        assert_eq!(
            grep_content_note(0, 0, 0, NoteIssues::default()),
            "(Complete: no matches found.)"
        );
        assert_eq!(
            grep_content_note(512, 250, 0, NoteIssues::default()),
            "(Partial: lines 1-250 of 512 shown. Continue with offset=250.)"
        );
        assert_eq!(
            glob_note(120, 100, NoteIssues::default()),
            "(Partial: files 1-100 of 120 shown. Use a more specific path or pattern.)"
        );
    }
}
