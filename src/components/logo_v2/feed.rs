//! Maps to: CC `components/LogoV2/Feed.tsx`.
//!
//! This module keeps the official `FeedLine` / `FeedConfig` / `Feed` boundary
//! separate from the main logo component. Custom React content is represented
//! as terminal-ready text rows until the corresponding upstream custom feed
//! components are ported.

use iocraft::prelude::*;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedLine {
    pub text: String,
    pub timestamp: Option<String>,
}

impl FeedLine {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            timestamp: None,
        }
    }

    pub fn with_timestamp(text: impl Into<String>, timestamp: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            timestamp: Some(timestamp.into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FeedCustomLineTone {
    #[default]
    Normal,
    Claude,
    Dim,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedCustomContent {
    pub lines: Vec<FeedLine>,
    pub width: usize,
    /// Maps the arbitrary React `customContent.content` styling that official
    /// feed configs use for guest passes and overage-credit rows.
    pub line_tones: Vec<FeedCustomLineTone>,
    /// Maps to the guest-passes `<Box marginY={1}>` wrapper.
    pub margin_y_first_line: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedConfig {
    pub title: String,
    pub lines: Vec<FeedLine>,
    pub footer: Option<String>,
    pub empty_message: Option<String>,
    pub custom_content: Option<FeedCustomContent>,
}

#[derive(Default, Props)]
pub struct FeedProps {
    pub config: FeedConfig,
    pub actual_width: usize,
}

pub fn calculate_feed_width(config: &FeedConfig) -> usize {
    let mut max_width = display_width(&config.title);

    if let Some(custom) = &config.custom_content {
        max_width = max_width.max(custom.width);
    } else if config.lines.is_empty() {
        if let Some(empty_message) = &config.empty_message {
            max_width = max_width.max(display_width(empty_message));
        }
    } else {
        let gap_width = 2usize;
        let max_timestamp_width = config
            .lines
            .iter()
            .filter_map(|line| line.timestamp.as_deref())
            .map(display_width)
            .max()
            .unwrap_or(0);

        for line in &config.lines {
            let timestamp_width = if max_timestamp_width > 0 {
                max_timestamp_width + gap_width
            } else {
                0
            };
            max_width = max_width.max(display_width(&line.text) + timestamp_width);
        }
    }

    if let Some(footer) = &config.footer {
        max_width = max_width.max(display_width(footer));
    }

    max_width
}

#[component]
pub fn Feed(props: &FeedProps, hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    let actual_width = props.actual_width.max(1);
    let max_timestamp_width = props
        .config
        .lines
        .iter()
        .filter_map(|line| line.timestamp.as_deref())
        .map(display_width)
        .max()
        .unwrap_or(0);

    element! {
        View(flex_direction: FlexDirection::Column, width: actual_width as u32) {
            Text(content: props.config.title.clone(), weight: Weight::Bold, color: theme.claude, wrap: TextWrap::NoWrap)
            #(if let Some(custom) = props.config.custom_content.clone() {
                let line_tones = custom.line_tones.clone();
                let margin_y_first_line = custom.margin_y_first_line;
                Some(element! {
                    View(flex_direction: FlexDirection::Column) {
                        #(custom.lines.into_iter().enumerate().map(|(index, line)| {
                            let tone = line_tones.get(index).copied().unwrap_or_default();
                            render_custom_feed_line(line, actual_width, tone, margin_y_first_line && index == 0, *theme)
                        }))
                        #(props.config.footer.as_ref().map(|footer| element! {
                            Text(content: truncate_to_width(footer, actual_width), color: theme.inactive, italic: true, wrap: TextWrap::NoWrap)
                        }))
                    }
                }.into_any())
            } else if props.config.lines.is_empty() {
                props.config.empty_message.as_ref().map(|empty_message| element! {
                    Text(content: truncate_to_width(empty_message, actual_width), color: theme.inactive, wrap: TextWrap::NoWrap)
                }.into_any())
            } else {
                Some(element! {
                    View(flex_direction: FlexDirection::Column) {
                        #(props.config.lines.clone().into_iter().map(|line| render_feed_line(line, actual_width, max_timestamp_width)))
                        #(props.config.footer.as_ref().map(|footer| element! {
                            Text(content: truncate_to_width(footer, actual_width), color: theme.inactive, italic: true, wrap: TextWrap::NoWrap)
                        }))
                    }
                }.into_any())
            })
        }
    }
}

