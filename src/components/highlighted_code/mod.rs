//! Maps to: CC `components/HighlightedCode.tsx`.
//!
//! Official `HighlightedCode` attempts native `ColorFile` highlighting and
//! falls back to `HighlightedCode/Fallback.tsx` when disabled/unavailable.
//! ColorFile returns ANSI / styled lines; Ink renders them via `<Ansi>`.
//! Nyan's `ColorFile` returns `ToolRenderLine` segments with syntect
//! foregrounds — same projection as `StructuredDiff`.

pub mod fallback;

use crate::components::highlighted_code::fallback::highlighted_code_fallback_text;
use crate::components::messages::user_tool_result_message::utils::{
    ToolRenderLine, ToolRenderSegment, ToolRenderTone,
};
use crate::components::structured_diff::{ColorFile, color_diff::SyntaxHighlightTheme};
use iocraft::prelude::*;

const DEFAULT_WIDTH: usize = 80;

#[derive(Default, Props)]
pub struct HighlightedCodeProps {
    pub code: String,
    pub file_path: String,
    pub width: Option<usize>,
    pub dim: bool,
    /// Mirrors `settings.syntaxHighlightingDisabled ?? false`.
    pub syntax_highlighting_disabled: bool,
    pub syntax_theme: Option<SyntaxHighlightTheme>,
}

/// Maps to: CC `HighlightedCode` `colorFile.render(...)` / fallback selection.
/// Returns styled lines (gutter + syntax segments) for iocraft projection.
pub fn highlighted_code_render_lines(
    code: &str,
    file_path: &str,
    width: Option<usize>,
    dim: bool,
    syntax_highlighting_disabled: bool,
    syntax_theme: SyntaxHighlightTheme,
) -> Vec<ToolRenderLine> {
    if syntax_highlighting_disabled {
        return fallback_render_lines(code, dim);
    }

    let rendered = ColorFile::new(code.to_string(), file_path.to_string()).render(
        syntax_theme,
        width.unwrap_or(DEFAULT_WIDTH).max(1),
        dim,
    );
    if rendered.is_empty() {
        return fallback_render_lines(code, dim);
    }
    rendered
}

/// Plain-text lines for tests / string consumers (colors stripped).
pub fn highlighted_code_lines(
    code: &str,
    file_path: &str,
    width: Option<usize>,
    dim: bool,
    syntax_highlighting_disabled: bool,
    syntax_theme: SyntaxHighlightTheme,
) -> Vec<String> {
    highlighted_code_render_lines(
        code,
        file_path,
        width,
        dim,
        syntax_highlighting_disabled,
        syntax_theme,
    )
    .iter()
    .map(tool_render_line_text)
    .collect()
}

fn fallback_render_lines(code: &str, dim: bool) -> Vec<ToolRenderLine> {
    highlighted_code_fallback_text(code)
        .lines()
        .map(|line| {
            ToolRenderLine::new(line.to_string(), ToolRenderTone::Normal)
                .with_dim(dim)
                .with_segments(vec![ToolRenderSegment::new(line.to_string())])
        })
        .collect()
}

fn tool_render_line_text(line: &ToolRenderLine) -> String {
    if line.segments.is_empty() {
        line.text.clone()
    } else {
        line.segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<String>()
    }
}

/// Maps to: CC `components/HighlightedCode.tsx#HighlightedCode` —
/// Ink `<Ansi>{line}</Ansi>` over ColorFile output; Nyan projects the
/// equivalent syntect segments onto colored `Text` nodes (same as
/// `StructuredDiff`).
#[component]
pub fn HighlightedCode(
    props: &HighlightedCodeProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    let syntax_theme = props
        .syntax_theme
        .unwrap_or_else(|| SyntaxHighlightTheme::from_theme(*theme));
    let lines = highlighted_code_render_lines(
        &props.code,
        &props.file_path,
        props.width,
        props.dim,
        props.syntax_highlighting_disabled,
        syntax_theme,
    );
    let props_dim = props.dim;

    element! {
        View(flex_direction: FlexDirection::Column, width: 100pct) {
            #(lines.into_iter().map(|line| {
                let line_dim = line.dim || props_dim;
                if line.segments.is_empty() {
                    element! {
                        Text(
                            content: line.text,
                            dim: line_dim,
                            wrap: TextWrap::NoWrap,
                        )
                    }
                    .into_any()
                } else {
                    element! {
                        View(flex_direction: FlexDirection::Row) {
                            #(line.segments.into_iter().map(|segment| {
                                element! {
                                    Text(
                                        content: segment.text,
                                        color: segment.foreground,
                                        dim: line_dim || segment.dim,
                                        wrap: TextWrap::NoWrap,
                                    )
                                }
                            }))
                        }
                    }
                    .into_any()
                }
            }).collect::<Vec<_>>())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    #[test]
    fn highlighted_code_uses_color_file_numbered_layout_when_enabled() {
        let lines = highlighted_code_lines(
            "fn main() {\n    println!(\"hi\");\n}",
            "main.rs",
            Some(80),
            false,
            false,
            SyntaxHighlightTheme::Dark,
        );
        assert!(
            lines.iter().any(|line| line.contains("1 fn main")),
            "lines={lines:?}"
        );
        assert!(
            lines.iter().any(|line| line.contains("2     println")),
            "lines={lines:?}"
        );
    }

    #[test]
    fn highlighted_code_render_lines_preserve_syntax_foreground_for_rust() {
        let lines = highlighted_code_render_lines(
            "fn main() {\n    let x = 1;\n}",
            "main.rs",
            Some(80),
            false,
            false,
            SyntaxHighlightTheme::Dark,
        );
        let has_colored_segment = lines.iter().any(|line| {
            line.segments
                .iter()
                .any(|segment| segment.foreground.is_some() && !segment.text.trim().is_empty())
        });
        assert!(
            has_colored_segment,
            "expected ColorFile syntect segments with foreground; lines={lines:?}"
        );
    }

    #[test]
    fn highlighted_code_uses_fallback_when_syntax_highlighting_disabled() {
        let lines = highlighted_code_lines(
            "\tlet x = 1;",
            "main.rs",
            Some(80),
            false,
            true,
            SyntaxHighlightTheme::Dark,
        );
        assert_eq!(lines, vec!["  let x = 1;".to_string()]);
    }

    #[test]
    fn highlighted_code_component_renders_code_text() {
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                HighlightedCode(
                    code: "let answer = 42;".to_string(),
                    file_path: "main.rs".to_string(),
                    width: Some(80usize),
                    dim: false,
                    syntax_highlighting_disabled: true,
                )
            }
        }
        .render(Some(120))
        .to_string();

        assert!(text.contains("let answer = 42;"), "canvas=\n{text}");
    }
}
