//! Maps to: CC `components/ConfigurableShortcutHint.tsx`.
//!
//! Runtime boundary: the official component calls `useShortcutDisplay(action,
//! context, fallback)` to read the keybinding registry. Nyan reads the same
//! injected runtime snapshot; provider-less render tests fall back to the static
//! default table without loading config from the retained frame.

use crate::components::design_system::keyboard_shortcut_hint::KeyboardShortcutHint;
use crate::keybindings::shortcut_format::get_shortcut_display_from_bindings;
use crate::keybindings::types::ContextName;
use iocraft::prelude::*;

#[derive(Default, Props)]
pub struct ConfigurableShortcutHintProps {
    /// Maps to official `action: KeybindingAction`.
    pub action: String,
    /// Maps to official `context: KeybindingContextName`.
    pub context: String,
    /// Maps to official `fallback`.
    pub fallback: String,
    /// Maps to official `description`; passed as `KeyboardShortcutHint.action`.
    pub description: String,
    pub parens: bool,
    pub bold: bool,
    /// Explicit style projection for parents that wrap the official component
    /// in a styled Ink `<Text>` node.
    pub dim: bool,
    pub italic: bool,
}

#[component]
pub fn ConfigurableShortcutHint(
    props: &ConfigurableShortcutHintProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let context = ContextName::from_official_str(&props.context);
    let runtime = hooks
        .try_use_context::<crate::keybindings::keybinding_context::KeybindingRuntime>()
        .map(|runtime| runtime.clone());
    let shortcut = if let Some(runtime) = runtime {
        get_shortcut_display_from_bindings(
            &props.action,
            &context,
            &props.fallback,
            runtime.bindings().as_slice(),
        )
    } else {
        let defaults = crate::keybindings::default_bindings::default_bindings();
        get_shortcut_display_from_bindings(&props.action, &context, &props.fallback, &defaults)
    };

    element! {
        KeyboardShortcutHint(
            shortcut: shortcut,
            action: props.description.clone(),
            parens: props.parens,
            bold: props.bold,
            dim: props.dim,
            italic: props.italic,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configurable_shortcut_hint_renders_configured_default_like_official() {
        let text = element! {
            ConfigurableShortcutHint(
                action: "confirm:no".to_string(),
                context: "Confirmation".to_string(),
                fallback: "Esc".to_string(),
                description: "cancel".to_string(),
            )
        }
        .render(Some(40))
        .to_string();

        assert_eq!(text.trim_end(), "Esc to cancel");
    }

    #[test]
    fn configurable_shortcut_hint_forwards_parentheses_and_bold_props() {
        let canvas = element! {
            ConfigurableShortcutHint(
                action: "missing:action".to_string(),
                context: "Global".to_string(),
                fallback: "ctrl+o".to_string(),
                description: "expand".to_string(),
                parens: true,
                bold: true,
            )
        }
        .render(Some(80));

        assert_eq!(canvas.to_string().trim_end(), "(ctrl+o to expand)");
        assert_eq!(
            canvas
                .resolved_text_style(1, 0)
                .expect("shortcut style")
                .weight,
            Weight::Bold
        );
    }

    #[test]
    fn configurable_shortcut_hint_projects_parent_text_style() {
        let canvas = element! {
            ConfigurableShortcutHint(
                action: "confirm:no".to_string(),
                context: "Confirmation".to_string(),
                fallback: "Esc".to_string(),
                description: "close".to_string(),
                dim: true,
                italic: true,
            )
        }
        .render(Some(40));
        let style = canvas.resolved_text_style(0, 0).expect("hint style");
        assert_eq!(style.weight, Weight::Light);
        assert!(style.italic);
    }

    #[test]
    fn configurable_shortcut_hint_reads_live_injected_runtime() {
        let mut bindings = crate::keybindings::default_bindings::default_bindings();
        bindings.push(crate::keybindings::types::ParsedBinding {
            chord: crate::keybindings::parser::parse_chord("right"),
            action: None,
            context: ContextName::Attachments,
        });
        bindings.push(crate::keybindings::types::ParsedBinding {
            chord: crate::keybindings::parser::parse_chord("f4"),
            action: Some("attachments:next".to_string()),
            context: ContextName::Attachments,
        });
        let runtime = crate::keybindings::keybinding_context::KeybindingRuntime::new(bindings);
        let text = element! {
            ContextProvider(value: Context::owned(runtime)) {
                ConfigurableShortcutHint(
                    action: "attachments:next".to_string(),
                    context: "Attachments".to_string(),
                    fallback: "→".to_string(),
                    description: "next".to_string(),
                )
            }
        }
        .render(Some(80))
        .to_string();

        assert_eq!(text.trim_end(), "f4 to next");
    }
}
