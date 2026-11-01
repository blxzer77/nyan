//! Maps to: CC `utils/logoV2Utils.ts`.
//!
//! This module contains LogoV2 runtime-data helpers, not UI rendering. Official
//! code preloads recent activity asynchronously into a module cache and render
//! code reads `getRecentActivitySync()`. Nyan currently uses a read-only
//! synchronous producer from existing lite session metadata: no transcript
//! writes, resume mutation, title generation, or session-file cleanup occurs.

use crate::utils::format::format_relative_time_ago_millis;
use crate::utils::session_storage::{self, SessionSummary};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecentActivityLogOption {
    /// Maps to CC `types/logs.ts` `LogOption.summary`.
    pub summary: Option<String>,
    /// Maps to CC `types/logs.ts` `LogOption.firstPrompt`.
    pub first_prompt: Option<String>,
    /// Maps to CC `formatRelativeTimeAgo(log.modified)` used by
    /// `components/LogoV2/feedConfigs.tsx` `createRecentActivityFeed`.
    pub timestamp: String,
}

/// Maps to: CC `utils/logoV2Utils.ts` `getRecentActivitySync` after
/// `getRecentActivity()` has populated its module cache.
pub fn get_recent_activity_readonly(current_session_id: &str) -> Vec<RecentActivityLogOption> {
    let sessions = session_storage::list_all_project_sessions();
    recent_activity_from_session_summaries(&sessions, current_session_id, SystemTime::now())
}

/// Maps to: CC `utils/logoV2Utils.ts` `getRecentActivity` filter and slice.
pub fn recent_activity_from_session_summaries(
    sessions: &[SessionSummary],
    current_session_id: &str,
    now: SystemTime,
) -> Vec<RecentActivityLogOption> {
    let now_ms = system_time_millis(now);
    sessions
        .iter()
        .filter(|session| !session.is_sidechain)
        .filter(|session| session.session_id != current_session_id)
        .filter(|session| {
            !session
                .summary
                .as_deref()
                .is_some_and(|summary| summary.contains("I apologize"))
        })
        .filter(|session| {
            let has_summary = session
                .summary
                .as_deref()
                .is_some_and(|summary| !summary.is_empty() && summary != "No prompt");
            let has_first_prompt = !session.display.is_empty() && session.display != "No prompt";
            has_summary || has_first_prompt
        })
        .take(3)
        .map(|session| RecentActivityLogOption {
            summary: session.summary.clone(),
            first_prompt: (!session.display.is_empty()).then(|| session.display.clone()),
            timestamp: format_relative_time_ago_millis(
                system_time_millis(session.modified),
                now_ms,
            ),
        })
        .collect()
}

fn system_time_millis(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis().min(i64::MAX as u128) as i64,
        Err(error) => -(error.duration().as_millis().min(i64::MAX as u128) as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn summary(
        id: &str,
        display: &str,
        summary: Option<&str>,
        modified_secs: u64,
    ) -> SessionSummary {
        SessionSummary {
            session_id: id.to_string(),
            display: display.to_string(),
            summary: summary.map(str::to_string),
            modified: UNIX_EPOCH + Duration::from_secs(modified_secs),
            ..Default::default()
        }
    }

    #[test]
    fn recent_activity_filters_like_official_logo_v2_preload() {
        let now = UNIX_EPOCH + Duration::from_secs(3600);
        let mut sidechain = summary("side", "side prompt", None, 3500);
        sidechain.is_sidechain = true;
        let sessions = vec![
            sidechain,
            summary("current", "current prompt", None, 3500),
            summary(
                "apology",
                "other",
                Some("I apologize for the confusion"),
                3500,
            ),
            summary("empty", "No prompt", Some("No prompt"), 3500),
            summary("summary", "first", Some("Fix parser"), 3540),
            summary("first", "Initial request", Some("No prompt"), 3480),
            summary("third", "Third prompt", None, 3420),
            summary("fourth", "Fourth prompt", None, 3360),
        ];

        let activity = recent_activity_from_session_summaries(&sessions, "current", now);

        assert_eq!(activity.len(), 3);
        assert_eq!(activity[0].summary.as_deref(), Some("Fix parser"));
        assert_eq!(activity[0].first_prompt.as_deref(), Some("first"));
        assert_eq!(activity[0].timestamp, "1m ago");
        assert_eq!(activity[1].first_prompt.as_deref(), Some("Initial request"));
        assert_eq!(activity[2].first_prompt.as_deref(), Some("Third prompt"));
    }
}
