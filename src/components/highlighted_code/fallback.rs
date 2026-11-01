//! Maps to: CC `components/HighlightedCode/Fallback.tsx`.
//!
//! The official fallback converts leading tabs to spaces and either renders raw
//! ANSI text or, when available, asynchronously highlights with the CLI
//! highlighter. Nyan keeps this fallback deterministic and safe: no async CLI
//! highlighter is loaded here; callers that want syntax highlighting should use
//! the native `ColorFile` path in `HighlightedCode`.

use iocraft::prelude::*;

#[derive(Default, Props)]
pub struct HighlightedCodeFallbackProps {
    pub code: String,
    pub file_path: String,
    pub dim: bool,
    pub skip_coloring: bool,
}

/// Maps to: CC `utils/file.ts#convertLeadingTabsToSpaces` used by fallback.
pub fn convert_leading_tabs_to_spaces(content: &str) -> String {
    if !content.contains('\t') {
        return content.to_string();
    }
    content
        .split_inclusive('\n')
        .map(|line| {
            let leading_tabs = line.chars().take_while(|ch| *ch == '\t').count();
            format!("{}{}", "  ".repeat(leading_tabs), &line[leading_tabs..])
        })
        .collect::<String>()
}

/// Maps to: CC `HighlightedCodeFallback` render branch.
pub fn highlighted_code_fallback_text(code: &str) -> String {
    convert_leading_tabs_to_spaces(code)
}

#[component]
pub fn HighlightedCodeFallback(
    props: &HighlightedCodeFallbackProps,
    _hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let _ = (&props.file_path, props.skip_coloring);
    element! {
        Text(
            content: highlighted_code_fallback_text(&props.code),
            dim: props.dim,
            wrap: TextWrap::Wrap,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlighted_code_fallback_converts_leading_tabs_like_official_utils() {
        assert_eq!(
            convert_leading_tabs_to_spaces("\tfn main() {\n\t\tprintln!();\ninner\ttab"),
            "  fn main() {\n    println!();\ninner\ttab"
        );
        assert_eq!(convert_leading_tabs_to_spaces("\tline\n"), "  line\n");
        assert_eq!(convert_leading_tabs_to_spaces("no tabs"), "no tabs");
    }
}
