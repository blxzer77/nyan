//! Maps to: CC `components/shell/OutputLine.tsx`.
//! Formatting/truncation is shared with Bash and PowerShell tool UI so shell
//! output cannot diverge between the standalone component and tool results.

use crate::components::message_response::MessageResponse;
use crate::tools::bash_tool::ui::{
    render_truncated_content, strip_underline_ansi, try_format_json_line, try_json_format_content,
};
use crate::utils::hyperlink::create_hyperlink;
use crate::utils::theme::Theme;
use iocraft::prelude::*;
use regex::Regex;
use std::sync::OnceLock;

// PLACEMENT SEAM (recorded 2026-08-30, verification batch). CC declares FOUR
// helpers that this file only re-exports:
//   * `OutputLine.tsx:12` `tryFormatJson`
//   * `OutputLine.tsx:37` `tryJsonFormatContent`
//   * `OutputLine.tsx:105` `stripUnderlineAnsi`
//   * `utils/terminal.ts:71` `renderTruncatedContent` (+ its private `wrapText`)
// The port declares the first three in `tools/bash_tool/ui.rs` and the fourth
// there as well, i.e. ownership runs the opposite way from the source: CC's
// `BashTool.tsx` is a CONSUMER of all four, importing them from these two
// files. Per the file-placement rule (a symbol belongs to the Rust file named
// after the CC file that DECLARES it — the same call made for
// `teammateModel.ts`), the first three belong here and `renderTruncatedContent`
// belongs in `utils/terminal.rs`. Not moved in this batch: `bash_tool/ui.rs`
// was outside its territory and the move touches every Bash/PowerShell/MCP
// consumer. Ledger: MODULE_MAP rows `components/shell/OutputLine.tsx` and
// `utils/terminal.ts`.

/// Maps to: CC `components/shell/OutputLine.tsx:12` `tryFormatJson` — exported
/// there and consumed by `tryJsonFormatContent` (`:42`).
///
/// PRESERVE — zero Rust callers, deliberately. The port's line-level formatter
/// is `bash_tool/ui.rs#try_format_json_line`, which
/// `bash_tool/ui.rs#try_json_format_content` already calls directly, so nothing
/// routes through this name. It is kept because CC exports the symbol and this
/// is the file CC declares it in; it becomes the real owner when the placement
/// seam above is closed. Do NOT delete it under "nothing calls it in Rust".
pub fn try_format_json(line: &str) -> String {
    try_format_json_line(line)
}

/// Maps to: CC `components/shell/OutputLine.tsx:37` `tryJsonFormatContent`.
/// Named `_public` because the declaring copy lives in `bash_tool/ui.rs` (see
/// the placement seam above); consumed by `tools/mcp_tool/ui.rs:243`, which is
/// CC's own consumer relationship (`MCPTool/UI.tsx` imports it from here).
pub fn try_json_format_content_public(content: &str) -> String {
    try_json_format_content(content)
}

/// Maps to: CC `components/shell/OutputLine.tsx:45-47` `URL_IN_JSON` — "Match
/// http(s) URLs inside JSON string values. Conservative: no quotes, no
/// whitespace, no trailing comma/brace that'd be JSON structure."
fn url_in_json() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r#"https?://[^\s"'<>\\]+"#).expect("URL regex is valid"))
}

/// Maps to: CC `components/shell/OutputLine.tsx:49-51` `linkifyUrlsInText`.
/// Exported there, and imported by `tools/MCPTool/UI.tsx:7-10` — this file is
/// the declaring owner, MCP is a consumer.
pub fn linkify_urls_in_text(content: &str) -> String {
    url_in_json()
        .replace_all(content, |captures: &regex::Captures<'_>| {
            create_hyperlink(captures.get(0).expect("match exists").as_str(), None)
        })
        .to_string()
}

#[derive(Default, Props)]
pub struct OutputLineProps {
    pub content: String,
    pub verbose: bool,
    pub is_error: bool,
    pub is_warning: bool,
    /// Maps to: CC `OutputLine.tsx:58` `linkifyUrls?: boolean` — opt-in, set by
    /// the MCP rich-output paths (`MCPTool/UI.tsx:234`, `:255`).
    pub linkify_urls: bool,
}

#[component]
pub fn OutputLine(props: &OutputLineProps, mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let (columns, _) = hooks.use_terminal_size();
    // Maps to CC OutputLine: `shouldShowFull = verbose || expandShellOutput`.
    let should_show_full =
        props.verbose || crate::components::shell::use_expand_shell_output(&mut hooks);
    // CC `:74-85` order: format → linkify → truncate → stripUnderlineAnsi. The
    // strip is last on BOTH branches (`:80`, `:82-84`).
    let mut formatted = try_json_format_content(&props.content);
    if props.linkify_urls {
        formatted = linkify_urls_in_text(&formatted);
    }
    let (content, remaining) = if should_show_full {
        (strip_underline_ansi(&formatted), 0)
    } else {
        let truncated = render_truncated_content(&formatted, columns as usize);
        (
            strip_underline_ansi(&truncated.above_the_fold),
            truncated.remaining_lines,
        )
    };
    let color = if props.is_error {
        Some(theme.error)
    } else if props.is_warning {
        Some(theme.warning)
    } else {
        None
    };
    // Already line-folded content — use NoWrap so soft re-wrap cannot push
    // past the Bash/PowerShell success fold limit (Nyan: 6 visual lines).
    element! {
        MessageResponse {
            View(flex_direction: FlexDirection::Column) {
                Ansi(content: content, color: color, wrap: TextWrap::NoWrap)
                #(if remaining > 0 {
                    Some(element! { Text(content: format!("… +{remaining} lines (ctrl+o to expand)"), color: theme.inactive, dim: true) })
                } else { None })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linkify_urls_wraps_only_json_safe_url_runs() {
        let linked = linkify_urls_in_text(r#"{"url":"https://example.test/a?b=1","n":1}"#);
        // The closing quote/brace are excluded by CC's conservative class.
        assert!(linked.contains("https://example.test/a?b=1"));
        assert!(linked.ends_with(r#","n":1}"#));
    }
}
