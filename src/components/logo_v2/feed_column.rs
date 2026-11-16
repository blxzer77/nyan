//! Maps to: CC `components/LogoV2/FeedColumn.tsx`.

use super::feed::{Feed, FeedConfig, calculate_feed_width};
use crate::components::design_system::divider::Divider;
use iocraft::prelude::*;

#[derive(Default, Props)]
pub struct FeedColumnProps {
    pub feeds: Vec<FeedConfig>,
    pub max_width: usize,
}

#[component]
pub fn FeedColumn(props: &FeedColumnProps, hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    let feed_widths = props
        .feeds
        .iter()
        .map(calculate_feed_width)
        .collect::<Vec<_>>();
    let max_of_all_feeds = feed_widths.into_iter().max().unwrap_or(1);
    let actual_width = max_of_all_feeds.min(props.max_width.max(1));
    let last_index = props.feeds.len().saturating_sub(1);

    element! {
        View(flex_direction: FlexDirection::Column) {
            #(props.feeds.clone().into_iter().enumerate().map(|(index, feed)| {
                element! {
                    Fragment {
                        Feed(config: feed, actual_width: actual_width)
                        #(if index < last_index {
                            Some(element! { Divider(color: theme.nyan, width: actual_width as u32) })
                        } else {
                            None
                        })
                    }
                }
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::logo_v2::feed::FeedLine;
    use crate::utils::theme;

    #[test]
    fn feed_column_uses_max_feed_width_and_dividers_like_official() {
        let feeds = vec![
            FeedConfig {
                title: "Recent activity".to_string(),
                empty_message: Some("No recent activity".to_string()),
                ..FeedConfig::default()
            },
            FeedConfig {
                title: "What's new".to_string(),
                lines: vec![FeedLine::text("A long release note")],
                footer: Some("/release-notes for more".to_string()),
                ..FeedConfig::default()
            },
        ];

        let canvas = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                FeedColumn(feeds: feeds, max_width: 80usize)
            }
        }
        .render(Some(80));
        let text = canvas.to_string();

        assert!(text.contains("Recent activity"), "canvas=\n{text}");
        assert!(text.contains("What's new"), "canvas=\n{text}");
        assert!(text.contains("/release-notes for more"), "canvas=\n{text}");
        assert!(
            text.contains("─"),
            "divider should render between feeds; canvas=\n{text}"
        );
    }
}
