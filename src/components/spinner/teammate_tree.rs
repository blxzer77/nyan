//! Maps to CC `components/Spinner/TeammateSpinnerTree.tsx` and
//! `TeammateSpinnerLine.tsx` for the main-screen-safe subset.
//!
//! Nyan does not have live in-process teammate tasks yet, so this component
//! accepts explicit task data. That keeps the official tree/line renderer seam
//! available without introducing model, task, tool, fullscreen, or session I/O.

use crate::constants::figures::figures;
use crate::utils::format::format_number;
use crate::utils::theme::Theme;
use iocraft::prelude::*;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub const TEAMMATE_SELECT_HINT: &str = "shift + ↑/↓ to select";
const MIN_ACTIVITY_WIDTH: usize = 25;
const BASE_PREFIX_WIDTH: usize = 8;

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TeammateSpinnerColor {
    Red,
    Blue,
    Green,
    Yellow,
    Purple,
    Orange,
    Pink,
    #[default]
    Cyan,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TeammateRecentActivity {
    pub activity_description: Option<String>,
    pub is_search: bool,
    pub is_read: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TeammateSpinnerTask {
    pub id: String,
    pub agent_name: String,
    pub color: TeammateSpinnerColor,
    pub activity: Option<String>,
    /// Explicit spinner verb used when this teammate is foregrounded. If absent,
    /// the main spinner can fall back to recent activity or the leader verb.
    pub spinner_verb: Option<String>,
    pub recent_activities: Vec<TeammateRecentActivity>,
    pub is_idle: bool,
    pub idle_text: Option<String>,
    pub past_tense_status: Option<String>,
    pub shutdown_requested: bool,
    pub awaiting_plan_approval: bool,
    pub tool_use_count: usize,
    pub token_count: usize,
    /// Explicit frozen work duration used by the foregrounded-idle spinner row.
    pub worked_for_ms: Option<u64>,
    pub preview_lines: Vec<String>,
}

pub const IN_PROCESS_TEAMMATE_TASK_TYPE: &str = "in_process_teammate";
pub const RUNNING_TASK_STATUS: &str = "running";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TeammateMessageBlockSnapshot {
    Text {
        text: String,
    },
    ToolUse {
        name: String,
        description: Option<String>,
        prompt: Option<String>,
        command: Option<String>,
        query: Option<String>,
        pattern: Option<String>,
    },
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TeammateMessageSnapshot {
    pub message_type: String,
    pub blocks: Vec<TeammateMessageBlockSnapshot>,
}

/// Spinner/UI snapshot of an in-process teammate task.
/// Stored in `AppState.tasks` as [`crate::state::app_state_store::TaskState::InProcessTeammate`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TeammateTaskSnapshot {
    pub id: String,
    pub task_type: String,
    pub status: String,
    /// Maps to: CC `TaskStateBase.notified` — projected from the in-process
    /// teammate registry so `evict_terminal_task` can apply CC's guard
    /// (utils/task/framework.ts:133). P4 (2026-08-02).
    pub notified: bool,
    pub agent_name: String,
    pub color: Option<String>,
    pub is_idle: bool,
    pub idle_text: Option<String>,
    pub past_tense_status: Option<String>,
    pub shutdown_requested: bool,
    pub awaiting_plan_approval: bool,
    pub tool_use_count: usize,
    pub token_count: usize,
    /// Frozen work duration from the readonly task snapshot. This substitutes
    /// for official `Date.now() - startTime - totalPausedMs` without a live task.
    pub worked_for_ms: Option<u64>,
    pub last_activity_description: Option<String>,
    /// Official `spinnerVerb` snapshot for the foregrounded teammate row.
    pub spinner_verb: Option<String>,
    pub recent_activities: Vec<TeammateRecentActivity>,
    pub messages: Vec<TeammateMessageSnapshot>,
}

/// Pure counterpart of official `getRunningTeammatesSorted(tasks)` plus the
/// `TeammateSpinnerLine` prop projection. It accepts an explicit task snapshot
/// instead of reading AppState, so the main-screen renderer keeps the task-store
/// seam without starting teammate execution or mutating runtime state.
pub fn running_teammate_spinner_tasks_from_snapshots(
    snapshots: &[TeammateTaskSnapshot],
) -> Vec<TeammateSpinnerTask> {
    let mut running = snapshots
        .iter()
        .filter(|snapshot| {
            snapshot.task_type == IN_PROCESS_TEAMMATE_TASK_TYPE
                && snapshot.status == RUNNING_TASK_STATUS
        })
        .collect::<Vec<_>>();
    running.sort_by(|a, b| a.agent_name.cmp(&b.agent_name));

    running
        .into_iter()
        .map(|snapshot| TeammateSpinnerTask {
            id: snapshot.id.clone(),
            agent_name: snapshot.agent_name.clone(),
            color: parse_teammate_spinner_color(snapshot.color.as_deref()),
            activity: snapshot.last_activity_description.clone(),
            spinner_verb: snapshot.spinner_verb.clone(),
            recent_activities: snapshot.recent_activities.clone(),
            is_idle: snapshot.is_idle,
            idle_text: snapshot.idle_text.clone(),
            past_tense_status: snapshot.past_tense_status.clone(),
            shutdown_requested: snapshot.shutdown_requested,
            awaiting_plan_approval: snapshot.awaiting_plan_approval,
            tool_use_count: snapshot.tool_use_count,
            token_count: snapshot.token_count,
            worked_for_ms: snapshot.worked_for_ms,
            preview_lines: teammate_message_preview_lines(&snapshot.messages),
        })
        .collect()
}

/// Maps to: CC `getAllInProcessTeammateTasks(tasks)` filtered to running,
/// then projected for `TeammateSpinnerTree`.
pub fn running_teammate_spinner_tasks_from_app_tasks(
    tasks: &std::collections::BTreeMap<
        String,
        std::sync::Arc<crate::state::app_state_store::TaskState>,
    >,
) -> Vec<TeammateSpinnerTask> {
    let snapshots = tasks
        .values()
        .filter_map(|task| task.as_in_process_teammate())
        .cloned()
        .collect::<Vec<_>>();
    running_teammate_spinner_tasks_from_snapshots(&snapshots)
}

fn parse_teammate_spinner_color(value: Option<&str>) -> TeammateSpinnerColor {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("red") => TeammateSpinnerColor::Red,
        Some("blue") => TeammateSpinnerColor::Blue,
        Some("green") => TeammateSpinnerColor::Green,
        Some("yellow") => TeammateSpinnerColor::Yellow,
        Some("purple") => TeammateSpinnerColor::Purple,
        Some("orange") => TeammateSpinnerColor::Orange,
        Some("pink") => TeammateSpinnerColor::Pink,
        Some("cyan") => TeammateSpinnerColor::Cyan,
        _ => TeammateSpinnerColor::Cyan,
    }
}

/// Pure counterpart of official `TeammateSpinnerLine.tsx#getMessagePreview`.
pub fn teammate_message_preview_lines(messages: &[TeammateMessageSnapshot]) -> Vec<String> {
    let mut lines = Vec::new();

    for message in messages.iter().rev() {
        if lines.len() >= 3 {
            break;
        }
        if message.message_type != "user" && message.message_type != "assistant" {
            continue;
        }

        for block in &message.blocks {
            if lines.len() >= 3 {
                break;
            }
            match block {
                TeammateMessageBlockSnapshot::ToolUse {
                    name,
                    description,
                    prompt,
                    command,
                    query,
                    pattern,
                } => {
                    let fallback = format!("Using {name}…");
                    let tool_line = [
                        description.as_deref(),
                        prompt.as_deref(),
                        command.as_deref(),
                        query.as_deref(),
                        pattern.as_deref(),
                    ]
                    .into_iter()
                    .flatten()
                    .find(|text| !text.trim().is_empty())
                    .and_then(|text| text.lines().next())
                    .unwrap_or(fallback.as_str());
                    lines.push(truncate_to_width(tool_line, 80));
                }
                TeammateMessageBlockSnapshot::Text { text } => {
                    let text_lines = text
                        .lines()
                        .filter(|line| !line.trim().is_empty())
                        .collect::<Vec<_>>();
                    for line in text_lines.iter().rev() {
                        if lines.len() >= 3 {
                            break;
                        }
                        lines.push(truncate_to_width(line, 80));
                    }
                }
                TeammateMessageBlockSnapshot::Other => {}
            }
        }
    }

    lines.reverse();
    lines
}

#[derive(Default, Props)]
pub struct TeammateSpinnerTreeProps {
    pub tasks: Vec<TeammateSpinnerTask>,
    pub selected_index: Option<i32>,
    pub is_in_selection_mode: bool,
    pub all_idle: bool,
    /// `None` means the leader is foregrounded. Any teammate ID backgrounds the
    /// leader, matching official `viewingAgentTaskId` semantics.
    pub viewing_teammate_id: Option<String>,
    pub leader_verb: Option<String>,
    pub leader_token_count: Option<usize>,
    pub leader_idle_text: Option<String>,
    pub show_preview: bool,
}

fn teammate_color(color: TeammateSpinnerColor, theme: &Theme) -> Color {
    match color {
        TeammateSpinnerColor::Red => theme.agent_red,
        TeammateSpinnerColor::Blue => theme.agent_blue,
        TeammateSpinnerColor::Green => theme.agent_green,
        TeammateSpinnerColor::Yellow => theme.agent_yellow,
        TeammateSpinnerColor::Purple => theme.agent_purple,
        TeammateSpinnerColor::Orange => theme.agent_orange,
        TeammateSpinnerColor::Pink => theme.agent_pink,
        TeammateSpinnerColor::Cyan => theme.agent_cyan,
    }
}

fn truncate_to_width(text: &str, max_width: usize) -> String {
    if max_width == 0 || UnicodeWidthStr::width(text) <= max_width {
        return text.to_string();
    }

    let ellipsis_width = UnicodeWidthStr::width("…");
    if max_width <= ellipsis_width {
        return "…".to_string();
    }

    let mut out = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + ch_width + ellipsis_width > max_width {
            break;
        }
        used += ch_width;
        out.push(ch);
    }
    out.push('…');
    out
}

