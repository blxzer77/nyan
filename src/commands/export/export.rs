//! Maps to: CC `commands/export/export.tsx`.
use crate::tool::ToolUseContext;
use crate::types::message::{Message, UserContent};
use chrono::{DateTime, Local};
use std::path::Path;
use std::sync::Arc;

/// Native carrier of the returned ExportDialog JSX props.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportDialogData {
    pub content: String,
    pub default_filename: String,
}

/// Native carrier of call's onDone-or-JSX result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExportResult {
    Done(String),
    Dialog(ExportDialogData),
}

/// Maps to: CC `commands/export/export.tsx#formatTimestamp`.
fn format_timestamp(date: DateTime<Local>) -> String {
    date.format("%Y-%m-%d-%H%M%S").to_string()
}

/// Maps to: CC `commands/export/export.tsx#extractFirstPrompt`.
pub fn extract_first_prompt(messages: &[Message]) -> String {
    let Some(user) = messages.iter().find_map(|message| match message {
        Message::User(user) => Some(user),
        _ => None,
    }) else {
        return String::new();
    };
    let text = user
        .content
        .iter()
        .find_map(|block| match block {
            UserContent::Text(text) | UserContent::MetaText(text) => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("");
    let line = text
        .trim_matches(|ch: char| (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}')
        .split('\n')
        .next()
        .unwrap_or("");
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() > 50 {
        // Rust strings cannot contain a lone JS surrogate. The filename's
        // source-defined ASCII sanitizer removes this replacement as well.
        format!("{}…", String::from_utf16_lossy(&units[..49]))
    } else {
        line.to_string()
    }
}

/// Maps to: CC `commands/export/export.tsx#sanitizeFilename`.
pub fn sanitize_filename(text: &str) -> String {
    let mut result = String::new();
    for ch in text.to_lowercase().chars() {
        let whitespace = (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}';
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            result.push(ch);
        } else if (whitespace || ch == '-') && !result.ends_with('-') {
            result.push('-');
        }
    }
    result.trim_matches('-').to_string()
}

/// Maps to: CC `commands/export/export.tsx#exportWithReactRenderer`.
async fn export_with_react_renderer(context: &ToolUseContext) -> String {
    crate::utils::export_renderer::render_messages_to_plain_text(
        Arc::new(context.messages.clone()),
        Arc::new(context.tools.clone()),
        None,
    )
    .await
}

/// Maps to: CC `commands/export/export.tsx#call`.
pub async fn call(context: &ToolUseContext, args: &str) -> std::io::Result<ExportResult> {
    let content = export_with_react_renderer(context).await;
    let filename =
        args.trim_matches(|ch: char| (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}');
    if !filename.is_empty() {
        let final_filename = if filename.ends_with(".txt") {
            filename.to_string()
        } else {
            let stem = match filename.rfind('.') {
                Some(index) if index + 1 < filename.len() => &filename[..index],
                _ => filename,
            };
            format!("{stem}.txt")
        };
        // node:path.join concatenates even an absolute second argument.
        let cwd = context.effective_cwd();
        let joined = format!("{}/{}", cwd.display(), final_filename);
        let mut path = std::path::PathBuf::new();
        for component in Path::new(&joined).components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    path.pop();
                }
                component => path.push(component.as_os_str()),
            }
        }
        let filepath = path.display().to_string();
        let output = match crate::utils::slow_operations::write_file_sync_deprecated(
            Path::new(&filepath),
            &content,
            true,
        ) {
            Ok(()) => format!("Conversation exported to: {filepath}"),
            Err(error) => format!("Failed to export conversation: {error}"),
        };
        return Ok(ExportResult::Done(output));
    }
    let first_prompt = extract_first_prompt(&context.messages);
    let timestamp = format_timestamp(Local::now());
    let sanitized = sanitize_filename(&first_prompt);
    let default_filename = if sanitized.is_empty() {
        format!("conversation-{timestamp}.txt")
    } else {
        format!("{timestamp}-{sanitized}.txt")
    };
    Ok(ExportResult::Dialog(ExportDialogData {
        content,
        default_filename,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::messages::create_user_message;

    #[test]
    fn export_prompt_and_filename_match_official_utf16_and_ecmascript_rules() {
        // Match export.tsx:21-45's raw message input, not createUserMessage's
        // separate empty-content → NO_CONTENT_MESSAGE normalization.
        let message = |text: &str| {
            let mut user = create_user_message(text.to_string());
            user.content = vec![UserContent::Text(text.to_string())];
            Message::User(user)
        };
        assert_eq!(extract_first_prompt(&[]), "");
        assert_eq!(
            extract_first_prompt(&[message("\u{feff} hello\nsecond  ")]),
            "hello"
        );
        assert_eq!(extract_first_prompt(&[message(""), message("second")]), "");
        assert_eq!(
            extract_first_prompt(&[message(&"x".repeat(51))]),
            format!("{}…", "x".repeat(49))
        );
        for (input, expected) in [
            ("Hello, WORLD!", "hello-world"),
            ("中文", ""),
            ("-- one  two --", "one-two"),
            ("a\u{85}b", "ab"),
            ("a\u{feff}b", "a-b"),
            ("İ", "i"),
        ] {
            assert_eq!(sanitize_filename(input), expected, "{input:?}");
        }
    }
    #[tokio::test]
    async fn export_call_matches_official_file_dialog_and_failure_receipts() {
        let dir = std::env::temp_dir().join(format!("nyan-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let context =
            ToolUseContext::default().with_cwd_override(Some(dir.as_path().to_path_buf()));
        let result = call(&context, " transcript.md ").await.unwrap();
        let ExportResult::Done(output) = result else {
            panic!("direct export must not mount dialog")
        };
        assert_eq!(
            output,
            format!(
                "Conversation exported to: {}",
                dir.as_path().join("transcript.txt").display()
            )
        );
        assert!(dir.as_path().join("transcript.txt").is_file());
        let content = std::fs::read_to_string(dir.as_path().join("transcript.txt")).unwrap();
        assert!(!content.contains("RenderableMessageKind"));
        assert!(!content.contains('\u{1b}'));
        let ExportResult::Done(error) = call(&context, "missing/file").await.unwrap() else {
            panic!("failure is onDone")
        };
        assert!(
            error.starts_with("Failed to export conversation: ENOENT:"),
            "{error}"
        );
        let ExportResult::Dialog(data) = call(&context, "\u{feff}  ").await.unwrap() else {
            panic!("empty args mount dialog")
        };
        assert!(data.default_filename.starts_with("conversation-"));
        assert!(data.default_filename.ends_with(".txt"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
