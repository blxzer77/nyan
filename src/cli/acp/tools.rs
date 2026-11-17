//! Describes tool calls for the ACP client. A tool's name and input become the title,
//! kind, locations and diff the client shows, and a tool result's content becomes text.
//! Tool names and input fields follow the nyan tools in `src/tools`.

use std::path::PathBuf;

use agent_client_protocol_schema::v1::ToolKind;
use serde_json::Value;

use super::session::ToolCallStart;

/// Longest title, in characters, before it is cut short.
const MAX_TITLE_CHARS: usize = 120;

/// Longest tool result text, in characters, before it is cut short.
const MAX_TOOL_RESULT_CHARS: usize = 20_000;

/// Describes a tool call for the client from the tool's name and input. An unknown tool,
/// or a known tool whose input lacks the expected fields, keeps the tool name as its title
/// and reports no locations or diff. Odd input never panics.
pub(super) fn describe_tool_call(id: &str, name: &str, input: &Value) -> ToolCallStart {
    let mut call = ToolCallStart {
        id: id.to_string(),
        title: name.to_string(),
        kind: ToolKind::Other,
        locations: Vec::new(),
        diff: None,
        raw_input: input.clone(),
    };
    match name {
        "Read" => {
            call.kind = ToolKind::Read;
            if let Some(path) = string_field(input, "file_path") {
                call.title = format!("Read {path}");
                call.locations = vec![PathBuf::from(path)];
            }
        }
        "Edit" => {
            call.kind = ToolKind::Edit;
            if let Some(path) = string_field(input, "file_path") {
                call.title = format!("Edit {path}");
                call.locations = vec![PathBuf::from(path)];
                if let (Some(old), Some(new)) =
                    (raw_str(input, "old_string"), raw_str(input, "new_string"))
                {
                    call.diff = Some((PathBuf::from(path), Some(old.to_string()), new.to_string()));
                }
            }
        }
        "Write" => {
            call.kind = ToolKind::Edit;
            if let Some(path) = string_field(input, "file_path") {
                call.title = format!("Write {path}");
                call.locations = vec![PathBuf::from(path)];
                if let Some(content) = raw_str(input, "content") {
                    call.diff = Some((PathBuf::from(path), None, content.to_string()));
                }
            }
        }
        "NotebookEdit" => {
            call.kind = ToolKind::Edit;
            if let Some(path) = string_field(input, "notebook_path") {
                call.title = format!("Edit {path}");
                call.locations = vec![PathBuf::from(path)];
            }
        }
        "Bash" | "PowerShell" => {
            call.kind = ToolKind::Execute;
            let title = string_field(input, "description").or_else(|| {
                string_field(input, "command")
                    .and_then(|command| command.lines().next())
                    .filter(|line| !line.is_empty())
            });
            if let Some(title) = title {
                call.title = truncate(title, MAX_TITLE_CHARS);
            }
        }
        "Grep" | "Glob" => {
            call.kind = ToolKind::Search;
            if let Some(title) = titled_by_value(name, string_field(input, "pattern")) {
                call.title = title;
            }
        }
        "CodeSearch" => {
            call.kind = ToolKind::Search;
            if let Some(title) = titled_by_value(name, string_field(input, "query")) {
                call.title = title;
            }
        }
        "WebFetch" => {
            call.kind = ToolKind::Fetch;
            if let Some(title) = titled_by_value(name, string_field(input, "url")) {
                call.title = title;
            }
        }
        "WebSearch" => {
            call.kind = ToolKind::Fetch;
            if let Some(title) = titled_by_value(name, string_field(input, "query")) {
                call.title = title;
            }
        }
        _ => {}
    }
    call
}

/// Flattens a tool result's content, a string or an array of content blocks, into text
/// for display. Non-text blocks are skipped. Returns `None` when no text remains. The text
/// is capped at `MAX_TOOL_RESULT_CHARS` characters.
pub(super) fn tool_result_text(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    if text.is_empty() {
        return None;
    }
    Some(cap_tool_result_text(&text))
}

