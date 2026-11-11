//! Maps to: CC `components/TaskListV2.tsx`.
//!
//! AppState/team-context discovery and completion-expiry timers remain outside
//! this render slice. Callers provide terminal size, recent-completion ids, and
//! optional teammate activity/color maps; this module preserves the official
//! sorting, truncation, hidden-summary, and row rendering semantics.

use crate::constants::figures;
use crate::utils::tasks::is_todo_v2_enabled;
use crate::utils::theme::Theme;
use crate::utils::truncate::truncate_to_width;
use iocraft::prelude::*;
use std::collections::{HashMap, HashSet};
use unicode_width::UnicodeWidthStr;

pub const RECENT_COMPLETED_TTL_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TaskStatusV2 {
    #[default]
    Pending,
    InProgress,
    Completed,
}

impl TaskStatusV2 {
    pub fn as_official_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskV2 {
    pub id: String,
    pub subject: String,
    pub status: TaskStatusV2,
    pub owner: Option<String>,
    pub blocked_by: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskListV2PropsData {
    pub tasks: Vec<TaskV2>,
    pub is_standalone: bool,
    pub rows: usize,
    pub columns: usize,
    pub recent_completed_ids: Vec<String>,
    pub teammate_activity: HashMap<String, String>,
    pub active_teammates: Vec<String>,
    pub teammate_colors: HashMap<String, Color>,
    pub todo_v2_enabled: bool,
}

impl Default for TaskListV2PropsData {
    fn default() -> Self {
        Self {
            tasks: Vec::new(),
            is_standalone: false,
            rows: 24,
            columns: 80,
            recent_completed_ids: Vec::new(),
            teammate_activity: HashMap::new(),
            active_teammates: Vec::new(),
            teammate_colors: HashMap::new(),
            todo_v2_enabled: is_todo_v2_enabled(),
        }
    }
}

#[derive(Default, Props)]
pub struct TaskListV2Props {
    pub data: TaskListV2PropsData,
}

/// Maps to: CC `TaskListV2.tsx#byIdAsc`.
pub fn task_list_v2_by_id_asc(a: &TaskV2, b: &TaskV2) -> std::cmp::Ordering {
    match (a.id.parse::<i64>(), b.id.parse::<i64>()) {
        (Ok(a_num), Ok(b_num)) => a_num.cmp(&b_num),
        _ => a.id.cmp(&b.id),
    }
}

/// Maps to: CC `TaskListV2.tsx` `maxDisplay` calculation.
pub fn task_list_v2_max_display(rows: usize) -> usize {
    if rows <= 10 {
        0
    } else {
        10.min(3.max(rows.saturating_sub(14)))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskListV2Counts {
    pub completed: usize,
    pub pending: usize,
    pub in_progress: usize,
}

/// Maps to: CC `TaskListV2.tsx` task count derivation.
pub fn task_list_v2_counts(tasks: &[TaskV2]) -> TaskListV2Counts {
    let completed = tasks
        .iter()
        .filter(|task| task.status == TaskStatusV2::Completed)
        .count();
    let pending = tasks
        .iter()
        .filter(|task| task.status == TaskStatusV2::Pending)
        .count();
    TaskListV2Counts {
        completed,
        pending,
        in_progress: tasks.len().saturating_sub(completed + pending),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskListV2Visibility {
    pub visible_tasks: Vec<TaskV2>,
    pub hidden_tasks: Vec<TaskV2>,
    pub hidden_summary: String,
}

fn sorted_by_id(mut tasks: Vec<TaskV2>) -> Vec<TaskV2> {
    tasks.sort_by(task_list_v2_by_id_asc);
    tasks
}

/// Maps to: CC `TaskListV2.tsx` truncation/prioritization block.
pub fn task_list_v2_visible_tasks(
    tasks: &[TaskV2],
    max_display: usize,
    recent_completed_ids: &[String],
) -> TaskListV2Visibility {
    let unresolved_task_ids = tasks
        .iter()
        .filter(|task| task.status != TaskStatusV2::Completed)
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();
    let _ = unresolved_task_ids;

    let needs_truncation = tasks.len() > max_display;
    let recent = recent_completed_ids.iter().cloned().collect::<HashSet<_>>();

    let (visible_tasks, hidden_tasks) = if needs_truncation {
        let recent_completed = sorted_by_id(
            tasks
                .iter()
                .filter(|task| task.status == TaskStatusV2::Completed && recent.contains(&task.id))
                .cloned()
                .collect(),
        );
        let in_progress = sorted_by_id(
            tasks
                .iter()
                .filter(|task| task.status == TaskStatusV2::InProgress)
                .cloned()
                .collect(),
        );
        let mut pending = tasks
            .iter()
            .filter(|task| task.status == TaskStatusV2::Pending)
            .cloned()
            .collect::<Vec<_>>();
        let unresolved = tasks
            .iter()
            .filter(|task| task.status != TaskStatusV2::Completed)
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        pending.sort_by(|a, b| {
            let a_blocked = a.blocked_by.iter().any(|id| unresolved.contains(id));
            let b_blocked = b.blocked_by.iter().any(|id| unresolved.contains(id));
            if a_blocked != b_blocked {
                return if a_blocked {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Less
                };
            }
            task_list_v2_by_id_asc(a, b)
        });
        let older_completed = sorted_by_id(
            tasks
                .iter()
                .filter(|task| task.status == TaskStatusV2::Completed && !recent.contains(&task.id))
                .cloned()
                .collect(),
        );
        let prioritized = recent_completed
            .into_iter()
            .chain(in_progress)
            .chain(pending)
            .chain(older_completed)
            .collect::<Vec<_>>();
        (
            prioritized
                .iter()
                .take(max_display)
                .cloned()
                .collect::<Vec<_>>(),
            prioritized
                .iter()
                .skip(max_display)
                .cloned()
                .collect::<Vec<_>>(),
        )
    } else {
        (sorted_by_id(tasks.to_vec()), Vec::new())
    };

    let hidden_summary = task_list_v2_hidden_summary(&hidden_tasks);
    TaskListV2Visibility {
        visible_tasks,
        hidden_tasks,
        hidden_summary,
    }
}

/// Maps to: CC `TaskListV2.tsx` hidden summary copy.
pub fn task_list_v2_hidden_summary(hidden_tasks: &[TaskV2]) -> String {
    if hidden_tasks.is_empty() {
        return String::new();
    }
    let counts = task_list_v2_counts(hidden_tasks);
    let mut parts = Vec::new();
    if counts.in_progress > 0 {
        parts.push(format!("{} in progress", counts.in_progress));
    }
    if counts.pending > 0 {
        parts.push(format!("{} pending", counts.pending));
    }
    if counts.completed > 0 {
        parts.push(format!("{} completed", counts.completed));
    }
    format!(" … +{}", parts.join(", "))
}

/// Maps to: CC `TaskListV2.tsx#getTaskIcon`.
pub fn task_list_v2_icon(status: TaskStatusV2) -> (&'static str, Option<&'static str>) {
    let fig = figures::get();
    match status {
        TaskStatusV2::Completed => (fig.tick, Some("success")),
        TaskStatusV2::InProgress => (fig.square_small_filled, Some("claude")),
        TaskStatusV2::Pending => (fig.square_small, None),
    }
}

fn open_blockers(task: &TaskV2, unresolved_ids: &HashSet<String>) -> Vec<String> {
    task.blocked_by
        .iter()
        .filter(|id| unresolved_ids.contains(*id))
        .cloned()
        .collect()
}

fn blocker_sort_key(id: &str) -> (bool, i64, &str) {
    match id.parse::<i64>() {
        Ok(n) => (false, n, id),
        Err(_) => (true, 0, id),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskListV2RowDisplay {
    pub icon: String,
    pub icon_color_key: Option<&'static str>,
    pub subject: String,
    pub show_owner: bool,
    pub owner: Option<String>,
    pub blocked_text: Option<String>,
    pub activity_text: Option<String>,
    pub completed: bool,
    pub blocked: bool,
    pub in_progress: bool,
}

/// Maps to: CC `TaskListV2.tsx#TaskItem` display derivation.
pub fn task_list_v2_row_display(
    task: &TaskV2,
    open_blockers: &[String],
    activity: Option<&str>,
    owner_active: bool,
    columns: usize,
) -> TaskListV2RowDisplay {
    let is_completed = task.status == TaskStatusV2::Completed;
    let is_in_progress = task.status == TaskStatusV2::InProgress;
    let is_blocked = !open_blockers.is_empty();
    let (icon, color) = task_list_v2_icon(task.status);
    let show_owner = columns >= 60 && task.owner.is_some() && owner_active;
    let owner_width = if show_owner {
        UnicodeWidthStr::width(
            format!(" (@{})", task.owner.as_deref().unwrap_or_default()).as_str(),
        )
    } else {
        0
    };
    let max_subject_width = 15.max(columns.saturating_sub(15 + owner_width));
    let subject = truncate_to_width(&task.subject, max_subject_width);
    let mut blockers = open_blockers.to_vec();
    blockers.sort_by(|a, b| blocker_sort_key(a).cmp(&blocker_sort_key(b)));
    let blocked_text = (!blockers.is_empty()).then(|| {
        format!(
            " {} blocked by {}",
            figures::get().pointer_small,
            blockers
                .iter()
                .map(|id| format!("#{id}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    });
    let max_activity_width = 15.max(columns.saturating_sub(15));
    let activity_text = (is_in_progress && !is_blocked)
        .then(|| {
            activity.map(|text| {
                format!(
                    "  {}{}",
                    truncate_to_width(text, max_activity_width),
                    figures::get().ellipsis
                )
            })
        })
        .flatten();

    TaskListV2RowDisplay {
        icon: icon.to_string(),
        icon_color_key: color,
        subject,
        show_owner,
        owner: task.owner.clone(),
        blocked_text,
        activity_text,
        completed: is_completed,
        blocked: is_blocked,
        in_progress: is_in_progress,
    }
}

fn themed_color(theme: &Theme, key: Option<&str>) -> Option<Color> {
    match key {
        Some("success") => Some(theme.success),
        Some("claude") => Some(theme.nyan),
        _ => None,
    }
}

/// Maps to: CC `components/TaskListV2.tsx#TaskListV2`.
#[component]
pub fn TaskListV2(props: &TaskListV2Props, hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let data = props.data.clone();
    if !data.todo_v2_enabled || data.tasks.is_empty() {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    }
    let max_display = task_list_v2_max_display(data.rows);
    let visibility =
        task_list_v2_visible_tasks(&data.tasks, max_display, &data.recent_completed_ids);
    let counts = task_list_v2_counts(&data.tasks);
    let unresolved_ids = data
        .tasks
        .iter()
        .filter(|task| task.status != TaskStatusV2::Completed)
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();
    let active = data
        .active_teammates
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let rows = visibility
        .visible_tasks
        .iter()
        .map(|task| {
            let blockers = open_blockers(task, &unresolved_ids);
            let activity = task
                .owner
                .as_ref()
                .and_then(|owner| data.teammate_activity.get(owner).map(String::as_str));
            let owner_active = task
                .owner
                .as_ref()
                .is_some_and(|owner| active.contains(owner));
            (
                task.clone(),
                task_list_v2_row_display(task, &blockers, activity, owner_active, data.columns),
            )
        })
        .collect::<Vec<_>>();
    let hidden_summary = (max_display > 0)
        .then_some(visibility.hidden_summary)
        .filter(|s| !s.is_empty());

    let content = element! {
        View(flex_direction: FlexDirection::Column) {
            #(rows.into_iter().map(|(task, row)| {
                let owner_color = task.owner.as_ref().and_then(|owner| data.teammate_colors.get(owner)).copied();
                element! {
                    View(flex_direction: FlexDirection::Column) {
                        View(flex_direction: FlexDirection::Row) {
                            Text(content: format!("{} ", row.icon), color: themed_color(&theme, row.icon_color_key), wrap: TextWrap::NoWrap)
                            Text(
                                content: row.subject,
                                weight: if row.in_progress { Weight::Bold } else { Weight::Normal },
                                strikethrough: row.completed,
                                dim: row.completed || row.blocked,
                                wrap: TextWrap::NoWrap,
                            )
                            #(if row.show_owner {
                                Some(element! {
                                    View(flex_direction: FlexDirection::Row) {
                                        Text(content: " (@".to_string(), dim: true, wrap: TextWrap::NoWrap)
                                        Text(content: row.owner.unwrap_or_default(), color: owner_color, dim: owner_color.is_none(), wrap: TextWrap::NoWrap)
                                        Text(content: ")".to_string(), dim: true, wrap: TextWrap::NoWrap)
                                    }
                                }.into_any())
                            } else { None })
                            #(row.blocked_text.map(|text| element! { Text(content: text, dim: true, wrap: TextWrap::NoWrap) }.into_any()))
                        }
                        #(row.activity_text.map(|text| element! { Text(content: text, dim: true, wrap: TextWrap::NoWrap) }))
                    }
                }
            }).collect::<Vec<_>>())
            #(hidden_summary.map(|summary| element! { Text(content: summary, dim: true, wrap: TextWrap::NoWrap) }))
        }
    };

    if data.is_standalone {
        element! {
            View(flex_direction: FlexDirection::Column, margin_top: 1u32, margin_left: 2u32) {
                View(flex_direction: FlexDirection::Row) {
                    Text(content: data.tasks.len().to_string(), weight: Weight::Bold, dim: true, wrap: TextWrap::NoWrap)
                    Text(content: " tasks (".to_string(), dim: true, wrap: TextWrap::NoWrap)
                    Text(content: counts.completed.to_string(), weight: Weight::Bold, dim: true, wrap: TextWrap::NoWrap)
                    Text(content: " done, ".to_string(), dim: true, wrap: TextWrap::NoWrap)
                    #(if counts.in_progress > 0 {
                        Some(element! {
                            Fragment {
                                Text(content: counts.in_progress.to_string(), weight: Weight::Bold, dim: true, wrap: TextWrap::NoWrap)
                                Text(content: " in progress, ".to_string(), dim: true, wrap: TextWrap::NoWrap)
                            }
                        }.into_any())
                    } else { None })
                    Text(content: counts.pending.to_string(), weight: Weight::Bold, dim: true, wrap: TextWrap::NoWrap)
                    Text(content: " open)".to_string(), dim: true, wrap: TextWrap::NoWrap)
                }
                #(Some(content))
            }
        }.into_any()
    } else {
        content.into_any()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    fn task(id: &str, status: TaskStatusV2) -> TaskV2 {
        TaskV2 {
            id: id.to_string(),
            subject: format!("task {id}"),
            status,
            owner: None,
            blocked_by: Vec::new(),
        }
    }

    #[test]
    fn task_list_v2_id_sort_matches_official_numeric_then_string() {
        let mut tasks = vec![
            task("10", TaskStatusV2::Pending),
            task("2", TaskStatusV2::Pending),
            task("a", TaskStatusV2::Pending),
        ];
        tasks.sort_by(task_list_v2_by_id_asc);
        assert_eq!(
            tasks.into_iter().map(|t| t.id).collect::<Vec<_>>(),
            vec!["2", "10", "a"]
        );
    }

    #[test]
    fn task_list_v2_max_display_and_counts_match_official() {
        assert_eq!(task_list_v2_max_display(10), 0);
        assert_eq!(task_list_v2_max_display(12), 3);
        assert_eq!(task_list_v2_max_display(30), 10);
        let counts = task_list_v2_counts(&[
            task("1", TaskStatusV2::Completed),
            task("2", TaskStatusV2::Pending),
            task("3", TaskStatusV2::InProgress),
        ]);
        assert_eq!(
            counts,
            TaskListV2Counts {
                completed: 1,
                pending: 1,
                in_progress: 1
            }
        );
    }

    #[test]
    fn task_list_v2_prioritizes_recent_in_progress_pending_unblocked_then_completed() {
        let tasks = vec![
            task("1", TaskStatusV2::Completed),
            task("2", TaskStatusV2::Completed),
            task("3", TaskStatusV2::InProgress),
            TaskV2 {
                blocked_by: vec!["3".to_string()],
                ..task("4", TaskStatusV2::Pending)
            },
            task("5", TaskStatusV2::Pending),
        ];
        let visible = task_list_v2_visible_tasks(&tasks, 3, &["2".to_string()]);
        assert_eq!(
            visible
                .visible_tasks
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            vec!["2", "3", "5"]
        );
        assert_eq!(visible.hidden_summary, " … +1 pending, 1 completed");
    }

    #[test]
    fn task_list_v2_row_display_matches_official_owner_blocker_activity_logic() {
        let row = task_list_v2_row_display(
            &TaskV2 {
                id: "7".to_string(),
                subject: "Investigate a very long task subject".to_string(),
                status: TaskStatusV2::InProgress,
                owner: Some("researcher".to_string()),
                blocked_by: Vec::new(),
            },
            &[],
            Some("Reading files"),
            true,
            70,
        );
        assert!(row.show_owner);
        assert_eq!(row.owner.as_deref(), Some("researcher"));
        assert_eq!(row.activity_text.as_deref(), Some("  Reading files…"));

        let blocked = task_list_v2_row_display(
            &task("10", TaskStatusV2::Pending),
            &["2".to_string(), "10".to_string()],
            None,
            false,
            40,
        );
        assert_eq!(
            blocked.blocked_text.as_deref(),
            Some(" › blocked by #2, #10")
        );
        assert!(blocked.activity_text.is_none());
    }

    #[test]
    fn task_list_v2_renders_standalone_summary_rows_and_hidden_summary() {
        let data = TaskListV2PropsData {
            tasks: vec![
                TaskV2 {
                    subject: "Done".to_string(),
                    ..task("1", TaskStatusV2::Completed)
                },
                TaskV2 {
                    subject: "Run".to_string(),
                    owner: Some("agent".to_string()),
                    ..task("2", TaskStatusV2::InProgress)
                },
                TaskV2 {
                    subject: "Open".to_string(),
                    blocked_by: vec!["2".to_string()],
                    ..task("3", TaskStatusV2::Pending)
                },
                task("4", TaskStatusV2::Pending),
                task("5", TaskStatusV2::Completed),
            ],
            is_standalone: true,
            rows: 17,
            columns: 80,
            recent_completed_ids: vec!["1".to_string()],
            teammate_activity: HashMap::from([("agent".to_string(), "Searching".to_string())]),
            active_teammates: vec!["agent".to_string()],
            teammate_colors: HashMap::from([("agent".to_string(), Color::Blue)]),
            todo_v2_enabled: true,
        };
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                TaskListV2(data: data)
            }
        }
        .render(Some(140))
        .to_string();
        assert!(
            text.contains("5 tasks (2 done, 1 in progress, 2 open)"),
            "canvas=\n{text}"
        );
        assert!(text.contains("Done"), "canvas=\n{text}");
        assert!(text.contains("Run (@agent)"), "canvas=\n{text}");
        assert!(text.contains("  Searching…"), "canvas=\n{text}");
        assert!(
            text.contains("… +1 pending, 1 completed"),
            "canvas=\n{text}"
        );
    }

    #[test]
    fn task_list_v2_themed_color_keeps_the_official_claude_key() {
        let theme = *theme::current();
        assert_eq!(themed_color(&theme, Some("claude")), Some(theme.nyan));
        assert_eq!(themed_color(&theme, Some("success")), Some(theme.success));
        assert_eq!(themed_color(&theme, Some("unknown")), None);
    }

    #[test]
    fn task_list_v2_disabled_or_empty_renders_nothing() {
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                TaskListV2(data: TaskListV2PropsData { todo_v2_enabled: false, tasks: vec![task("1", TaskStatusV2::Pending)], ..TaskListV2PropsData::default() })
            }
        }
        .render(Some(80))
        .to_string();
        assert_eq!(text, "");
    }
}
