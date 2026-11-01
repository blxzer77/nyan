//! Maps to: CC `components/TeammateViewHeader.tsx`.
//!
//! Official component selects the currently viewed teammate from AppState.
//! Nyan keeps AppState selection outside this render boundary and receives
//! the already-selected teammate task as props.

use crate::components::design_system::keyboard_shortcut_hint::KeyboardShortcutHint;
use crate::components::offscreen_freeze::OffscreenFreeze;
use iocraft::prelude::*;

#[derive(Clone, Debug, PartialEq)]
pub struct ViewedTeammateTask {
    pub agent_name: String,
    pub prompt: String,
    pub name_color: Option<Color>,
}

#[derive(Default, Props)]
pub struct TeammateViewHeaderProps {
    pub viewed_teammate: Option<ViewedTeammateTask>,
}

/// Maps to: CC `components/TeammateViewHeader.tsx#TeammateViewHeader`.
#[component]
pub fn TeammateViewHeader(props: &TeammateViewHeaderProps) -> impl Into<AnyElement<'static>> {
    let Some(viewed_teammate) = props.viewed_teammate.clone() else {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    };

    element! {
        OffscreenFreeze {
            View(flex_direction: FlexDirection::Column, margin_bottom: 1u32) {
                View(flex_direction: FlexDirection::Row) {
                    Text(content: "Viewing ".to_string(), wrap: TextWrap::NoWrap)
                    Text(
                        content: format!("@{}", viewed_teammate.agent_name),
                        color: viewed_teammate.name_color,
                        weight: Weight::Bold,
                        wrap: TextWrap::NoWrap,
                    )
                    Text(content: " · ".to_string(), dim: true, wrap: TextWrap::NoWrap)
                    KeyboardShortcutHint(shortcut: "esc".to_string(), action: "return".to_string())
                }
                Text(content: viewed_teammate.prompt, dim: true, wrap: TextWrap::Wrap)
            }
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teammate_view_header_hidden_without_viewed_teammate() {
        let text = element! { TeammateViewHeader }.render(Some(80)).to_string();
        assert_eq!(text, "");
    }

    #[test]
    fn teammate_view_header_renders_name_prompt_and_escape_hint() {
        let canvas = element! {
            TeammateViewHeader(viewed_teammate: Some(ViewedTeammateTask {
                agent_name: "worker".to_string(),
                prompt: "Investigate failures".to_string(),
                name_color: Some(Color::Blue),
            }))
        }
        .render(Some(100));
        let text = canvas.to_string();

        assert!(text.contains("Viewing @worker"), "canvas=\n{text}");
        assert!(text.contains("esc to return"), "canvas=\n{text}");
        assert!(text.contains("Investigate failures"), "canvas=\n{text}");
        assert_eq!(
            canvas
                .resolved_text_style("Viewing ".len(), 0)
                .and_then(|style| style.color),
            Some(Color::Blue)
        );
    }
}
