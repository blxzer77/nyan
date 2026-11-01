//! Read-only hook configuration UI.
//! Maps to: CC `components/hooks/**`.

pub mod hooks_config_menu;
pub mod prompt_dialog;
pub mod select_event_mode;
pub mod select_hook_mode;
pub mod select_matcher_mode;
pub mod view_hook_mode;

pub use hooks_config_menu::{HooksConfigMenu, HooksConfigMenuDone};
pub use prompt_dialog::PromptDialog;
pub use select_event_mode::SelectEventMode;
pub use select_hook_mode::SelectHookMode;
pub use select_matcher_mode::SelectMatcherMode;
pub use view_hook_mode::ViewHookMode;

use crate::keybindings::keybinding_context::KeybindingRuntime;
use crate::keybindings::types::ContextName;
use crate::keybindings::use_keybinding::use_keybinding;
use iocraft::prelude::*;

/// The official `Select` owns these actions. Nyan's retained Select renderer
/// receives explicit focus state, so the hooks-family components install the
/// same action handlers at their boundary.
pub(crate) fn use_select_bindings(
    hooks: &mut Hooks,
    option_count: usize,
    focused_index: State<usize>,
    pending_selection: State<Option<usize>>,
) {
    let runtime = hooks
        .try_use_context::<KeybindingRuntime>()
        .map(|runtime| runtime.clone());
    let is_active = option_count > 0;

    use_keybinding(
        hooks,
        runtime.clone(),
        "select:previous",
        ContextName::Select,
        move || is_active,
        {
            let mut focused_index = focused_index;
            move || {
                let current = focused_index.get().min(option_count.saturating_sub(1));
                focused_index.set(if current == 0 {
                    option_count.saturating_sub(1)
                } else {
                    current - 1
                });
                true
            }
        },
    );
    use_keybinding(
        hooks,
        runtime.clone(),
        "select:next",
        ContextName::Select,
        move || is_active,
        {
            let mut focused_index = focused_index;
            move || {
                let current = focused_index.get().min(option_count.saturating_sub(1));
                focused_index.set((current + 1) % option_count.max(1));
                true
            }
        },
    );
    use_keybinding(
        hooks,
        runtime,
        "select:accept",
        ContextName::Select,
        move || is_active,
        {
            let mut pending_selection = pending_selection;
            move || {
                pending_selection.set(Some(
                    focused_index.get().min(option_count.saturating_sub(1)),
                ));
                true
            }
        },
    );
}

pub(crate) fn visible_from_index(focused_index: usize, option_count: usize) -> usize {
    const VISIBLE_COUNT: usize = 5;
    focused_index
        .saturating_sub(VISIBLE_COUNT - 1)
        .min(option_count.saturating_sub(VISIBLE_COUNT))
}
