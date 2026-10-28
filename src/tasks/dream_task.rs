//! Background task entry for auto-dream (memory consolidation subagent).
//!
//! Maps to: CC `tasks/DreamTask/DreamTask.ts:1-157`.
//!
//! Live surface today: the turn-duration transcript line projects Dream
//! entries into its pill label (`components/messages/turn_duration_message.rs`
//! → `PillTask::Dream`), and TaskStopTool / the SDK stop_task dispatch can
//! kill a dream (`tasks/stop_task.rs` "dream" arm → [`kill_dream_task`]).
//!
//! SEAMS:
//! - driver missing: CC's producer is `services/autoDream/autoDream.ts`
//!   (fork + onMessage feed), not ported (auto-dream TODO in
//!   `query/stop_hooks.rs`) — `register_dream_task` has no production caller.
//! - the Dream pill/dialog projection and kill dispatch are wired in the
//!   background-task component; the idle producer still belongs to the
//!   unregistered `services/auto_dream` seam.
//! - `rollbackConsolidationLock` is implemented by
//!   `services/auto_dream/lock.rs`, but the kill path still needs the
//!   coordinator's lock handle to invoke it after registration.

use crate::state::app_state_store::TaskState;
use crate::state::store::AppStore;
use crate::task::{TaskType, generate_task_id};
use crate::tool::AbortController;
use crate::utils::task::framework::{register_task, update_task_state};
use std::sync::Arc;

/// Maps to: CC `DreamTask.ts:12` — keep only the N most recent turns for live
/// display.
const MAX_TURNS: usize = 30;

/// Maps to: CC `DreamTask.ts:15-18` — a single assistant turn from the dream
/// agent, tool uses collapsed to a count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DreamTurn {
    pub text: String,
    pub tool_use_count: usize,
}

/// Maps to: CC `DreamTask.ts:20-23` — no phase detection; flip from
/// `starting` to `updating` when the first Edit/Write tool_use lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DreamPhase {
    Starting,
    Updating,
}

impl DreamPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Updating => "updating",
        }
    }
}

/// Maps to: CC `DreamTask.ts:25-41` `DreamTaskState` (TaskStateBase subset the
/// Rust union carries + the dream-specific fields).
#[derive(Clone, Debug, PartialEq)]
pub struct DreamTaskState {
    pub id: String,
    pub task_type: String,
    pub status: String,
    pub description: String,
    pub notified: bool,
    /// Maps to CC `TaskStateBase.startTime` (epoch ms).
    pub start_time: u64,
    pub end_time: Option<u64>,
    pub phase: DreamPhase,
    pub sessions_reviewing: usize,
    /// Paths observed in Edit/Write tool_use blocks via onMessage — an
    /// INCOMPLETE reflection ("at least these were touched"), CC `:29-35`.
    pub files_touched: Vec<String>,
    /// Assistant text responses, tool uses collapsed; prompt NOT included.
    pub turns: Vec<DreamTurn>,
    pub abort_controller: Option<AbortController>,
    /// Stashed so kill can rewind the consolidation-lock mtime (CC `:39-40`).
    /// Epoch ms (CC stores `mtimeMs`).
    pub prior_mtime: u64,
}

impl Eq for DreamTaskState {}

/// Maps to: CC `DreamTask.ts:43-50` `isDreamTask` — the Rust enum discriminant
/// supplies the runtime guard; this preserves the source name for consumers.
pub fn is_dream_task(task: &TaskState) -> Option<&DreamTaskState> {
    match task {
        TaskState::Dream(task) => Some(task),
        _ => None,
    }
}

/// Maps to: CC `DreamTask.ts:52-74` `registerDreamTask`.
pub fn register_dream_task(
    store: &AppStore,
    sessions_reviewing: usize,
    prior_mtime: u64,
    abort_controller: AbortController,
) -> String {
    let id = generate_task_id(TaskType::Dream);
    let task = DreamTaskState {
        // CC `:62` createTaskStateBase(id, 'dream', 'dreaming') + `:64`
        // status: 'running'.
        id: id.clone(),
        task_type: "dream".to_string(),
        status: "running".to_string(),
        description: "dreaming".to_string(),
        notified: false,
        start_time: crate::utils::task::framework::now_ms(),
        end_time: None,
        phase: DreamPhase::Starting,
        sessions_reviewing,
        files_touched: Vec::new(),
        turns: Vec::new(),
        abort_controller: Some(abort_controller),
        prior_mtime,
    };
    register_task(TaskState::Dream(task), store);
    id
}

