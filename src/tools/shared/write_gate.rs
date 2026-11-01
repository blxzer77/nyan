//! Copy for the repository-wide no-write mode.
//!
//! DEVIATION(SECURITY): CC has no equivalent gate, so these strings surface —
//! in the model's context, in a notification, or in a slash-command result —
//! where the official product would have written the file. They are
//! deliberately phrased without product or environment-variable names so
//! neither the model nor the user learns a Nyan-specific escape hatch, and
//! they live here so every mutation path and its pre-flight gate share one
//! wording.
//!
//! LEDGER (ruled 2026-08-30, verification batch): this file has NO
//! `docs/MODULE_MAP.tsv` row and correctly cannot have one. That TSV is keyed
//! by `cc_path`; CC's `tools/shared/` holds exactly two files
//! (`gitOperationTracking.ts`, `spawnMultiAgent.ts`) and neither declares any
//! of these constants, so inventing a key to hang a row on would put a
//! non-existent CC path in the primary column. The module doc is the durable
//! record instead. The same reasoning covers `utils/process_runtime.rs`, the
//! other Rust-only carrier, which also has no row.
//!
//! PLACEMENT, recorded not fixed: the consumers reach well outside `tools/` —
//! `tasks/local_shell_task`, `utils/{cron_tasks,teammate_mailbox}`,
//! `utils/permissions/permission_update`, `utils/plugins/hint_recommendation`,
//! `utils/sandbox/sandbox_adapter`, `hooks/tool_permission/permission_context`
//! and `services/tools/tool_execution` all import from here. A repo-wide gate
//! under `tools/shared/` is a Rust-only choice with no CC precedent either way
//! (CC has no gate at all), so there is no source to align to and no parity
//! reason to move it; moving it would only churn ~15 import paths.

pub const FILE_WRITE_DISABLED_ERROR: &str =
    "File writes are disabled in this session; write was not applied";
pub const FILE_EDIT_DISABLED_ERROR: &str =
    "File writes are disabled in this session; edit was not applied";
pub const NOTEBOOK_EDIT_DISABLED_ERROR: &str =
    "File writes are disabled in this session; notebook edit was not applied";
pub const SED_EDIT_DISABLED_ERROR: &str =
    "File writes are disabled in this session; sed edit was not applied";
pub const MAILBOX_DELIVERY_DISABLED_ERROR: &str =
    "File writes are disabled in this session; message was not delivered";
pub const BACKGROUND_COMMAND_DISABLED_ERROR: &str =
    "File writes are disabled in this session; background command was not started";
pub const CRON_PERSISTENCE_DISABLED_ERROR: &str =
    "File writes are disabled in this session; scheduled task was not saved";
pub const PERMISSION_PERSISTENCE_DISABLED_ERROR: &str =
    "File writes are disabled in this session; permission update was not saved";
pub const PLUGIN_HINT_PERSISTENCE_DISABLED_ERROR: &str =
    "File writes are disabled in this session; plugin hint preference was not saved";
pub const SANDBOX_SETTINGS_DISABLED_ERROR: &str =
    "File writes are disabled in this session; sandbox settings were not saved";
pub const KEYBINDINGS_EDIT_DISABLED_ERROR: &str =
    "File writes are disabled in this session; keybindings file was not opened";
