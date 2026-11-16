//! Plugin hint tags in shell output.
//!
//! CLIs may print whole-line `<claude-code-hint ... />` tags meant for the
//! agent harness. nyan does not act on them, but still strips them so the tag
//! never reaches the model or the transcript.

use regex::Regex;
use std::borrow::Cow;
use std::sync::LazyLock;

static HINT_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^[ \t]*<claude-code-hint\s+[^>]*?\s*/>[ \t]*$")
        .expect("valid plugin hint tag regex")
});
static BLANK_RUNS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("valid blank-line regex"));

/// Removes whole-line plugin hint tags, collapsing the blank runs they leave.
pub fn strip_plugin_hints(output: &str) -> String {
    if !output.contains("<claude-code-hint") {
        return output.to_string();
    }
    match HINT_TAG.replace_all(output, "") {
        Cow::Borrowed(_) => output.to_string(),
        Cow::Owned(stripped) => BLANK_RUNS.replace_all(&stripped, "\n\n").into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_whole_line_plugin_hint_tags() {
        assert_eq!(
            strip_plugin_hints(
                "before\n<claude-code-hint v=1 type=plugin value=foo@acme />\nafter"
            ),
            "before\n\nafter"
        );
        assert_eq!(
            strip_plugin_hints(
                "a\n\n  <claude-code-hint v=\"2\" type=\"other\" value=\"x\" />\t\n\nb"
            ),
            "a\n\nb"
        );
    }

    #[test]
    fn leaves_embedded_tags_and_untagged_output_alone() {
        let embedded = "log: <claude-code-hint v=1 type=plugin value=x@y />";
        assert_eq!(strip_plugin_hints(embedded), embedded);
        assert_eq!(strip_plugin_hints("a\n\n\n\nb"), "a\n\n\n\nb");
    }
}
