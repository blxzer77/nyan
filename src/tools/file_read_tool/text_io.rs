//! @nyan: Read-side text helpers (docs/nyan/tool-io.md T1/T3/T4/T6).
//!
//! Pure formatting/budget functions plus the hex renderer, kept out of the
//! call pipeline so each rule is testable without a ToolUseContext.

use crate::services::token_estimation::{
    bytes_per_token_for_file_type, rough_token_count_estimation_for_file_type,
};

/// One rendered batch member (T4).
pub(crate) struct BatchSegment {
    pub path: String,
    pub start_line: usize,
    pub line_count: usize,
    pub total_lines: usize,
}

impl BatchSegment {
    /// `=== src/a.rs (lines 1-120 of 120) ===`; a member with no room left
    /// shows only its path, because no line of it was displayed.
    pub fn header(&self) -> String {
        if self.line_count == 0 {
            return format!("=== {} ===", self.path);
        }
        format!(
            "=== {} (lines {}-{} of {}) ===",
            self.path,
            self.start_line,
            self.start_line + self.line_count - 1,
            self.total_lines
        )
    }
}

/// T6: cap one displayed line. `max_chars == 0` disables the cap.
pub(crate) fn truncate_long_line(line: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return line.to_string();
    }
    let total = line.chars().count();
    if total <= max_chars {
        return line.to_string();
    }
    let prefix: String = line.chars().take(max_chars).collect();
    format!("{prefix} … [line truncated: {total} chars total]")
}

/// Apply [`truncate_long_line`] to every line of `content`.
pub(crate) fn truncate_long_lines(content: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return content.to_string();
    }
    content
        .split('\n')
        .map(|line| truncate_long_line(line, max_chars))
        .collect::<Vec<_>>()
        .join("\n")
}

/// T3: the largest whole-line prefix of `content` whose rough token estimate
/// fits `max_tokens`. Returns `None` when the whole content fits.
///
/// The estimate is CC's own `rough_token_count_estimation_for_file_type`, as
/// the design specifies: no API call, no o200k tokenizer.
pub(crate) fn trim_to_token_budget(
    content: &str,
    extension: &str,
    max_tokens: f64,
) -> Option<(String, usize)> {
    if rough_token_count_estimation_for_file_type(content, extension) as f64 <= max_tokens {
        return None;
    }
    let bytes_per_token = bytes_per_token_for_file_type(extension);
    let budget_units = (max_tokens * bytes_per_token as f64) as usize;
    if budget_units == 0 {
        return Some((String::new(), 0));
    }
    let mut units = 0usize;
    let mut kept_lines = 0usize;
    let mut kept_end = 0usize;
    let mut line_start = 0usize;
    for (index, character) in content.char_indices() {
        let character_units = character.len_utf16();
        if units + character_units > budget_units {
            break;
        }
        units += character_units;
        if character == '\n' {
            kept_lines += 1;
            kept_end = index + 1;
        }
        line_start = index + character.len_utf8();
    }
    if kept_lines == 0 {
        // A single line does not fit; keep the character prefix (plus the T6
        // marker) so the model knows the line itself was cut, not the range.
        let mut prefix_units = 0usize;
        let mut prefix_end = 0usize;
        for (index, character) in content.char_indices() {
            let character_units = character.len_utf16();
            if prefix_units + character_units > budget_units {
                break;
            }
            prefix_units += character_units;
            prefix_end = index + character.len_utf8();
        }
        let total_chars = content.chars().count();
        return Some((
            format!(
                "{} … [line truncated: {total_chars} chars total]",
                &content[..prefix_end]
            ),
            1,
        ));
    }
    let _ = line_start;
    let _ = kept_end;
    let mut lines = content.split('\n');
    let kept = lines
        .by_ref()
        .take(kept_lines)
        .collect::<Vec<_>>()
        .join("\n");
    Some((kept, kept_lines))
}

