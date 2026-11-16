//! @nyan: built-in agent panel (docs/nyan/tui.md §6, §7).
//!
//! Projects the running background tasks in `AppState.tasks` (teammates,
//! shells, dreams) plus the local-agent registry into one row list, then
//! paints it as a small tree under the todo panel. `AgentPanelView` is the
//! presentational half (pure data in, lines out); `AgentPanel` is the
//! AppState-connected half mounted in `screens/repl.rs`.
//!
//! Terminal rows stay visible for [`TERMINAL_RETENTION_MS`] after they finish
//! so the ✔/✘ outcome is readable. A row that is already terminal the first
//! time this panel sees it is not shown at all (it belongs to an earlier
//! session or turn).

use crate::components::tasks::task_status_utils::{
    RecentActivity, TeammateActivityProjection, describe_teammate_activity,
};
use crate::constants::figures;
use crate::state::app_state::{use_app_state, use_set_app_state};
use crate::state::app_state_store::{FooterItem, TaskState};
use crate::tasks::dream_task::DreamTaskState;
use crate::tasks::local_agent_task::LocalAgentTaskState;
use crate::tasks::local_shell_task::guards::LocalShellTaskState;
use crate::tools::agent_tool::agent_color_manager::get_agent_color;
use crate::utils::format::{format_duration, format_tokens};
use crate::utils::theme::{Theme, ThemeColorKey};
use crate::utils::truncate::truncate_to_width;
use iocraft::prelude::*;
use std::collections::BTreeMap;
use std::sync::Arc;
use unicode_width::UnicodeWidthStr;

