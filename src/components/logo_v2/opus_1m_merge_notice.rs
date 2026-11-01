//! Maps to: CC `components/LogoV2/Opus1mMergeNotice.tsx`.
//!
//! The official component increments `opus1mMergeNoticeSeenCount` when shown.
//! nyan keeps the show predicate and render boundary pure until LogoV2
//! startup notices are allowed to write global config.

use super::animated_asterisk::AnimatedAsterisk;
use crate::constants::figures::UP_ARROW;
use iocraft::prelude::*;

pub const OPUS_1M_MERGE_MAX_SHOW_COUNT: u32 = 6;

#[derive(Default, Props)]
pub struct Opus1mMergeNoticeProps {
    pub opus_1m_merge_enabled: bool,
    pub seen_count: u32,
}

pub fn should_show_opus_1m_merge_notice(opus_1m_merge_enabled: bool, seen_count: u32) -> bool {
    opus_1m_merge_enabled && seen_count < OPUS_1M_MERGE_MAX_SHOW_COUNT
}

#[component]
pub fn Opus1mMergeNotice(
    props: &Opus1mMergeNoticeProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    let show = should_show_opus_1m_merge_notice(props.opus_1m_merge_enabled, props.seen_count);

    element! {
        Fragment {
            #(show.then(|| element! {
                View(padding_left: 2u32, flex_direction: FlexDirection::Row) {
                    AnimatedAsterisk(ch: Some(UP_ARROW.to_string()))
                    Text(content: " Opus now defaults to 1M context · 5x more room, same pricing".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap)
                }
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    fn render_notice(enabled: bool, seen_count: u32) -> String {
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                Opus1mMergeNotice(opus_1m_merge_enabled: enabled, seen_count: seen_count)
            }
        }
        .render(Some(120))
        .to_string()
    }

    #[test]
    fn opus_1m_merge_notice_show_gate_matches_official_count() {
        assert!(should_show_opus_1m_merge_notice(true, 0));
        assert!(should_show_opus_1m_merge_notice(true, 5));
        assert!(!should_show_opus_1m_merge_notice(true, 6));
        assert!(!should_show_opus_1m_merge_notice(false, 0));
    }

    #[test]
    fn opus_1m_merge_notice_renders_official_copy_when_visible() {
        let text = render_notice(true, 0);
        assert!(text.contains("↑"), "canvas=\n{text}");
        assert!(
            text.contains("Opus now defaults to 1M context · 5x more room, same pricing"),
            "canvas=\n{text}"
        );
    }

    #[test]
    fn opus_1m_merge_notice_renders_nothing_after_max_count() {
        let text = render_notice(true, OPUS_1M_MERGE_MAX_SHOW_COUNT);
        assert!(text.trim().is_empty(), "canvas=\n{text}");
    }
}