/// T6: one row per 16 bytes: `00000000  7f 45 4c 46 02 01 01 00  00 00 00 00 00 00 00 00  |.ELF............|`
pub(crate) fn hex_row(row: usize, bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(48);
    for index in 0..16 {
        if index == 8 {
            hex.push(' ');
        }
        match bytes.get(index) {
            Some(byte) => hex.push_str(&format!("{byte:02x} ")),
            None => hex.push_str("   "),
        }
    }
    let ascii: String = bytes
        .iter()
        .map(|byte| {
            if byte.is_ascii_graphic() || *byte == b' ' {
                *byte as char
            } else {
                '.'
            }
        })
        .collect();
    format!("{:08x}  {} |{ascii}|", row * 16, hex.trim_end())
}

/// Render `bytes` as hex rows `[start_row, start_row + max_rows)`.
/// Returns the rendered rows, the number of rows rendered, and the total row
/// count for the tail line.
pub(crate) fn hex_view(bytes: &[u8], start_row: usize, max_rows: usize) -> (String, usize, usize) {
    let total_rows = bytes.len().div_ceil(16);
    if start_row >= total_rows {
        return (String::new(), 0, total_rows);
    }
    let end_row = start_row.saturating_add(max_rows).min(total_rows);
    let rows = (start_row..end_row)
        .map(|row| {
            let start = row * 16;
            let end = (start + 16).min(bytes.len());
            hex_row(row, &bytes[start..end])
        })
        .collect::<Vec<_>>()
        .join("\n");
    (rows, end_row - start_row, total_rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_lines_are_cut_with_a_total_count() {
        let line = "x".repeat(2500);
        let cut = truncate_long_line(&line, 2000);
        assert!(cut.starts_with(&"x".repeat(2000)));
        assert!(cut.ends_with("… [line truncated: 2500 chars total]"));
        assert_eq!(truncate_long_line("short", 2000), "short");
        assert_eq!(truncate_long_line(&line, 0), line);
        assert_eq!(
            truncate_long_lines("a\nb", 1),
            "a\nb",
            "short lines are untouched"
        );
    }

    #[test]
    fn token_budget_keeps_whole_lines() {
        let content = (1..=100)
            .map(|line| format!("line {line} with some payload"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(trim_to_token_budget(&content, "txt", 25_000.0).is_none());
        let (kept, lines) = trim_to_token_budget(&content, "txt", 50.0).expect("trimmed");
        assert!(lines > 0 && lines < 100);
        assert_eq!(kept.split('\n').count(), lines);
        // The kept prefix is exactly the first `lines` lines.
        let expected = content
            .split('\n')
            .take(lines)
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(kept, expected);
    }

    #[test]
    fn single_unfittable_line_keeps_a_character_prefix() {
        let content = "y".repeat(10_000);
        let (kept, lines) = trim_to_token_budget(&content, "txt", 10.0).expect("trimmed");
        assert_eq!(lines, 1);
        assert!(!kept.is_empty() && kept.len() < content.len());
    }

    #[test]
    fn hex_rows_render_offsets_hex_and_ascii() {
        let (rendered, shown, total) = hex_view(b"hello\x00world", 0, 1);
        assert_eq!(shown, 1);
        assert_eq!(total, 1);
        assert_eq!(
            rendered,
            "00000000  68 65 6c 6c 6f 00 77 6f  72 6c 64 |hello.world|"
        );
        let bytes = vec![0u8; 40];
        let (rendered, shown, total) = hex_view(&bytes, 1, 10);
        assert_eq!(shown, 2);
        assert_eq!(total, 3);
        assert!(rendered.starts_with("00000010  00 00"));
        assert!(rendered.contains('\n'));
        let (empty, shown, total) = hex_view(&bytes, 3, 10);
        assert!(empty.is_empty() && shown == 0 && total == 3);
    }

    #[test]
    fn batch_header_matches_the_design_copy() {
        let segment = BatchSegment {
            path: "src/a.rs".to_string(),
            start_line: 1,
            line_count: 120,
            total_lines: 120,
        };
        assert_eq!(segment.header(), "=== src/a.rs (lines 1-120 of 120) ===");
    }
}