fn render_custom_feed_line(
    line: FeedLine,
    actual_width: usize,
    tone: FeedCustomLineTone,
    margin_y: bool,
    theme: crate::utils::theme::Theme,
) -> AnyElement<'static> {
    let color = match tone {
        FeedCustomLineTone::Normal => None,
        FeedCustomLineTone::Claude => Some(theme.claude),
        FeedCustomLineTone::Dim => Some(theme.inactive),
    };
    let content = truncate_to_width(&line.text, actual_width);

    element! {
        View(margin_y: if margin_y { 1u32 } else { 0u32 }) {
            Text(content: content, color: color, wrap: TextWrap::NoWrap)
        }
    }
    .into_any()
}

fn render_feed_line(
    line: FeedLine,
    actual_width: usize,
    max_timestamp_width: usize,
) -> AnyElement<'static> {
    let text_width = if max_timestamp_width > 0 {
        actual_width.saturating_sub(max_timestamp_width + 2).max(10)
    } else {
        actual_width
    };
    let timestamp = line.timestamp.unwrap_or_default();
    let padded_timestamp = pad_to_display_width(&timestamp, max_timestamp_width);
    let text = truncate_to_width(&line.text, text_width);

    if max_timestamp_width > 0 {
        element! {
            View(flex_direction: FlexDirection::Row) {
                Text(content: padded_timestamp, dim: true, wrap: TextWrap::NoWrap)
                Text(content: "  ".to_string(), wrap: TextWrap::NoWrap)
                Text(content: text, wrap: TextWrap::NoWrap)
            }
        }
        .into_any()
    } else {
        element! {
            Text(content: text, wrap: TextWrap::NoWrap)
        }
        .into_any()
    }
}

fn pad_to_display_width(text: &str, width: usize) -> String {
    let current = display_width(text);
    if current >= width {
        text.to_string()
    } else {
        format!("{}{}", text, " ".repeat(width - current))
    }
}

fn truncate_to_width(text: &str, max_width: usize) -> String {
    if display_width(text) <= max_width {
        return text.to_string();
    }
    if max_width <= 1 {
        return "…".to_string();
    }

    let mut width = 0usize;
    let mut result = String::new();
    for ch in text.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if width + ch_width > max_width - 1 {
            break;
        }
        result.push(ch);
        width += ch_width;
    }
    result.push('…');
    result
}

fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    fn render_feed(config: FeedConfig, actual_width: usize) -> String {
        let canvas = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                Feed(config: config, actual_width: actual_width)
            }
        }
        .render(Some(actual_width));
        canvas.to_string()
    }

    #[test]
    fn feed_width_matches_official_timestamp_footer_rules() {
        let config = FeedConfig {
            title: "Recent activity".to_string(),
            lines: vec![
                FeedLine::with_timestamp("Implemented the renderer", "2h ago"),
                FeedLine::with_timestamp("Reviewed", "yesterday"),
            ],
            footer: Some("/resume for more".to_string()),
            empty_message: Some("No recent activity".to_string()),
            custom_content: None,
        };

        assert_eq!(calculate_feed_width(&config), 35);
    }

    #[test]
    fn feed_renders_timestamp_lines_and_footer_like_official_component() {
        let config = FeedConfig {
            title: "Recent activity".to_string(),
            lines: vec![
                FeedLine::with_timestamp("Implemented the renderer", "2h ago"),
                FeedLine::with_timestamp("Reviewed", "yesterday"),
            ],
            footer: Some("/resume for more".to_string()),
            empty_message: Some("No recent activity".to_string()),
            custom_content: None,
        };

        let text = render_feed(config, 35);
        assert!(text.contains("Recent activity"), "canvas=\n{text}");
        assert!(
            text.contains("2h ago     Implemented the renderer"),
            "canvas=\n{text}"
        );
        assert!(text.contains("yesterday  Reviewed"), "canvas=\n{text}");
        assert!(text.contains("/resume for more"), "canvas=\n{text}");
    }

    #[test]
    fn feed_empty_state_uses_official_empty_message_branch() {
        let config = FeedConfig {
            title: "What's new".to_string(),
            empty_message: Some("Check the nyan changelog for updates".to_string()),
            ..FeedConfig::default()
        };

        let text = render_feed(config, 24);
        assert!(text.contains("What's new"), "canvas=\n{text}");
        assert!(text.contains("Check the nyan changelo…"), "canvas=\n{text}");
    }
}
