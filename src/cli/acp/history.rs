//! Earlier sessions: `session/list` lists the ones recorded for a directory, and
//! `session/load` (see `engine`) replays one before continuing it.

use std::path::{Path, PathBuf};

use agent_client_protocol_schema::v1::{ListSessionsRequest, ListSessionsResponse, SessionInfo};
use serde_json::Value;

use super::transport::{INTERNAL_ERROR, INVALID_PARAMS, RpcError};
use crate::utils::session_storage::SessionSummary;

/// Most sessions one `session/list` returns, newest first. There is no paging yet.
const MAX_LISTED_SESSIONS: usize = 200;

/// Answers `session/list`: the sessions recorded for `cwd` (the process's directory when
/// the request names none), newest first. Subagent transcripts are left out.
pub(super) fn list_sessions_result(params: Value) -> Result<Value, RpcError> {
    let request = serde_json::from_value::<ListSessionsRequest>(params)
        .map_err(|err| RpcError::new(INVALID_PARAMS, format!("Invalid params: {err}")))?;
    let cwd = match request.cwd {
        Some(cwd) => cwd,
        None => std::env::current_dir().map_err(|err| {
            RpcError::new(
                INTERNAL_ERROR,
                format!("failed to read the working directory: {err}"),
            )
        })?,
    };
    let summaries = crate::utils::session_storage::list_sessions(&cwd.to_string_lossy());
    let response = ListSessionsResponse::new(session_infos(&cwd, summaries));
    serde_json::to_value(response)
        .map_err(|err| RpcError::new(INTERNAL_ERROR, format!("Internal error: {err}")))
}

/// The listed sessions for `cwd`, in the order given (newest first).
fn session_infos(cwd: &Path, summaries: Vec<SessionSummary>) -> Vec<SessionInfo> {
    summaries
        .into_iter()
        .filter(|summary| !summary.is_sidechain)
        .take(MAX_LISTED_SESSIONS)
        .map(|summary| {
            let title = session_title(&summary);
            let updated_at = chrono::DateTime::<chrono::Utc>::from(summary.modified)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let cwd = summary
                .project_path
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| cwd.to_path_buf());
            SessionInfo::new(summary.session_id, cwd)
                .title(title)
                .updated_at(updated_at)
        })
        .collect()
}

/// Tags the transcript wraps text in that the user did not type as a prompt.
const TRANSCRIPT_TAGS: [&str; 10] = [
    crate::constants::xml::LOCAL_COMMAND_CAVEAT_TAG,
    crate::constants::xml::LOCAL_COMMAND_STDOUT_TAG,
    crate::constants::xml::LOCAL_COMMAND_STDERR_TAG,
    crate::constants::xml::COMMAND_NAME_TAG,
    crate::constants::xml::COMMAND_MESSAGE_TAG,
    crate::constants::xml::COMMAND_ARGS_TAG,
    crate::constants::xml::BASH_INPUT_TAG,
    crate::constants::xml::BASH_STDOUT_TAG,
    crate::constants::xml::BASH_STDERR_TAG,
    "system-reminder",
];

/// A session's title as the resume picker shows it: the custom title, else the summary,
/// else the first prompt. A candidate that is only transcript markup is skipped.
fn session_title(summary: &SessionSummary) -> Option<String> {
    [
        summary.custom_title.as_deref(),
        summary.summary.as_deref(),
        Some(summary.display.as_str()),
    ]
    .into_iter()
    .flatten()
    .find_map(title_text)
}

/// The readable text of a title candidate: transcript markup (such as
/// `<local-command-caveat>…</local-command-caveat>`) is left out. `None` when nothing
/// else is there, or when the candidate was cut short inside such a block, so its
/// closing tag is gone and what is left is the block's content, not a prompt.
fn title_text(candidate: &str) -> Option<String> {
    let text = crate::utils::display_tags::strip_display_tags_allow_empty(candidate);
    let cut_inside_markup = TRANSCRIPT_TAGS.iter().any(|tag| {
        text.strip_prefix('<')
            .and_then(|rest| rest.strip_prefix(tag))
            .is_some_and(|rest| rest.starts_with('>'))
    });
    (!text.is_empty() && !cut_inside_markup).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn summary(id: &str, display: &str) -> SessionSummary {
        SessionSummary {
            session_id: id.to_string(),
            display: display.to_string(),
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000),
            ..Default::default()
        }
    }

    #[test]
    fn acp_session_infos_title_order_and_sidechains() {
        let mut titled = summary("a", "first prompt");
        titled.custom_title = Some("My title".into());
        titled.summary = Some("A summary".into());
        let mut summarized = summary("b", "first prompt");
        summarized.summary = Some("  A summary  ".into());
        let mut sidechain = summary("c", "agent");
        sidechain.is_sidechain = true;
        let mut elsewhere = summary("d", "");
        elsewhere.project_path = Some("/other".into());
        let caveat = summary(
            "e",
            "<local-command-caveat>Caveat: generated by a command</local-command-caveat>",
        );
        let mut caveat_then_prompt = summary(
            "f",
            "<local-command-caveat>c</local-command-caveat>\nfix the build",
        );
        caveat_then_prompt.summary = Some("<command-name>/x</command-name>".into());
        // The first prompt is stored cut short, which can lose the closing tag.
        let cut_caveat = summary("g", "<local-command-caveat>Caveat: The messages below w");
        // A prompt that merely starts with some other tag is kept.
        let html = summary("h", "<div> does not render, why?");

        let infos = session_infos(
            Path::new("/work"),
            vec![
                titled,
                summarized,
                sidechain,
                elsewhere,
                caveat,
                caveat_then_prompt,
                cut_caveat,
                html,
            ],
        );
        let value = serde_json::to_value(&infos).unwrap();
        assert_eq!(
            value.as_array().unwrap().len(),
            7,
            "the sidechain is left out"
        );
        assert!(value[3].get("title").is_none(), "only markup, no title");
        assert_eq!(value[4]["title"], "fix the build");
        assert!(value[5].get("title").is_none(), "cut inside markup");
        assert_eq!(value[6]["title"], "<div> does not render, why?");
        assert_eq!(value[0]["sessionId"], "a");
        assert_eq!(value[0]["title"], "My title");
        assert_eq!(value[0]["cwd"], "/work");
        assert_eq!(value[0]["updatedAt"], "2027-01-15T08:00:00Z");
        assert_eq!(value[1]["title"], "A summary");
        assert_eq!(value[2]["sessionId"], "d");
        assert_eq!(value[2]["cwd"], "/other");
        assert!(value[2].get("title").is_none(), "no text, no title");
    }
}
