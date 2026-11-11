//! Maps to: CC `components/Spinner/GlimmerMessage.tsx`.
//! The component owns spinner verb coloring only; row timing and glimmer index
//! are computed by the parent animation row.

use super::SpinnerMode;
use super::utils::interpolate_terminal_color;
use crate::utils::theme::Theme;
use iocraft::prelude::*;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Default, Props)]
pub struct GlimmerMessageProps {
    pub message: String,
    pub mode: SpinnerMode,
    pub message_color: Option<Color>,
    pub glimmer_index: isize,
    pub flash_opacity: f32,
    pub shimmer_color: Option<Color>,
    pub stalled_intensity: f32,
}

fn split_for_glimmer(message: &str, glimmer_index: isize) -> (String, String, String) {
    let shimmer_start = glimmer_index - 1;
    let shimmer_end = glimmer_index + 1;
    let message_width = UnicodeWidthStr::width(message);

    if shimmer_start >= message_width as isize || shimmer_end < 0 {
        return (message.to_string(), String::new(), String::new());
    }

    let clamped_start = shimmer_start.max(0) as usize;
    let mut col_pos = 0usize;
    let mut before = String::new();
    let mut shimmer = String::new();
    let mut after = String::new();

    for grapheme in message.graphemes(true) {
        let width = UnicodeWidthStr::width(grapheme).max(1);
        if col_pos + width <= clamped_start {
            before.push_str(grapheme);
        } else if col_pos > shimmer_end as usize {
            after.push_str(grapheme);
        } else {
            shimmer.push_str(grapheme);
        }
        col_pos += width;
    }

    (before, shimmer, after)
}

#[component]
pub fn GlimmerMessage(props: &GlimmerMessageProps, hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let message_color = props.message_color.unwrap_or(theme.nyan);
    let shimmer_color = props.shimmer_color.unwrap_or(theme.nyan_shimmer);
    let stalled_intensity = props.stalled_intensity.clamp(0.0, 1.0);

    if props.message.is_empty() {
        return element! { View }.into_any();
    }

    if stalled_intensity > 0.0 {
        let color = interpolate_terminal_color(message_color, theme.error, stalled_intensity);
        return element! {
            View(flex_direction: FlexDirection::Row) {
                Text(content: props.message.clone(), color: color, wrap: TextWrap::NoWrap)
                Text(content: " ".to_string(), color: color, wrap: TextWrap::NoWrap)
            }
        }
        .into_any();
    }

    if props.mode == SpinnerMode::ToolUse {
        let color = interpolate_terminal_color(
            message_color,
            shimmer_color,
            props.flash_opacity.clamp(0.0, 1.0),
        );
        return element! {
            View(flex_direction: FlexDirection::Row) {
                Text(content: props.message.clone(), color: color, wrap: TextWrap::NoWrap)
                Text(content: " ".to_string(), color: message_color, wrap: TextWrap::NoWrap)
            }
        }
        .into_any();
    }

    let (before, shimmer, after) = split_for_glimmer(&props.message, props.glimmer_index);
    element! {
        View(flex_direction: FlexDirection::Row) {
            #(if !before.is_empty() {
                Some(element! { Text(content: before, color: message_color, wrap: TextWrap::NoWrap) })
            } else { None })
            #(if !shimmer.is_empty() {
                Some(element! { Text(content: shimmer, color: shimmer_color, wrap: TextWrap::NoWrap) })
            } else { None })
            #(if !after.is_empty() {
                Some(element! { Text(content: after, color: message_color, wrap: TextWrap::NoWrap) })
            } else { None })
            Text(content: " ".to_string(), color: message_color, wrap: TextWrap::NoWrap)
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glimmer_message_splits_by_display_columns() {
        assert_eq!(
            split_for_glimmer("ab界cd", 3),
            ("ab".to_string(), "界c".to_string(), "d".to_string())
        );
    }
}