/// Cuts tool result text to `MAX_TOOL_RESULT_CHARS` characters and says how much was left out.
fn cap_tool_result_text(text: &str) -> String {
    let total = text.chars().count();
    if total <= MAX_TOOL_RESULT_CHARS {
        return text.to_string();
    }
    let kept: String = text.chars().take(MAX_TOOL_RESULT_CHARS).collect();
    format!(
        "{kept}\n… [truncated, {} more characters]",
        total - MAX_TOOL_RESULT_CHARS
    )
}

/// The string at `key`, or `None` when it is missing, not a string, or empty.
fn string_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    raw_str(input, key).filter(|value| !value.is_empty())
}

/// The string at `key`, or `None` when it is missing or not a string.
fn raw_str<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// Titles a query-style tool call as `<tool name>: <value>`, cut to the title limit.
fn titled_by_value(name: &str, value: Option<&str>) -> Option<String> {
    value.map(|value| truncate(&format!("{name}: {value}"), MAX_TITLE_CHARS))
}

/// Cuts `text` to at most `max_chars` characters, ending a cut text with `…`. Counts
/// characters, not bytes, so a multi-byte character is never split.
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    if max_chars == 0 {
        return String::new();
    }
    let mut cut: String = text.chars().take(max_chars - 1).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn acp_describe_tool_call_classifies_known_tools() {
        let read = describe_tool_call("r1", "Read", &json!({"file_path": "/w/a.rs", "offset": 3}));
        assert_eq!(read.id, "r1");
        assert_eq!(read.kind, ToolKind::Read);
        assert_eq!(read.title, "Read /w/a.rs");
        assert_eq!(read.locations, vec![PathBuf::from("/w/a.rs")]);
        assert_eq!(read.diff, None);

        let edit_input = json!({
            "file_path": "/w/a.rs",
            "old_string": "x",
            "new_string": "y",
        });
        let edit = describe_tool_call("e1", "Edit", &edit_input);
        assert_eq!(edit.kind, ToolKind::Edit);
        assert_eq!(edit.title, "Edit /w/a.rs");
        assert_eq!(edit.locations, vec![PathBuf::from("/w/a.rs")]);
        assert_eq!(
            edit.diff,
            Some((
                PathBuf::from("/w/a.rs"),
                Some("x".to_string()),
                "y".to_string()
            ))
        );
        assert_eq!(edit.raw_input, edit_input);

        let write = describe_tool_call(
            "w1",
            "Write",
            &json!({"file_path": "/w/new.txt", "content": "hello"}),
        );
        assert_eq!(write.kind, ToolKind::Edit);
        assert_eq!(write.title, "Write /w/new.txt");
        assert_eq!(write.locations, vec![PathBuf::from("/w/new.txt")]);
        assert_eq!(
            write.diff,
            Some((PathBuf::from("/w/new.txt"), None, "hello".to_string()))
        );

        let notebook = describe_tool_call(
            "n1",
            "NotebookEdit",
            &json!({"notebook_path": "/w/nb.ipynb", "new_source": "print(1)"}),
        );
        assert_eq!(notebook.kind, ToolKind::Edit);
        assert_eq!(notebook.title, "Edit /w/nb.ipynb");
        assert_eq!(notebook.locations, vec![PathBuf::from("/w/nb.ipynb")]);
        assert_eq!(notebook.diff, None);

        let bash = describe_tool_call(
            "b1",
            "Bash",
            &json!({"command": "cargo test\n--lib", "description": "Run tests"}),
        );
        assert_eq!(bash.kind, ToolKind::Execute);
        assert_eq!(bash.title, "Run tests");
        assert!(bash.locations.is_empty());
        assert_eq!(bash.diff, None);

        let bash_no_description =
            describe_tool_call("b2", "Bash", &json!({"command": "cargo test --lib\nmore"}));
        assert_eq!(bash_no_description.title, "cargo test --lib");

        let grep = describe_tool_call("g1", "Grep", &json!({"pattern": "fn main"}));
        assert_eq!(grep.kind, ToolKind::Search);
        assert_eq!(grep.title, "Grep: fn main");

        let fetch_input = json!({"url": "https://example.com", "prompt": "summary"});
        let fetch = describe_tool_call("f1", "WebFetch", &fetch_input);
        assert_eq!(fetch.kind, ToolKind::Fetch);
        assert_eq!(fetch.title, "WebFetch: https://example.com");
        assert_eq!(fetch.raw_input, fetch_input);
    }

    #[test]
    fn acp_describe_tool_call_falls_back_for_unknown_or_malformed_input() {
        let unknown = describe_tool_call("x1", "MysteryTool", &json!({"a": 1}));
        assert_eq!(unknown.kind, ToolKind::Other);
        assert_eq!(unknown.title, "MysteryTool");
        assert!(unknown.locations.is_empty());
        assert_eq!(unknown.diff, None);

        let read_without_path = describe_tool_call("r2", "Read", &json!({"offset": 2}));
        assert_eq!(read_without_path.kind, ToolKind::Read);
        assert_eq!(read_without_path.title, "Read");
        assert!(read_without_path.locations.is_empty());

        let edit_bad_path = describe_tool_call("e2", "Edit", &json!({"file_path": 5}));
        assert_eq!(edit_bad_path.title, "Edit");
        assert!(edit_bad_path.locations.is_empty());
        assert_eq!(edit_bad_path.diff, None);

        let bash_not_object = describe_tool_call("b3", "Bash", &json!("not an object"));
        assert_eq!(bash_not_object.kind, ToolKind::Execute);
        assert_eq!(bash_not_object.title, "Bash");

        let grep_empty = describe_tool_call("g2", "Grep", &json!({"pattern": ""}));
        assert_eq!(grep_empty.title, "Grep");

        let null_input = describe_tool_call("n2", "WebSearch", &Value::Null);
        assert_eq!(null_input.kind, ToolKind::Fetch);
        assert_eq!(null_input.title, "WebSearch");
        assert_eq!(null_input.raw_input, Value::Null);
    }

    #[test]
    fn acp_truncate_counts_characters_not_bytes() {
        assert_eq!(truncate("短い", 120), "短い");
        assert_eq!(truncate("中文字", 3), "中文字");

        let long = "中".repeat(200);
        let cut = truncate(&long, 120);
        assert_eq!(cut.chars().count(), 120);
        assert!(cut.ends_with('…'));
        assert!(cut.starts_with("中中"));

        assert_eq!(truncate("中文字符", 3), "中文…");
        assert_eq!(truncate("abc", 0), "");

        let command = format!("echo {}", "字".repeat(150));
        let bash = describe_tool_call("b", "Bash", &json!({"command": command}));
        assert_eq!(bash.title.chars().count(), 120);
        assert!(bash.title.ends_with('…'));
    }

    #[test]
    fn acp_tool_result_text_flattens_and_caps() {
        assert_eq!(tool_result_text(&json!("hello")), Some("hello".to_string()));

        let blocks = json!([
            {"type": "text", "text": "a"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
            {"type": "text", "text": "b"},
        ]);
        assert_eq!(tool_result_text(&blocks), Some("a\nb".to_string()));

        assert_eq!(tool_result_text(&json!("")), None);
        assert_eq!(
            tool_result_text(&json!([{"type": "image", "source": {}}])),
            None
        );
        assert_eq!(tool_result_text(&json!(42)), None);

        let exact = "字".repeat(MAX_TOOL_RESULT_CHARS);
        assert_eq!(tool_result_text(&json!(exact.clone())), Some(exact));

        let long = "字".repeat(MAX_TOOL_RESULT_CHARS + 5);
        let capped = tool_result_text(&json!(long)).unwrap();
        let suffix = "\n… [truncated, 5 more characters]";
        assert!(capped.ends_with(suffix));
        let kept = capped.strip_suffix(suffix).unwrap();
        assert_eq!(kept.chars().count(), MAX_TOOL_RESULT_CHARS);
    }
}