/// Maps to: CC `DreamTask.ts:76-104` `addDreamTurn`.
pub fn add_dream_turn(task_id: &str, turn: DreamTurn, touched_paths: &[String], store: &AppStore) {
    update_task_state(task_id, store, |existing| {
        let TaskState::Dream(task) = existing.as_ref() else {
            return Arc::clone(existing);
        };
        // CC `:83-84` — `const seen = new Set(task.filesTouched);
        // touchedPaths.filter(p => !seen.has(p) && seen.add(p))`: the Set
        // grows during the filter, so duplicates WITHIN the batch dedupe too.
        let mut seen: std::collections::HashSet<&str> = task
            .files_touched
            .iter()
            .map(|path| path.as_str())
            .collect();
        let new_touched: Vec<String> = touched_paths
            .iter()
            .filter(|path| seen.insert(path.as_str()))
            .cloned()
            .collect();
        // CC `:86-93` — skip the update entirely if the turn is empty AND
        // nothing new was touched (the same-reference return is the ptr_eq
        // no-op).
        if turn.text.is_empty() && turn.tool_use_count == 0 && new_touched.is_empty() {
            return Arc::clone(existing);
        }
        let mut next = task.clone();
        if !new_touched.is_empty() {
            next.phase = DreamPhase::Updating;
            next.files_touched.extend(new_touched);
        }
        // CC `:101` — `task.turns.slice(-(MAX_TURNS - 1)).concat(turn)`.
        let keep_from = next.turns.len().saturating_sub(MAX_TURNS - 1);
        next.turns.drain(..keep_from);
        next.turns.push(turn);
        Arc::new(TaskState::Dream(next))
    });
}

/// Maps to: CC `DreamTask.ts:106-120` `completeDreamTask` — `notified: true`
/// immediately: dream has no model-facing notification path (UI-only), and
/// eviction requires terminal + notified.
pub fn complete_dream_task(task_id: &str, store: &AppStore) {
    update_task_state(task_id, store, |existing| {
        let TaskState::Dream(task) = existing.as_ref() else {
            return Arc::clone(existing);
        };
        let mut next = task.clone();
        next.status = "completed".to_string();
        next.end_time = Some(crate::utils::task::framework::now_ms());
        next.notified = true;
        next.abort_controller = None;
        Arc::new(TaskState::Dream(next))
    });
}

/// Maps to: CC `DreamTask.ts:122-130` `failDreamTask`.
pub fn fail_dream_task(task_id: &str, store: &AppStore) {
    update_task_state(task_id, store, |existing| {
        let TaskState::Dream(task) = existing.as_ref() else {
            return Arc::clone(existing);
        };
        let mut next = task.clone();
        next.status = "failed".to_string();
        next.end_time = Some(crate::utils::task::framework::now_ms());
        next.notified = true;
        next.abort_controller = None;
        Arc::new(TaskState::Dream(next))
    });
}