fn with_ellipsis(text: &str) -> String {
    if text.ends_with('…') || text.ends_with("...") {
        text.to_string()
    } else {
        format!("{text}…")
    }
}

/// CC's `summarizeRecentActivities` accepts the structural
/// `{activityDescription?, isSearch?, isRead?}`; this is that shape for the
/// teammate spinner's row type.
impl crate::utils::collapse_read_search::RecentActivity for TeammateRecentActivity {
    fn is_search(&self) -> bool {
        self.is_search
    }

    fn is_read(&self) -> bool {
        self.is_read
    }

    fn activity_description(&self) -> Option<String> {
        self.activity_description.clone()
    }
}

/// Maps to: CC `utils/collapseReadSearch.ts:1074#summarizeRecentActivities`.
/// The rollup and its summary text belong to that shared utility (CC calls it
/// from the spinner, not the other way round); this module previously carried
/// a private search/read-only copy whose text also diverged — it emitted `…`
/// on an empty part list and never produced the past-tense or
/// memory/list/REPL segments.
fn summarize_recent_activities(activities: &[TeammateRecentActivity]) -> Option<String> {
    crate::utils::collapse_read_search::summarize_recent_activities(activities)
}

fn status_for_task(
    task: &TeammateSpinnerTask,
    all_idle: bool,
    activity_max_width: usize,
) -> String {
    if task.shutdown_requested {
        return "[stopping]".to_string();
    }
    if task.awaiting_plan_approval {
        return "[awaiting approval]".to_string();
    }
    if task.is_idle {
        if all_idle {
            return task
                .past_tense_status
                .clone()
                .or_else(|| {
                    task.idle_text
                        .as_ref()
                        .map(|idle| format!("Finished for {idle}"))
                })
                .unwrap_or_else(|| "Finished".to_string());
        }
        return task.idle_text.clone().unwrap_or_else(|| "Idle".to_string());
    }

    let activity = summarize_recent_activities(&task.recent_activities)
        .or_else(|| task.activity.clone())
        .unwrap_or_else(|| "Working".to_string());
    with_ellipsis(&truncate_to_width(&activity, activity_max_width))
}

