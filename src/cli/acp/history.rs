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

/// A session's title as the resume picker shows it: the custom title, else the summary,
/// else the first prompt.
fn session_title(summary: &SessionSummary) -> Option<String> {
    [
        summary.custom_title.as_deref(),
        summary.summary.as_deref(),
        Some(summary.display.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|title| !title.is_empty())
    .map(str::to_string)
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

        let infos = session_infos(
            Path::new("/work"),
            vec![titled, summarized, sidechain, elsewhere],
        );
        let value = serde_json::to_value(&infos).unwrap();
        assert_eq!(
            value.as_array().unwrap().len(),
            3,
            "the sidechain is left out"
        );
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