/// Maps to: CC `DreamTask.ts:132-157` `DreamTask.kill`.
///
/// Returns true when a running task transitioned to killed.
///
/// SEAM (coordinator registration): CC rewinds the consolidation-lock mtime
/// via `rollbackConsolidationLock(priorMtime)` (`:153-155`) so the next
/// session can retry. The lock implementation lives in the unregistered
/// `services/auto_dream/lock.rs`; the coordinator must retain its lease and
/// call `rollback` after this state transition.
pub fn kill_dream_task(task_id: &str, store: &AppStore) -> bool {
    let mut killed = false;
    update_task_state(task_id, store, |existing| {
        let TaskState::Dream(task) = existing.as_ref() else {
            return Arc::clone(existing);
        };
        // CC `:139` — `if (task.status !== 'running') return task`.
        if task.status != "running" {
            return Arc::clone(existing);
        }
        // CC `:140` — abort inside the updater (atomic-flag side effect).
        if let Some(abort) = &task.abort_controller {
            abort.abort();
        }
        killed = true;
        let mut next = task.clone();
        next.status = "killed".to_string();
        next.end_time = Some(crate::utils::task::framework::now_ms());
        next.notified = true;
        next.abort_controller = None;
        Arc::new(TaskState::Dream(next))
    });
    killed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::app_state_store::AppState;

    fn store() -> AppStore {
        AppStore::new(AppState::default(), None)
    }

    fn dream(store: &AppStore, task_id: &str) -> DreamTaskState {
        let state = store.get();
        match state.tasks.get(task_id).map(|task| task.as_ref().clone()) {
            Some(TaskState::Dream(task)) => task,
            other => panic!("expected a Dream entry for {task_id}, got {other:?}"),
        }
    }

    #[test]
    fn register_creates_running_starting_dream_with_official_base() {
        let store = store();
        let abort = AbortController::default();
        let id = register_dream_task(&store, 3, 42, abort);
        assert!(id.starts_with('d'));
        assert_eq!(id.len(), 9);
        let task = dream(&store, &id);
        assert_eq!(task.status, "running");
        assert_eq!(task.description, "dreaming");
        assert_eq!(task.phase, DreamPhase::Starting);
        assert_eq!(task.sessions_reviewing, 3);
        assert_eq!(task.prior_mtime, 42);
        assert!(!task.notified);
    }

    #[test]
    fn add_dream_turn_flips_phase_dedupes_paths_and_caps_turns() {
        let store = store();
        let id = register_dream_task(&store, 1, 0, AbortController::default());

        // CC :86-93 — pure no-op turn installs nothing (same reference).
        let revision = store.revision();
        add_dream_turn(
            &id,
            DreamTurn {
                text: String::new(),
                tool_use_count: 0,
            },
            &[],
            &store,
        );
        assert_eq!(store.revision(), revision, "empty turn is a ptr_eq no-op");

        add_dream_turn(
            &id,
            DreamTurn {
                text: "consolidating".to_string(),
                tool_use_count: 2,
            },
            &["/tmp/a.md".to_string(), "/tmp/a.md".to_string()],
            &store,
        );
        let task = dream(&store, &id);
        assert_eq!(task.phase, DreamPhase::Updating);
        assert_eq!(task.files_touched, vec!["/tmp/a.md".to_string()]);
        assert_eq!(task.turns.len(), 1);

        // CC :101 — turns capped at MAX_TURNS.
        for index in 0..40 {
            add_dream_turn(
                &id,
                DreamTurn {
                    text: format!("turn {index}"),
                    tool_use_count: 0,
                },
                &[],
                &store,
            );
        }
        let task = dream(&store, &id);
        assert_eq!(task.turns.len(), MAX_TURNS);
        assert_eq!(task.turns.last().unwrap().text, "turn 39");
    }

    #[test]
    fn terminal_transitions_set_notified_and_kill_aborts_running_only() {
        let store = store();
        let abort = AbortController::default();
        let id = register_dream_task(&store, 1, 7, abort.clone());

        assert!(kill_dream_task(&id, &store));
        assert!(abort.is_aborted());
        let task = dream(&store, &id);
        assert_eq!(task.status, "killed");
        assert!(task.notified);
        assert!(task.abort_controller.is_none());
        // CC :139 — already terminal: no-op.
        assert!(!kill_dream_task(&id, &store));

        let id = register_dream_task(&store, 1, 0, AbortController::default());
        complete_dream_task(&id, &store);
        let task = dream(&store, &id);
        assert_eq!(task.status, "completed");
        assert!(task.notified);

        let id = register_dream_task(&store, 1, 0, AbortController::default());
        fail_dream_task(&id, &store);
        let task = dream(&store, &id);
        assert_eq!(task.status, "failed");
        assert!(task.notified);
    }
}