#[component]
pub fn TeammateSpinnerTree(
    props: &TeammateSpinnerTreeProps,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    if props.tasks.is_empty() {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    }

    let theme = hooks.use_context::<Theme>();
    let (columns, _) = hooks.use_terminal_size();
    let columns = columns as usize;
    let selected_index = props.selected_index;
    let is_leader_foregrounded = props.viewing_teammate_id.is_none();
    let is_leader_selected = props.is_in_selection_mode && selected_index == Some(-1);
    let is_leader_highlighted = is_leader_foregrounded || is_leader_selected;
    let is_hide_selected =
        props.is_in_selection_mode && selected_index == Some(props.tasks.len() as i32);
    let leader_tree = if is_leader_highlighted {
        "╒═"
    } else {
        "┌─"
    };
    let leader_pointer = if is_leader_selected {
        figures().pointer
    } else {
        " "
    };
    let leader_status = if !is_leader_foregrounded {
        props
            .leader_verb
            .as_ref()
            .map(|verb| format!(": {}", with_ellipsis(verb)))
            .or_else(|| {
                props
                    .leader_idle_text
                    .as_ref()
                    .map(|idle| format!(": {idle}"))
            })
    } else {
        None
    };
    let leader_tokens = props.leader_token_count.filter(|count| *count > 0);

    element! {
        View(flex_direction: FlexDirection::Column, margin_top: 1u32, width: 100pct) {
            View(flex_direction: FlexDirection::Row, padding_left: 3u32, height: 1u32, overflow: Overflow::Hidden) {
                Text(content: leader_pointer.to_string(), color: if is_leader_selected { Some(theme.suggestion) } else { None }, weight: if is_leader_highlighted { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                Text(content: format!("{leader_tree} "), color: if is_leader_highlighted { None } else { Some(theme.inactive) }, weight: if is_leader_highlighted { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                Text(content: "team-lead".to_string(), color: Some(if is_leader_selected { theme.suggestion } else { theme.agent_cyan }), weight: if is_leader_highlighted { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                #(leader_status.map(|status| element! { Text(content: status, color: theme.inactive, wrap: TextWrap::NoWrap) }))
                #(leader_tokens.map(|tokens| element! { Text(content: format!(" · {} tokens", format_number(tokens as u64)), color: if is_leader_highlighted { None } else { Some(theme.inactive) }, wrap: TextWrap::NoWrap) }))
                #(if is_leader_highlighted {
                    Some(element! { Text(content: format!(" · {TEAMMATE_SELECT_HINT}"), color: theme.inactive, wrap: TextWrap::NoWrap) })
                } else { None })
                #(if is_leader_selected && !is_leader_foregrounded {
                    Some(element! { Text(content: " · enter to view".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap) })
                } else { None })
            }
            #(props.tasks.iter().enumerate().map(|(index, task)| {
                let is_selected = props.is_in_selection_mode && selected_index == Some(index as i32);
                let is_foregrounded = props.viewing_teammate_id.as_deref() == Some(task.id.as_str());
                let is_highlighted = is_selected || is_foregrounded;
                let is_last = !props.is_in_selection_mode && index + 1 == props.tasks.len();
                let tree_char = if is_highlighted {
                    if is_last { "╘═" } else { "╞═" }
                } else if is_last {
                    "└─"
                } else {
                    "├─"
                };
                let full_agent_name = format!("@{}", task.agent_name);
                let full_name_width = UnicodeWidthStr::width(full_agent_name.as_str());
                let space_with_full_name = columns.saturating_sub(BASE_PREFIX_WIDTH + full_name_width + 2);
                let show_name = columns >= 60 && space_with_full_name >= MIN_ACTIVITY_WIDTH;
                let name_width = if show_name { full_name_width + 2 } else { 0 };
                let available_for_activity = columns.saturating_sub(BASE_PREFIX_WIDTH + name_width);
                let stats_text = format!(
                    " · {} tool {} · {} tokens",
                    task.tool_use_count,
                    if task.tool_use_count == 1 { "use" } else { "uses" },
                    format_number(task.token_count as u64),
                );
                let stats_width = UnicodeWidthStr::width(stats_text.as_str());
                let select_hint = format!(" · {TEAMMATE_SELECT_HINT}");
                let select_hint_width = UnicodeWidthStr::width(select_hint.as_str());
                let view_hint = " · enter to view";
                let view_hint_width = UnicodeWidthStr::width(view_hint);
                let show_view_hint = is_selected
                    && !is_foregrounded
                    && available_for_activity > view_hint_width + stats_width + MIN_ACTIVITY_WIDTH + 5;
                let show_select_hint = is_highlighted
                    && available_for_activity
                        > select_hint_width
                            + if show_view_hint { view_hint_width } else { 0 }
                            + stats_width
                            + MIN_ACTIVITY_WIDTH
                            + 5;
                let show_stats = available_for_activity > stats_width + MIN_ACTIVITY_WIDTH + 5;
                let extras_cost = if show_stats { stats_width } else { 0 }
                    + if show_select_hint { select_hint_width } else { 0 }
                    + if show_view_hint { view_hint_width } else { 0 };
                let activity_max_width = available_for_activity
                    .saturating_sub(extras_cost + 1)
                    .max(MIN_ACTIVITY_WIDTH);
                let status = status_for_task(task, props.all_idle, activity_max_width);
                let status_color = if task.awaiting_plan_approval { theme.warning } else { theme.inactive };
                let pointer = if is_selected { figures().pointer } else { " " }.to_string();
                let preview_tree_char = if is_last { "   " } else { "│  " }.to_string();
                element! {
                    View(flex_direction: FlexDirection::Column) {
                        View(flex_direction: FlexDirection::Row, padding_left: 3u32, height: 1u32, overflow: Overflow::Hidden) {
                            Text(content: pointer, color: if is_selected { Some(theme.suggestion) } else { None }, weight: if is_selected { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                            Text(content: format!("{tree_char} "), color: if is_selected { None } else { Some(theme.inactive) }, wrap: TextWrap::NoWrap)
                            #(if show_name {
                                Some(element! { Text(content: full_agent_name, color: Some(if is_selected { theme.suggestion } else { teammate_color(task.color, &theme) }), wrap: TextWrap::NoWrap) })
                            } else { None })
                            #(if show_name {
                                Some(element! { Text(content: ": ".to_string(), color: if is_selected { None } else { Some(theme.inactive) }, wrap: TextWrap::NoWrap) })
                            } else { None })
                            #(if is_highlighted && !task.shutdown_requested && !task.awaiting_plan_approval && !task.is_idle {
                                None
                            } else {
                                Some(element! { Text(content: status, color: status_color, wrap: TextWrap::NoWrap) })
                            })
                            #(if show_stats {
                                Some(element! { Text(content: stats_text, color: theme.inactive, wrap: TextWrap::NoWrap) })
                            } else { None })
                            #(if show_select_hint {
                                Some(element! { Text(content: select_hint, color: theme.inactive, wrap: TextWrap::NoWrap) })
                            } else { None })
                            #(if show_view_hint {
                                Some(element! { Text(content: view_hint.to_string(), color: theme.inactive, wrap: TextWrap::NoWrap) })
                            } else { None })
                        }
                        #(if props.show_preview {
                            Some(element! {
                                View(flex_direction: FlexDirection::Column) {
                                    #(task.preview_lines.iter().take(3).map(|line| {
                                        let preview_line = truncate_to_width(line, 80);
                                        let preview_tree_char = preview_tree_char.clone();
                                        element! {
                                            View(flex_direction: FlexDirection::Row, padding_left: 3u32, height: 1u32, overflow: Overflow::Hidden) {
                                                Text(content: " ".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap)
                                                Text(content: format!("{preview_tree_char} "), color: theme.inactive, wrap: TextWrap::NoWrap)
                                                Text(content: preview_line, color: theme.inactive, wrap: TextWrap::NoWrap)
                                            }
                                        }
                                    }))
                                }
                            })
                        } else { None })
                    }
                }
            }))
            #(if props.is_in_selection_mode {
                Some(element! {
                    View(flex_direction: FlexDirection::Row, padding_left: 3u32, height: 1u32, overflow: Overflow::Hidden) {
                        Text(content: if is_hide_selected { figures().pointer.to_string() } else { " ".to_string() }, color: if is_hide_selected { Some(theme.suggestion) } else { None }, weight: if is_hide_selected { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                        Text(content: format!("{} ", if is_hide_selected { "╘═" } else { "└─" }), color: if is_hide_selected { None } else { Some(theme.inactive) }, weight: if is_hide_selected { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                        Text(content: "hide".to_string(), color: if is_hide_selected { None } else { Some(theme.inactive) }, weight: if is_hide_selected { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                        #(if is_hide_selected {
                            Some(element! { Text(content: " · enter to collapse".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap) })
                        } else { None })
                    }
                })
            } else { None })
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render_tree(props: TeammateSpinnerTreeProps) -> String {
        element! {
            ContextProvider(value: Context::owned(*crate::utils::theme::current())) {
                TeammateSpinnerTree(
                    tasks: props.tasks,
                    selected_index: props.selected_index,
                    is_in_selection_mode: props.is_in_selection_mode,
                    all_idle: props.all_idle,
                    viewing_teammate_id: props.viewing_teammate_id,
                    leader_verb: props.leader_verb,
                    leader_token_count: props.leader_token_count,
                    leader_idle_text: props.leader_idle_text,
                    show_preview: props.show_preview,
                )
            }
        }
        .render(Some(100))
        .to_string()
    }

    fn task(id: &str, name: &str, activity: &str) -> TeammateSpinnerTask {
        TeammateSpinnerTask {
            id: id.to_string(),
            agent_name: name.to_string(),
            activity: Some(activity.to_string()),
            tool_use_count: 2,
            token_count: 4_200,
            preview_lines: vec![
                "checked permissions".to_string(),
                "verified UI-only seam".to_string(),
            ],
            ..Default::default()
        }
    }

    fn teammate_snapshot(id: &str, name: &str, status: &str) -> TeammateTaskSnapshot {
        TeammateTaskSnapshot {
            id: id.to_string(),
            task_type: IN_PROCESS_TEAMMATE_TASK_TYPE.to_string(),
            status: status.to_string(),
            agent_name: name.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn running_teammate_spinner_tasks_filter_sort_and_project_official_task_store_shape() {
        let mut zebra = teammate_snapshot("z", "zebra", RUNNING_TASK_STATUS);
        zebra.color = Some("purple".to_string());
        zebra.tool_use_count = 3;
        zebra.token_count = 12_345;
        zebra.last_activity_description = Some("Reviewing patch".to_string());
        zebra.spinner_verb = Some("Reviewing teammate work".to_string());
        zebra.recent_activities = vec![TeammateRecentActivity {
            activity_description: Some("Reading files".to_string()),
            is_read: true,
            ..Default::default()
        }];
        let mut alpha = teammate_snapshot("a", "alpha", RUNNING_TASK_STATUS);
        alpha.color = Some("orange".to_string());
        alpha.awaiting_plan_approval = true;
        alpha.messages = vec![TeammateMessageSnapshot {
            message_type: "assistant".to_string(),
            blocks: vec![TeammateMessageBlockSnapshot::Text {
                text: "First\nSecond".to_string(),
            }],
        }];
        let stopped = teammate_snapshot("s", "stopped", "completed");
        let non_teammate = TeammateTaskSnapshot {
            id: "other".to_string(),
            task_type: "local_agent".to_string(),
            status: RUNNING_TASK_STATUS.to_string(),
            agent_name: "other".to_string(),
            ..Default::default()
        };

        let tasks =
            running_teammate_spinner_tasks_from_snapshots(&[zebra, stopped, alpha, non_teammate]);

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].agent_name, "alpha");
        assert_eq!(tasks[0].color, TeammateSpinnerColor::Orange);
        assert!(tasks[0].awaiting_plan_approval);
        assert_eq!(tasks[0].preview_lines, vec!["First", "Second"]);
        assert_eq!(tasks[1].agent_name, "zebra");
        assert_eq!(tasks[1].color, TeammateSpinnerColor::Purple);
        assert_eq!(tasks[1].tool_use_count, 3);
        assert_eq!(tasks[1].token_count, 12_345);
        assert_eq!(tasks[1].activity.as_deref(), Some("Reviewing patch"));
        assert_eq!(
            tasks[1].spinner_verb.as_deref(),
            Some("Reviewing teammate work")
        );
        assert_eq!(tasks[1].recent_activities.len(), 1);
    }

    #[test]
    fn teammate_message_preview_lines_match_official_recent_message_rules() {
        let messages = vec![
            TeammateMessageSnapshot {
                message_type: "system".to_string(),
                blocks: vec![TeammateMessageBlockSnapshot::Text {
                    text: "Ignored".to_string(),
                }],
            },
            TeammateMessageSnapshot {
                message_type: "user".to_string(),
                blocks: vec![TeammateMessageBlockSnapshot::Text {
                    text: "older line".to_string(),
                }],
            },
            TeammateMessageSnapshot {
                message_type: "assistant".to_string(),
                blocks: vec![
                    TeammateMessageBlockSnapshot::ToolUse {
                        name: "Bash".to_string(),
                        description: None,
                        prompt: None,
                        command: Some("cargo test\n--nocapture".to_string()),
                        query: None,
                        pattern: None,
                    },
                    TeammateMessageBlockSnapshot::Text {
                        text: "\nnewer one\nnewer two".to_string(),
                    },
                ],
            },
        ];

        assert_eq!(
            teammate_message_preview_lines(&messages),
            vec!["newer one", "newer two", "cargo test"]
        );
    }

    #[test]
    fn teammate_message_preview_lines_use_tool_fallback_and_cap_to_three() {
        let messages = vec![TeammateMessageSnapshot {
            message_type: "assistant".to_string(),
            blocks: vec![
                TeammateMessageBlockSnapshot::ToolUse {
                    name: "Read".to_string(),
                    description: None,
                    prompt: None,
                    command: None,
                    query: None,
                    pattern: None,
                },
                TeammateMessageBlockSnapshot::Text {
                    text: "one\ntwo\nthree\nfour".to_string(),
                },
            ],
        }];

        assert_eq!(
            teammate_message_preview_lines(&messages),
            vec!["three", "four", "Using Read…"]
        );
    }

    #[test]
    fn teammate_spinner_tree_renders_official_leader_teammate_and_hide_rows() {
        let text = render_tree(TeammateSpinnerTreeProps {
            tasks: vec![
                task("reviewer", "reviewer", "Reviewing diff"),
                task("runner", "runner", "Running tests"),
            ],
            selected_index: Some(-1),
            is_in_selection_mode: true,
            viewing_teammate_id: Some("reviewer".to_string()),
            leader_verb: Some("Thinking".to_string()),
            leader_token_count: Some(1_200),
            ..Default::default()
        });

        assert!(text.contains("❯╒═ team-lead: Thinking…"), "canvas=\n{text}");
        assert!(text.contains("1.2k tokens"), "canvas=\n{text}");
        assert!(text.contains(TEAMMATE_SELECT_HINT), "canvas=\n{text}");
        assert!(text.contains("╞═ @reviewer"), "canvas=\n{text}");
        assert!(
            text.contains("├─ @runner: Running tests…"),
            "canvas=\n{text}"
        );
        assert!(text.contains("└─ hide"), "canvas=\n{text}");
    }

    #[test]
    fn teammate_spinner_tree_renders_statuses_and_preview_lines() {
        let mut idle = task("idle", "idle", "Waiting");
        idle.is_idle = true;
        idle.past_tense_status = Some("Reviewed for 2m".to_string());
        let mut approval = task("planner", "planner", "Plan review");
        approval.awaiting_plan_approval = true;
        let mut stopping = task("stop", "stop", "Stopping");
        stopping.shutdown_requested = true;

        let text = render_tree(TeammateSpinnerTreeProps {
            tasks: vec![idle, approval, stopping],
            all_idle: true,
            show_preview: true,
            ..Default::default()
        });

        assert!(text.contains("Reviewed for 2m"), "canvas=\n{text}");
        assert!(text.contains("[awaiting approval]"), "canvas=\n{text}");
        assert!(text.contains("[stopping]"), "canvas=\n{text}");
        assert!(text.contains("checked permissions"), "canvas=\n{text}");
    }

    #[test]
    fn teammate_spinner_token_stats_use_official_compact_number_boundaries() {
        let mut large = task("large", "large", "Indexing repository");
        large.token_count = 999_999;

        let text = render_tree(TeammateSpinnerTreeProps {
            tasks: vec![large],
            leader_token_count: Some(999_999),
            ..Default::default()
        });

        assert!(text.contains("1.0m tokens"), "canvas=\n{text}");
        assert!(
            !text.contains("999,999 tokens"),
            "official spinner stats use compact formatNumber; canvas=\n{text}"
        );
    }

    #[test]
    fn teammate_recent_activity_summary_matches_official_search_read_rollup() {
        let activities = vec![
            TeammateRecentActivity {
                activity_description: Some("Writing patch".to_string()),
                ..Default::default()
            },
            TeammateRecentActivity {
                is_search: true,
                ..Default::default()
            },
            TeammateRecentActivity {
                is_read: true,
                ..Default::default()
            },
            TeammateRecentActivity {
                is_read: true,
                ..Default::default()
            },
        ];

        assert_eq!(
            summarize_recent_activities(&activities),
            Some("Searching for 1 pattern, reading 2 files…".to_string())
        );
    }

    #[test]
    fn teammate_recent_activity_summary_falls_back_to_last_description() {
        let activities = vec![
            TeammateRecentActivity {
                activity_description: Some("Older activity".to_string()),
                ..Default::default()
            },
            TeammateRecentActivity {
                activity_description: Some("Latest activity".to_string()),
                is_search: true,
                ..Default::default()
            },
        ];

        assert_eq!(
            summarize_recent_activities(&activities),
            Some("Latest activity".to_string())
        );
    }
}