/// Rows shown at ≥ 24 terminal rows (§7).
pub const MAX_ROWS_TALL: usize = 4;
/// Rows shown at 16–23 terminal rows (§7).
pub const MAX_ROWS_MEDIUM: usize = 2;
/// Below this many terminal rows the panel hides and the footer pills return.
pub const MIN_ROWS_FOR_PANEL: usize = 16;
const TALL_ROWS: usize = 24;
/// Longest name column (§6.1).
pub const MAX_NAME_WIDTH: usize = 12;
/// A row keeps its stats only if at least this much activity room remains.
const MIN_ACTIVITY_WIDTH: usize = 8;
const ROW_GAP: usize = 2;
/// Terminal rows linger this long so ✔/✘ stays readable (§6.1).
pub const TERMINAL_RETENTION_MS: u64 = 3_000;
const TICK_INTERVAL_MS: u64 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentKind {
    Agent,
    Teammate,
    Shell,
    Dream,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AgentStatus {
    #[default]
    Running,
    Completed,
    Failed,
    Killed,
}

impl AgentStatus {
    fn is_running(self) -> bool {
        self == Self::Running
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentRow {
    pub id: String,
    pub kind: AgentKind,
    pub name: String,
    /// `None` falls back to the theme's `text` color.
    pub name_color: Option<ThemeColorKey>,
    pub activity: String,
    /// Right-aligned trailing stats; empty means none.
    pub stats: String,
    pub status: AgentStatus,
}

/// The row identity the footer needs for navigation and Enter. Published to
/// AppState by [`AgentPanel`] so the footer and the panel always agree on the
/// row list (the panel's retention clock is a component-local ref).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPanelItem {
    pub id: String,
    pub kind: AgentKind,
}

fn parse_status(status: &str) -> AgentStatus {
    match status {
        "running" | "pending" => AgentStatus::Running,
        "completed" | "succeeded" => AgentStatus::Completed,
        "failed" => AgentStatus::Failed,
        "killed" => AgentStatus::Killed,
        _ => AgentStatus::Running,
    }
}

fn compact_duration(ms: u64) -> String {
    // §6.1 shows `2m10s`; `format_duration` spaces the units apart.
    format_duration(ms).replace(' ', "")
}

fn elapsed_ms(start_ms: u64, end_ms: Option<u64>, now_ms: u64) -> u64 {
    end_ms.unwrap_or(now_ms).saturating_sub(start_ms)
}

fn agent_stats(task: &LocalAgentTaskState, now_ms: u64) -> String {
    let (tool_uses, tokens) = task
        .progress
        .as_ref()
        .map(|progress| (progress.tool_use_count, progress.token_count))
        .unwrap_or((0, 0));
    format!(
        "{} tools · {} · {}",
        tool_uses,
        format_tokens(tokens),
        compact_duration(elapsed_ms(task.start_time_ms, task.end_time_ms, now_ms)),
    )
}

fn local_agent_row(task: &LocalAgentTaskState, now_ms: u64) -> AgentRow {
    // §6.1: latest recorded activity, else the task description.
    let activity = task
        .progress
        .as_ref()
        .and_then(|progress| progress.recent_activities.last())
        .map(|activity| {
            activity
                .activity_description
                .clone()
                .unwrap_or_else(|| activity.tool_name.clone())
        })
        .filter(|activity| !activity.trim().is_empty())
        .unwrap_or_else(|| task.description.clone());
    AgentRow {
        id: task.task_id.clone(),
        kind: AgentKind::Agent,
        name: task.agent_type.clone(),
        name_color: get_agent_color(&task.agent_type),
        activity,
        stats: agent_stats(task, now_ms),
        status: parse_status(&task.status),
    }
}

fn teammate_activity(
    snapshot: &crate::components::spinner::teammate_tree::TeammateTaskSnapshot,
) -> String {
    describe_teammate_activity(&TeammateActivityProjection {
        shutdown_requested: snapshot.shutdown_requested,
        awaiting_plan_approval: snapshot.awaiting_plan_approval,
        is_idle: snapshot.is_idle,
        recent_activities: snapshot
            .recent_activities
            .iter()
            .map(|activity| RecentActivity {
                activity_description: activity.activity_description.clone(),
                is_search: activity.is_search,
                is_read: activity.is_read,
            })
            .collect(),
        last_activity_description: snapshot.last_activity_description.clone(),
    })
}

fn teammate_row(
    snapshot: &crate::components::spinner::teammate_tree::TeammateTaskSnapshot,
) -> AgentRow {
    AgentRow {
        id: snapshot.id.clone(),
        kind: AgentKind::Teammate,
        name: format!("@{}", snapshot.agent_name),
        name_color: Some(
            crate::components::spinner::teammate_tree::parse_teammate_spinner_color(
                snapshot.color.as_deref(),
            )
            .theme_key(),
        ),
        activity: teammate_activity(snapshot),
        // §6.1: teammate stats have no duration.
        stats: format!(
            "{} tools · {}",
            snapshot.tool_use_count,
            format_tokens(snapshot.token_count as u64)
        ),
        status: parse_status(&snapshot.status),
    }
}

fn shell_row(task: &LocalShellTaskState, now_ms: u64) -> AgentRow {
    let monitor = task.kind.as_deref() == Some("monitor");
    AgentRow {
        id: task.id.clone(),
        kind: AgentKind::Shell,
        name: "$".to_string(),
        name_color: None,
        activity: if monitor {
            task.description.clone()
        } else {
            task.command.clone()
        },
        stats: compact_duration(elapsed_ms(
            task.start_time_ms.max(0) as u64,
            task.end_time_ms.map(|end| end.max(0) as u64),
            now_ms,
        )),
        status: parse_status(&task.status),
    }
}

fn dream_row(task: &DreamTaskState, now_ms: u64) -> AgentRow {
    AgentRow {
        id: task.id.clone(),
        kind: AgentKind::Dream,
        name: "dream".to_string(),
        name_color: None,
        activity: format!("{} · {}", task.phase.as_str(), task.description),
        stats: compact_duration(elapsed_ms(task.start_time, task.end_time, now_ms)),
        status: parse_status(&task.status),
    }
}

/// Every panel-visible task, running or terminal, sorted: running first, then
/// newest start time, then id (determinism). Local agents come from their
/// registry — the `Other` mirror in `AppState.tasks` is skipped so the two
/// sources cannot duplicate a row.
pub fn project_agent_rows(
    tasks: &BTreeMap<String, Arc<TaskState>>,
    local_agents: &[LocalAgentTaskState],
    now_ms: u64,
) -> Vec<AgentRow> {
    // (running, start_time_ms, id, row)
    let mut sortable: Vec<(bool, u64, String, AgentRow)> = Vec::new();
    for task in tasks.values() {
        match task.as_ref() {
            TaskState::InProcessTeammate(snapshot) => {
                let row = teammate_row(snapshot);
                // Teams are always background work; there is no foreground
                // in-process teammate.
                sortable.push((row.status.is_running(), 0, row.id.clone(), row));
            }
            TaskState::LocalShell(task) => {
                // A foreground shell (`is_backgrounded == false`) is the
                // synchronous Bash tool, already shown in the message stream.
                if !task.is_backgrounded {
                    continue;
                }
                let row = shell_row(task, now_ms);
                sortable.push((
                    row.status.is_running(),
                    task.start_time_ms.max(0) as u64,
                    row.id.clone(),
                    row,
                ));
            }
            TaskState::Dream(task) => {
                let row = dream_row(task, now_ms);
                sortable.push((
                    row.status.is_running(),
                    task.start_time,
                    row.id.clone(),
                    row,
                ));
            }
            // local_agent rows carry their full state in the registry; every
            // other `Other` task type has no panel projection yet.
            TaskState::Other(_) => {}
        }
    }
    for task in local_agents {
        if !task.is_backgrounded {
            // Foreground sync subagent: shown in the message stream instead.
            continue;
        }
        if crate::tasks::local_main_session_task::is_main_session_task(task) {
            // The leader's own session is not a background worker.
            continue;
        }
        let row = local_agent_row(task, now_ms);
        sortable.push((
            row.status.is_running(),
            task.start_time_ms,
            row.id.clone(),
            row,
        ));
    }
    sortable.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    sortable.into_iter().map(|(_, _, _, row)| row).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrackedStatus {
    Running,
    Terminal { since_ms: u64, hidden: bool },
}

/// Component-local record of when each id was first seen terminal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RetentionTracker {
    entries: std::collections::HashMap<String, TrackedStatus>,
}

impl RetentionTracker {
    fn get(&self, id: &str) -> Option<TrackedStatus> {
        self.entries.get(id).copied()
    }
}

/// Keeps terminal rows visible for `retention_ms` after the first frame that
/// saw them terminal. A row first seen already terminal is hidden forever.
/// Rows absent from `rows` are forgotten, so a recycled id starts fresh.
pub fn apply_terminal_retention(
    rows: &[AgentRow],
    tracker: &mut RetentionTracker,
    now_ms: u64,
    retention_ms: u64,
) -> Vec<AgentRow> {
    let mut visible = Vec::new();
    let mut next = std::collections::HashMap::new();
    for row in rows {
        let tracked = if row.status.is_running() {
            TrackedStatus::Running
        } else {
            match tracker.get(&row.id) {
                Some(TrackedStatus::Running) => TrackedStatus::Terminal {
                    since_ms: now_ms,
                    hidden: false,
                },
                Some(tracked @ TrackedStatus::Terminal { .. }) => tracked,
                None => TrackedStatus::Terminal {
                    since_ms: now_ms,
                    hidden: true,
                },
            }
        };
        let keep = match tracked {
            TrackedStatus::Running => true,
            TrackedStatus::Terminal { since_ms, hidden } => {
                !hidden && now_ms.saturating_sub(since_ms) < retention_ms
            }
        };
        next.insert(row.id.clone(), tracked);
        if keep {
            visible.push(row.clone());
        }
    }
    tracker.entries = next;
    visible
}

/// Row budget from terminal rows (§7). `None` hides the panel; `rows == 0`
/// is an unknown size and is treated as tall.
pub fn panel_rows_budget(terminal_rows: usize) -> Option<usize> {
    let rows = if terminal_rows == 0 {
        usize::MAX
    } else {
        terminal_rows
    };
    if rows >= TALL_ROWS {
        Some(MAX_ROWS_TALL)
    } else if rows >= MIN_ROWS_FOR_PANEL {
        Some(MAX_ROWS_MEDIUM)
    } else {
        None
    }
}

/// Splits the visible rows into the rows actually drawn and the number folded
/// into the trailing `… +N more` line. The overflow line consumes one of the
/// `max_rows` slots.
pub fn split_display_rows(rows: &[AgentRow], max_rows: usize) -> (&[AgentRow], usize) {
    if rows.len() <= max_rows {
        return (rows, 0);
    }
    let shown = max_rows.saturating_sub(1);
    (&rows[..shown], rows.len() - shown)
}

/// §6.1: the name column is the longest visible name, capped at 12 columns;
/// longer names are truncated into that column so the alignment holds.
fn fit_name(name: &str, name_width: usize) -> String {
    pad_to_width(&truncate_to_width(name, name_width), name_width)
}

/// Clamps a panel selection into `0..len`. `len == 0` returns 0; the footer
/// selection itself is cleared by PromptInput's vanished-pill logic.
pub fn clamped_agent_selection(selected: usize, len: usize) -> usize {
    selected.min(len.saturating_sub(1))
}

/// True when the panel occupies the footer's place: it has rows and the
/// terminal is tall enough (§7). PromptInput feeds this to BOTH the pill
/// render gate and `footer_height_for`, so the two cannot disagree.
pub fn panel_shows_rows(terminal_rows: usize, row_count: usize) -> bool {
    panel_rows_budget(terminal_rows).is_some() && row_count > 0
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSpan {
    pub text: String,
    pub color: Option<Color>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPanelLine {
    pub prefix: String,
    pub prefix_color: Option<Color>,
    pub spans: Vec<AgentSpan>,
    pub right: Option<AgentSpan>,
    pub background: Option<Color>,
}

impl AgentPanelLine {
    pub fn text(&self) -> String {
        let mut text = self.prefix.clone();
        for span in &self.spans {
            text.push_str(&span.text);
        }
        if let Some(right) = &self.right {
            text.push_str("  ");
            text.push_str(&right.text);
        }
        text
    }
}

fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

fn pad_to_width(text: &str, target: usize) -> String {
    let padding = target.saturating_sub(width(text));
    format!("{text}{}", " ".repeat(padding))
}

fn name_column_width(rows: &[AgentRow]) -> usize {
    rows.iter()
        .map(|row| width(&row.name))
        .max()
        .unwrap_or(0)
        .min(MAX_NAME_WIDTH)
}

fn icon_for(status: AgentStatus, tick: usize) -> (&'static str, ThemeColorKey) {
    let figs = figures::get();
    match status {
        AgentStatus::Running => (
            crate::components::spinner::utils::spinner_frame(tick),
            ThemeColorKey::Inactive,
        ),
        AgentStatus::Completed => (figs.tick, ThemeColorKey::Success),
        AgentStatus::Failed | AgentStatus::Killed => (figs.cross, ThemeColorKey::Error),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentPanelData {
    /// Rows that survived terminal retention, sorted.
    pub rows: Vec<AgentRow>,
    /// Row budget from terminal height; `None` hides the panel.
    pub max_rows: Option<usize>,
    /// Selection inside the displayed rows; only when the footer focuses the
    /// panel.
    pub selected: Option<usize>,
    /// 0 reads as 80.
    pub columns: usize,
    /// Spinner frame index (1 Hz, §6.1).
    pub tick: usize,
}

/// Lines for one panel render. Pure; the component only paints them.
pub fn layout_agent_panel(data: &AgentPanelData, theme: &Theme) -> Vec<AgentPanelLine> {
    let Some(max_rows) = data.max_rows else {
        return Vec::new();
    };
    let columns = if data.columns == 0 { 80 } else { data.columns };
    let (shown, hidden) = split_display_rows(&data.rows, max_rows);
    if shown.is_empty() && hidden == 0 {
        return Vec::new();
    }
    let name_width = name_column_width(shown);
    let inactive = Some(theme.inactive);
    let mut lines = Vec::with_capacity(shown.len() + 1);
    for (index, row) in shown.iter().enumerate() {
        let last = index + 1 == shown.len() && hidden == 0;
        let prefix = if last { "└ " } else { "├ " };
        let (icon, icon_key) = icon_for(row.status, data.tick);
        let icon_text = format!("{icon} ");
        let name = fit_name(&row.name, name_width);
        let fixed = width(prefix) + width(&icon_text) + name_width + ROW_GAP;
        let stats_width = if row.stats.is_empty() {
            0
        } else {
            width(&row.stats) + ROW_GAP
        };
        let activity_budget = columns.saturating_sub(fixed);
        let keep_stats = !row.stats.is_empty()
            && activity_budget >= stats_width + MIN_ACTIVITY_WIDTH
            && columns >= fixed + stats_width;
        let activity_budget = if keep_stats {
            activity_budget.saturating_sub(stats_width)
        } else {
            activity_budget
        };
        let activity = if row.activity.is_empty() {
            String::new()
        } else if activity_budget == 0 {
            String::new()
        } else {
            truncate_to_width(&row.activity, activity_budget)
        };
        let separator = if activity.is_empty() { "" } else { "  " };
        let mut spans = vec![
            AgentSpan {
                text: icon_text,
                color: Some(theme.color(icon_key)),
            },
            AgentSpan {
                text: name,
                color: row
                    .name_color
                    .map(|key| theme.color(key))
                    .or(Some(theme.text)),
            },
        ];
        if !activity.is_empty() {
            spans.push(AgentSpan {
                text: format!("{separator}{activity}"),
                color: inactive,
            });
        }
        lines.push(AgentPanelLine {
            prefix: prefix.to_string(),
            prefix_color: inactive,
            spans,
            right: keep_stats.then(|| AgentSpan {
                text: row.stats.clone(),
                color: inactive,
            }),
            background: (data.selected == Some(index)).then_some(theme.selection_bg),
        });
    }
    if hidden > 0 {
        let prefix = "└ ";
        let budget = columns.saturating_sub(width(prefix));
        lines.push(AgentPanelLine {
            prefix: prefix.to_string(),
            prefix_color: inactive,
            spans: vec![AgentSpan {
                text: truncate_to_width(&format!("… +{hidden} more"), budget.max(1)),
                color: inactive,
            }],
            right: None,
            background: None,
        });
    }
    lines
}

fn span_element(span: &AgentSpan) -> AnyElement<'static> {
    element! {
        Text(content: span.text.clone(), color: span.color, wrap: TextWrap::NoWrap)
    }
    .into_any()
}

fn line_element(line: &AgentPanelLine) -> AnyElement<'static> {
    let mut cells: Vec<AnyElement<'static>> = vec![
        element! {
            Text(content: line.prefix.clone(), color: line.prefix_color, wrap: TextWrap::NoWrap)
        }
        .into_any(),
    ];
    cells.extend(line.spans.iter().map(span_element));
    if let Some(right) = &line.right {
        cells.push(element! { View(flex_grow: 1.0f32) }.into_any());
        cells.push(span_element(right));
    }
    element! {
        View(
            flex_direction: FlexDirection::Row,
            width: 100pct,
            height: 1u32,
            overflow: Overflow::Hidden,
            background_color: line.background,
        ) {
            #(cells)
        }
    }
    .into_any()
}

#[derive(Default, Props)]
pub struct AgentPanelViewProps {
    pub data: AgentPanelData,
}

/// Presentational half: paints [`layout_agent_panel`] and nothing else.
#[component]
pub fn AgentPanelView(props: &AgentPanelViewProps, hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let lines = layout_agent_panel(&props.data, &theme);
    if lines.is_empty() {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    }
    element! {
        View(flex_direction: FlexDirection::Column, width: 100pct) {
            #(lines.iter().map(line_element).collect::<Vec<_>>())
        }
    }
    .into_any()
}

#[derive(Default, Props)]
pub struct AgentPanelProps {
    /// Override the terminal size (tests); `None` reads the terminal.
    pub columns: Option<u32>,
    pub rows: Option<u32>,
    /// Frozen "now" for deterministic tests; `None` reads the wall clock.
    pub now_ms: Option<u64>,
    /// Frozen spinner frame for static renders.
    pub tick: Option<usize>,
}

fn items_signature(items: &[AgentPanelItem]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for item in items {
        item.id.hash(&mut hasher);
        (item.kind as u8).hash(&mut hasher);
    }
    items.len().hash(&mut hasher);
    hasher.finish()
}

/// One tracker for the whole process. REPL mounts two `AgentPanel` instances
/// (generating and idle) and swaps them at every turn boundary; a per-instance
/// `use_ref` would lose "was running" there, so a task finishing as the turn
/// ends would be first-seen terminal by the idle instance and skip its ✔/✘.
fn shared_retention_tracker() -> &'static std::sync::Mutex<RetentionTracker> {
    static TRACKER: std::sync::OnceLock<std::sync::Mutex<RetentionTracker>> =
        std::sync::OnceLock::new();
    TRACKER.get_or_init(|| std::sync::Mutex::new(RetentionTracker::default()))
}

/// AppState-connected half. Publishes the displayed rows to AppState so the
/// footer's navigation and the detail-dialog routing share this exact list.
#[component]
pub fn AgentPanel(props: &AgentPanelProps, mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let (terminal_columns, terminal_rows) = hooks.use_terminal_size();
    let tasks = use_app_state(&mut hooks, |state| state.tasks.clone());
    let selected_index = use_app_state(&mut hooks, |state| {
        (state.footer_selection == Some(FooterItem::AgentPanel))
            .then_some(state.agent_panel_selected)
    });
    let store = use_set_app_state(&mut hooks);
    let columns = props.columns.unwrap_or(terminal_columns as u32) as usize;
    let terminal_rows = props.rows.unwrap_or(terminal_rows as u32) as usize;
    let now_ms = props
        .now_ms
        .unwrap_or_else(crate::utils::task::framework::now_ms);
    let budget = panel_rows_budget(terminal_rows);
    let visible = if budget.is_some() {
        let local_agents = crate::tasks::local_agent_task::local_agent_tasks_snapshot();
        let projected = project_agent_rows(&tasks, &local_agents, now_ms);
        apply_terminal_retention(
            &projected,
            &mut shared_retention_tracker()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            now_ms,
            TERMINAL_RETENTION_MS,
        )
    } else {
        Vec::new()
    };
    let displayed = match budget {
        Some(max_rows) => split_display_rows(&visible, max_rows).0.to_vec(),
        None => Vec::new(),
    };
    // @nyan: the 1 s tick also drives terminal-retention expiry; it stops as
    // soon as no row is left, so there is no idle animation.
    let interval =
        (!visible.is_empty()).then(|| std::time::Duration::from_millis(TICK_INTERVAL_MS));
    let frame = hooks.use_animation_frame(interval);
    let tick = props
        .tick
        .unwrap_or((frame.time_ms as u64 / TICK_INTERVAL_MS) as usize);

    let items: Vec<AgentPanelItem> = displayed
        .iter()
        .map(|row| AgentPanelItem {
            id: row.id.clone(),
            kind: row.kind,
        })
        .collect();
    let signature = items_signature(&items);
    let len = items.len();
    let items_for_effect = items.clone();
    hooks.use_effect(
        move || {
            store.set_state(|prev| {
                let mut next = (**prev).clone();
                let mut changed = false;
                if next.agent_panel_items.as_slice() != items_for_effect.as_slice() {
                    next.agent_panel_items = Arc::new(items_for_effect.clone());
                    changed = true;
                }
                let clamped = clamped_agent_selection(next.agent_panel_selected, len);
                if next.agent_panel_selected != clamped {
                    next.agent_panel_selected = clamped;
                    changed = true;
                }
                if changed {
                    crate::state::store::UpdateDecision::Replace {
                        next: Arc::new(next),
                        result: (),
                    }
                } else {
                    crate::state::store::UpdateDecision::Same(())
                }
            });
        },
        (signature, len),
    );

    let data = AgentPanelData {
        rows: displayed,
        max_rows: budget,
        selected: selected_index,
        columns,
        tick,
    };
    element! { AgentPanelView(data: data) }.into_any()
}

/// Shortcut text for the footer/hint copy; shared by tests.
pub(crate) fn agent_panel_item_at(
    items: &[AgentPanelItem],
    selected: usize,
) -> Option<&AgentPanelItem> {
    items.get(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    fn snapshot(
        id: &str,
        name: &str,
        status: &str,
    ) -> crate::components::spinner::teammate_tree::TeammateTaskSnapshot {
        crate::components::spinner::teammate_tree::TeammateTaskSnapshot {
            id: id.to_string(),
            task_type: crate::components::spinner::teammate_tree::IN_PROCESS_TEAMMATE_TASK_TYPE
                .to_string(),
            status: status.to_string(),
            agent_name: name.to_string(),
            color: Some("purple".to_string()),
            tool_use_count: 3,
            token_count: 12_000,
            last_activity_description: Some("Reviewing diff".to_string()),
            ..Default::default()
        }
    }

    fn shell(id: &str, command: &str, status: &str, start_ms: i64) -> LocalShellTaskState {
        LocalShellTaskState {
            id: id.to_string(),
            task_type: "local_bash".to_string(),
            status: status.to_string(),
            description: format!("{command} description"),
            command: command.to_string(),
            result: None,
            notified: false,
            shell_command: None,
            last_reported_total_lines: 0,
            is_backgrounded: true,
            agent_id: None,
            tool_use_id: None,
            kind: None,
            start_time_ms: start_ms,
            end_time_ms: None,
        }
    }

    fn agent(id: &str, agent_type: &str, status: &str, start_ms: u64) -> LocalAgentTaskState {
        LocalAgentTaskState {
            task_id: id.to_string(),
            task_type: "local_agent".to_string(),
            status: status.to_string(),
            agent_id: id.to_string(),
            prompt: "prompt".to_string(),
            selected_agent: None,
            agent_type: agent_type.to_string(),
            description: "survey the TUI".to_string(),
            model: None,
            error: None,
            result: None,
            progress: Some(crate::tasks::local_agent_task::AgentProgress {
                tool_use_count: 14,
                token_count: 38_000,
                last_activity: None,
                recent_activities: vec![crate::tasks::local_agent_task::ToolActivity {
                    tool_name: "Read".to_string(),
                    input: serde_json::Value::Null,
                    activity_description: Some("调研 TUI 结构".to_string()),
                    is_search: false,
                    is_read: true,
                }],
                summary: None,
            }),
            retrieved: false,
            messages: Vec::new(),
            last_reported_tool_count: 0,
            last_reported_token_count: 0,
            is_backgrounded: true,
            pending_messages: Vec::new(),
            retain: false,
            disk_loaded: false,
            start_time_ms: start_ms,
            end_time_ms: None,
            tool_use_id: None,
            output_file: String::new(),
            abort_controller: Default::default(),
            notified: false,
            evict_after: None,
        }
    }

    fn dream(id: &str, status: &str) -> DreamTaskState {
        DreamTaskState {
            id: id.to_string(),
            task_type: "dream".to_string(),
            status: status.to_string(),
            description: "dreaming".to_string(),
            notified: false,
            start_time: 90_000,
            end_time: None,
            phase: crate::tasks::dream_task::DreamPhase::Updating,
            sessions_reviewing: 1,
            files_touched: Vec::new(),
            turns: Vec::new(),
            abort_controller: None,
            prior_mtime: 0,
            lock: None,
        }
    }

    fn tasks_map(entries: Vec<TaskState>) -> BTreeMap<String, Arc<TaskState>> {
        entries
            .into_iter()
            .map(|task| {
                let id = task.id().to_string();
                (id, Arc::new(task))
            })
            .collect()
    }

    #[test]
    fn projection_covers_all_four_sources_and_stats_formats() {
        // now = 130_000; agent started 130s ago (2m10s), shell 45s ago.
        let tasks = tasks_map(vec![
            TaskState::InProcessTeammate(snapshot("team-1", "alpha", "running")),
            TaskState::LocalShell(shell("sh-1", "cargo test", "running", 85_000)),
            TaskState::Dream(dream("dream-1", "running")),
        ]);
        let rows = project_agent_rows(&tasks, &[agent("a-1", "explore", "running", 0)], 130_000);
        assert_eq!(rows.len(), 4);

        let by_id = |id: &str| rows.iter().find(|row| row.id == id).unwrap();
        let agent_row = by_id("a-1");
        assert_eq!(agent_row.kind, AgentKind::Agent);
        assert_eq!(agent_row.name, "explore");
        assert_eq!(agent_row.activity, "调研 TUI 结构");
        assert_eq!(agent_row.stats, "14 tools · 38k · 2m10s");
        assert_eq!(agent_row.name_color, None, "unmapped agent type");

        let teammate = by_id("team-1");
        assert_eq!(teammate.kind, AgentKind::Teammate);
        assert_eq!(teammate.name, "@alpha");
        assert_eq!(teammate.activity, "Reviewing diff");
        assert_eq!(teammate.stats, "3 tools · 12k");
        assert_eq!(teammate.name_color, Some(ThemeColorKey::AgentPurple));

        let shell_row = by_id("sh-1");
        assert_eq!(shell_row.kind, AgentKind::Shell);
        assert_eq!(shell_row.name, "$");
        assert_eq!(shell_row.activity, "cargo test");
        assert_eq!(shell_row.stats, "45s");

        let dream_row = by_id("dream-1");
        assert_eq!(dream_row.kind, AgentKind::Dream);
        assert_eq!(dream_row.name, "dream");
        assert_eq!(dream_row.activity, "updating · dreaming");
        assert_eq!(dream_row.stats, "40s");
    }

    #[test]
    fn agent_color_comes_from_the_shared_agent_color_manager() {
        let _lock = crate::utils::test_env::TEST_ENV_LOCK.lock().unwrap();
        crate::tools::agent_tool::agent_color_manager::set_agent_color(
            "explore-colored",
            Some(crate::tools::agent_tool::agent_color_manager::AgentColorName::Blue),
        );
        let rows = project_agent_rows(
            &BTreeMap::new(),
            &[agent("a-1", "explore-colored", "running", 0)],
            0,
        );
        assert_eq!(rows[0].name_color, Some(ThemeColorKey::AgentBlue));
        crate::tools::agent_tool::agent_color_manager::set_agent_color("explore-colored", None);
    }

    #[test]
    fn terminal_status_mapping_includes_succeeded_and_foreground_is_excluded() {
        let tasks = tasks_map(vec![
            TaskState::LocalShell(shell("done", "make", "completed", 1)),
            TaskState::LocalShell(shell("ok", "make", "succeeded", 1)),
            TaskState::LocalShell(shell("bad", "make", "failed", 1)),
            TaskState::LocalShell(shell("stop", "make", "killed", 1)),
        ]);
        let mut foreground = agent("fg", "explore", "running", 1);
        foreground.is_backgrounded = false;
        let rows = project_agent_rows(&tasks, &[foreground], 10);
        let status = |id: &str| rows.iter().find(|row| row.id == id).unwrap().status;
        assert_eq!(status("done"), AgentStatus::Completed);
        assert_eq!(status("ok"), AgentStatus::Completed);
        assert_eq!(status("bad"), AgentStatus::Failed);
        assert_eq!(status("stop"), AgentStatus::Killed);
        assert!(rows.iter().all(|row| row.id != "fg"));
    }

    #[test]
    fn sort_is_running_first_then_start_desc_then_id() {
        let tasks = tasks_map(vec![
            TaskState::LocalShell(shell("z-running", "z", "running", 5)),
            TaskState::LocalShell(shell("a-running", "a", "running", 5)),
            TaskState::LocalShell(shell("newer-terminal", "n", "completed", 9)),
            TaskState::LocalShell(shell("older-running", "o", "running", 1)),
            TaskState::InProcessTeammate(snapshot("team", "t", "running")),
        ]);
        let rows = project_agent_rows(&tasks, &[], 10);
        let ids = rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![
                "a-running",
                "z-running",
                "older-running",
                // Teammates have no start time.
                "team",
                "newer-terminal",
            ]
        );
    }

    #[test]
    fn max_rows_folds_the_tail_into_more() {
        let rows = (0..6)
            .map(|index| AgentRow {
                id: format!("r{index}"),
                kind: AgentKind::Shell,
                name: "$".to_string(),
                name_color: None,
                activity: "cmd".to_string(),
                stats: "1s".to_string(),
                status: AgentStatus::Running,
            })
            .collect::<Vec<_>>();
        let data = AgentPanelData {
            rows: rows.clone(),
            max_rows: Some(4),
            selected: None,
            columns: 80,
            tick: 0,
        };
        let lines = layout_agent_panel(&data, &*theme::current());
        assert_eq!(lines.len(), 4);
        assert!(
            lines[3].text().contains("… +3 more"),
            "{:?}",
            lines[3].text()
        );
        assert!(lines[3].prefix.starts_with('└'));

        let data = AgentPanelData {
            rows: rows[..4].to_vec(),
            max_rows: Some(4),
            ..data
        };
        let lines = layout_agent_panel(&data, &*theme::current());
        assert_eq!(lines.len(), 4);
        assert!(!lines.iter().any(|line| line.text().contains("more")));
    }

    #[test]
    fn names_align_in_a_column_capped_at_twelve() {
        let rows = vec![
            AgentRow {
                id: "1".into(),
                kind: AgentKind::Agent,
                name: "explore".into(),
                name_color: None,
                activity: "one".into(),
                stats: String::new(),
                status: AgentStatus::Running,
            },
            AgentRow {
                id: "2".into(),
                kind: AgentKind::Teammate,
                name: "@a-much-longer-name".into(),
                name_color: None,
                activity: "two".into(),
                stats: String::new(),
                status: AgentStatus::Running,
            },
        ];
        let data = AgentPanelData {
            rows,
            max_rows: Some(4),
            selected: None,
            columns: 80,
            tick: 0,
        };
        let lines = layout_agent_panel(&data, &*theme::current());
        // Display columns, not byte offsets: the tree glyphs and `…` are
        // multi-byte.
        let activity_column = |text: &str, activity: &str| {
            let byte = text.find(activity).unwrap();
            width(&text[..byte])
        };
        assert_eq!(activity_column(&lines[0].text(), "one"), 18);
        assert_eq!(activity_column(&lines[1].text(), "two"), 18);
        // 2 prefix + 2 icon + 12 name + 2 gap
        assert_eq!(
            width(&lines[1].text()[..lines[1].text().find("two").unwrap()]),
            18
        );
        assert!(lines[1].text().contains("@a-much-lon…"));
    }

    #[test]
    fn narrow_widths_drop_stats_then_truncate_activity() {
        let rows = vec![AgentRow {
            id: "1".into(),
            kind: AgentKind::Agent,
            name: "explore".into(),
            name_color: None,
            activity: "a very long activity description that must be cut".into(),
            stats: "14 tools · 38k · 2m10s".into(),
            status: AgentStatus::Running,
        }];
        let theme = *theme::current();
        for (columns, expect_stats) in [(80usize, true), (60, true), (40, false)] {
            let data = AgentPanelData {
                rows: rows.clone(),
                max_rows: Some(4),
                selected: None,
                columns,
                tick: 0,
            };
            let lines = layout_agent_panel(&data, &theme);
            let line = &lines[0];
            assert_eq!(
                line.right.is_some(),
                expect_stats,
                "columns={columns}: {}",
                line.text()
            );
            assert!(
                width(&line.text()) <= columns,
                "columns={columns}: {}",
                line.text()
            );
            if !expect_stats {
                assert!(
                    line.text().ends_with('…'),
                    "columns={columns}: {}",
                    line.text()
                );
            }
        }
    }

    #[test]
    fn retention_hides_first_seen_terminal_and_expires_after_three_seconds() {
        let row = |status| AgentRow {
            id: "r1".to_string(),
            kind: AgentKind::Shell,
            name: "$".to_string(),
            name_color: None,
            activity: "cmd".to_string(),
            stats: "1s".to_string(),
            status,
        };

        let mut tracker = RetentionTracker::default();
        assert!(
            apply_terminal_retention(
                &[row(AgentStatus::Completed)],
                &mut tracker,
                1_000,
                TERMINAL_RETENTION_MS
            )
            .is_empty(),
            "first seen terminal -> hidden"
        );
        assert!(
            apply_terminal_retention(
                &[row(AgentStatus::Completed)],
                &mut tracker,
                2_000,
                TERMINAL_RETENTION_MS
            )
            .is_empty()
        );

        let mut tracker = RetentionTracker::default();
        let running = apply_terminal_retention(
            &[row(AgentStatus::Running)],
            &mut tracker,
            1_000,
            TERMINAL_RETENTION_MS,
        );
        assert_eq!(running.len(), 1);
        // The transition frame starts the clock.
        let visible = apply_terminal_retention(
            &[row(AgentStatus::Completed)],
            &mut tracker,
            2_000,
            TERMINAL_RETENTION_MS,
        );
        assert_eq!(visible.len(), 1);
        // 2_999 ms after the transition is still inside the window.
        let visible = apply_terminal_retention(
            &[row(AgentStatus::Completed)],
            &mut tracker,
            4_999,
            TERMINAL_RETENTION_MS,
        );
        assert_eq!(visible.len(), 1);
        // Exactly 3 s is out.
        let visible = apply_terminal_retention(
            &[row(AgentStatus::Completed)],
            &mut tracker,
            5_000,
            TERMINAL_RETENTION_MS,
        );
        assert!(visible.is_empty());
    }

    #[test]
    fn retention_forgets_ids_that_leave_the_projection() {
        let row = AgentRow {
            id: "r1".to_string(),
            kind: AgentKind::Shell,
            name: "$".to_string(),
            name_color: None,
            activity: "cmd".to_string(),
            stats: String::new(),
            status: AgentStatus::Running,
        };
        let mut tracker = RetentionTracker::default();
        apply_terminal_retention(std::slice::from_ref(&row), &mut tracker, 1, 3_000);
        assert_eq!(tracker.get("r1"), Some(TrackedStatus::Running));
        apply_terminal_retention(&[], &mut tracker, 2, 3_000);
        assert_eq!(tracker.get("r1"), None);
    }

    #[test]
    fn row_budget_tiers_for_30_20_and_12_rows() {
        assert_eq!(panel_rows_budget(30), Some(4));
        assert_eq!(panel_rows_budget(24), Some(4));
        assert_eq!(panel_rows_budget(23), Some(2));
        assert_eq!(panel_rows_budget(20), Some(2));
        assert_eq!(panel_rows_budget(16), Some(2));
        assert_eq!(panel_rows_budget(15), None);
        assert_eq!(panel_rows_budget(12), None);
        assert_eq!(panel_rows_budget(0), Some(4), "unknown size reads as tall");
    }

    #[test]
    fn selection_is_clamped_into_the_displayed_range() {
        assert_eq!(clamped_agent_selection(5, 3), 2);
        assert_eq!(clamped_agent_selection(1, 3), 1);
        assert_eq!(clamped_agent_selection(2, 0), 0);
    }

    fn mixed_rows() -> Vec<AgentRow> {
        vec![
            AgentRow {
                id: "a".into(),
                kind: AgentKind::Agent,
                name: "explore".into(),
                name_color: Some(ThemeColorKey::AgentBlue),
                activity: "调研 TUI 结构".into(),
                stats: "14 tools · 38k · 2m10s".into(),
                status: AgentStatus::Running,
            },
            AgentRow {
                id: "t".into(),
                kind: AgentKind::Teammate,
                name: "@alpha".into(),
                name_color: Some(ThemeColorKey::AgentPurple),
                activity: "Reviewing diff".into(),
                stats: "3 tools · 12k".into(),
                status: AgentStatus::Running,
            },
            AgentRow {
                id: "s".into(),
                kind: AgentKind::Shell,
                name: "$".into(),
                name_color: None,
                activity: "cargo test".into(),
                stats: "45s".into(),
                status: AgentStatus::Completed,
            },
            AgentRow {
                id: "f".into(),
                kind: AgentKind::Dream,
                name: "dream".into(),
                name_color: None,
                activity: "updating · dreaming".into(),
                stats: String::new(),
                status: AgentStatus::Failed,
            },
        ]
    }

    fn render(data: AgentPanelData, width: usize) -> Canvas {
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                AgentPanelView(data: data)
            }
        }
        .render(Some(width))
    }

    struct CellStyle {
        color: Option<Color>,
        background: Option<Color>,
    }

    fn style_at(canvas: &Canvas, needle: &str) -> CellStyle {
        let text = canvas.to_string();
        let line_index = text
            .lines()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("missing {needle:?} in canvas=\n{text}"));
        let line = text.lines().nth(line_index).unwrap();
        let x = width(&line[..line.find(needle).unwrap()]);
        let style = canvas
            .resolved_text_style(x, line_index)
            .unwrap_or_else(|| panic!("no style at {needle:?} in canvas=\n{text}"));
        let background = canvas
            .cell(x, line_index)
            .and_then(|cell| cell.background_color);
        CellStyle {
            color: style.color,
            background,
        }
    }

    #[test]
    fn canvas_draws_tree_glyphs_status_icons_and_name_colors() {
        let data = AgentPanelData {
            rows: mixed_rows(),
            max_rows: Some(4),
            selected: None,
            columns: 80,
            tick: 0,
        };
        let canvas = render(data, 80);
        let text = canvas.to_string();
        let lines = text.lines().collect::<Vec<_>>();
        assert!(lines[0].starts_with("├ "), "canvas=\n{text}");
        assert!(lines[1].starts_with("├ "), "canvas=\n{text}");
        assert!(lines[2].starts_with("├ "), "canvas=\n{text}");
        assert!(lines[3].starts_with("└ "), "canvas=\n{text}");

        let theme = *theme::current();
        assert_eq!(
            style_at(&canvas, "explore").color,
            Some(theme.color(ThemeColorKey::AgentBlue))
        );
        assert_eq!(
            style_at(&canvas, "@alpha").color,
            Some(theme.color(ThemeColorKey::AgentPurple))
        );
        assert_eq!(style_at(&canvas, "调研").color, Some(theme.inactive));
        assert_eq!(style_at(&canvas, "✔").color, Some(theme.success));
        assert_eq!(style_at(&canvas, "✘").color, Some(theme.error));
        assert_eq!(style_at(&canvas, "cargo test").color, Some(theme.inactive));
        assert_eq!(style_at(&canvas, "14 tools").color, Some(theme.inactive));
    }

    #[test]
    fn canvas_highlights_the_selected_row_with_selection_bg() {
        let data = AgentPanelData {
            rows: mixed_rows(),
            max_rows: Some(4),
            selected: Some(1),
            columns: 80,
            tick: 0,
        };
        let canvas = render(data, 80);
        let text = canvas.to_string();
        let theme = *theme::current();
        assert_eq!(
            style_at(&canvas, "@alpha").background,
            Some(theme.selection_bg),
            "canvas=\n{text}"
        );
        assert_eq!(
            style_at(&canvas, "explore").background,
            None,
            "canvas=\n{text}"
        );
    }

    #[test]
    fn canvas_never_exceeds_the_terminal_width() {
        let long = "a very long activity that keeps going and going past any terminal edge";
        let mut rows = mixed_rows();
        rows[0].activity = long.to_string();
        rows[1].name = "@a-very-long-teammate-name".to_string();
        for columns in [80usize, 60, 40] {
            for tick in [0usize, 1] {
                let data = AgentPanelData {
                    rows: rows.clone(),
                    max_rows: Some(4),
                    selected: Some(0),
                    columns,
                    tick,
                };
                for line in layout_agent_panel(&data, &*theme::current()) {
                    assert!(
                        width(&line.text()) <= columns,
                        "columns={columns}: {}",
                        line.text()
                    );
                }
                for line in render(data, columns).to_string().lines() {
                    assert!(
                        width(line) <= columns,
                        "canvas line over {columns}: {line:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn empty_or_hidden_panel_renders_nothing() {
        let data = AgentPanelData {
            rows: Vec::new(),
            max_rows: Some(4),
            selected: None,
            columns: 80,
            tick: 0,
        };
        assert_eq!(render(data, 80).to_string().trim(), "");
        let data = AgentPanelData {
            rows: mixed_rows(),
            max_rows: None,
            selected: None,
            columns: 80,
            tick: 0,
        };
        assert_eq!(render(data, 80).to_string().trim(), "");
    }

    #[derive(Default, Props)]
    struct ConnectedProbeProps {
        store: Option<crate::state::store::AppStore>,
        now_ms: Option<u64>,
        rows: Option<u32>,
    }

    #[component]
    fn ConnectedProbe(
        props: &ConnectedProbeProps,
        mut hooks: Hooks,
    ) -> impl Into<AnyElement<'static>> {
        let store = props.store.clone().expect("probe store");
        let rows = props.rows;
        let now_ms = props.now_ms;
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                crate::state::app_state::AppStateProvider(
                    prebuilt_store: Some(store),
                    children: crate::state::app_state::ProviderChildren::new(move || element! {
                        AgentPanel(
                            columns: Some(80u32),
                            rows: rows,
                            now_ms: now_ms,
                            tick: Some(0usize),
                        )
                    }.into_any()),
                )
            }
        }
    }

    fn connected_store(tasks: Vec<TaskState>) -> crate::state::store::AppStore {
        let mut state = crate::state::app_state_store::AppState::default();
        state.tasks = Arc::new(tasks_map(tasks));
        crate::state::store::AppStore::new(state, None)
    }

    #[test]
    fn connected_panel_reads_tasks_and_publishes_displayed_rows() {
        let store = connected_store(vec![
            TaskState::LocalShell(shell("s1", "cargo test", "running", 0)),
            TaskState::InProcessTeammate(snapshot("t1", "alpha", "running")),
        ]);
        let canvas = element!(ConnectedProbe(
            store: Some(store.clone()),
            now_ms: Some(1_000u64),
            rows: Some(30u32),
        ))
        .render(Some(80));
        let text = canvas.to_string();
        assert!(text.contains("cargo test"), "canvas=\n{text}");
        assert!(text.contains('$'), "canvas=\n{text}");
        assert!(text.contains("@alpha"), "canvas=\n{text}");
        let state = store.get();
        assert_eq!(
            state
                .agent_panel_items
                .iter()
                .map(|item| (item.id.as_str(), item.kind))
                .collect::<Vec<_>>(),
            vec![("s1", AgentKind::Shell), ("t1", AgentKind::Teammate)]
        );
    }

    #[test]
    fn connected_panel_hides_below_sixteen_rows_and_empty_footer_items() {
        let store = connected_store(vec![TaskState::LocalShell(shell(
            "s1",
            "cargo test",
            "running",
            0,
        ))]);
        let canvas = element!(ConnectedProbe(
            store: Some(store.clone()),
            now_ms: Some(1_000u64),
            rows: Some(12u32),
        ))
        .render(Some(80));
        assert_eq!(canvas.to_string().trim(), "");
        assert!(store.get().agent_panel_items.is_empty());
    }

    #[test]
    fn connected_panel_clamps_a_stale_selection() {
        let mut state = crate::state::app_state_store::AppState::default();
        state.tasks = Arc::new(tasks_map(vec![TaskState::LocalShell(shell(
            "s1",
            "cargo test",
            "running",
            0,
        ))]));
        state.agent_panel_selected = 5;
        let store = crate::state::store::AppStore::new(state, None);
        element!(ConnectedProbe(
            store: Some(store.clone()),
            now_ms: Some(1_000u64),
            rows: Some(30u32),
        ))
        .render(Some(80));
        assert_eq!(store.get().agent_panel_selected, 0);
    }
}
