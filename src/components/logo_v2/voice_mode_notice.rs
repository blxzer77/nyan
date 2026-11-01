//! Maps to: CC `components/LogoV2/VoiceModeNotice.tsx`.
//!
//! The official component is feature-gated and increments
//! `voiceNoticeSeenCount` when shown. nyan preserves the predicate and
//! render boundary as pure inputs; no settings/global-config writes occur here.

use super::animated_asterisk::AnimatedAsterisk;
use iocraft::prelude::*;

pub const VOICE_MODE_NOTICE_MAX_SHOW_COUNT: u32 = 3;

#[derive(Default, Props)]
pub struct VoiceModeNoticeProps {
    pub feature_enabled: bool,
    pub voice_mode_enabled: bool,
    pub settings_voice_enabled: bool,
    pub voice_notice_seen_count: u32,
    pub opus_1m_merge_notice_should_show: bool,
}

pub fn should_show_voice_mode_notice(
    feature_enabled: bool,
    voice_mode_enabled: bool,
    settings_voice_enabled: bool,
    voice_notice_seen_count: u32,
    opus_1m_merge_notice_should_show: bool,
) -> bool {
    feature_enabled
        && voice_mode_enabled
        && !settings_voice_enabled
        && voice_notice_seen_count < VOICE_MODE_NOTICE_MAX_SHOW_COUNT
        && !opus_1m_merge_notice_should_show
}

#[component]
pub fn VoiceModeNotice(
    props: &VoiceModeNoticeProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    let show = should_show_voice_mode_notice(
        props.feature_enabled,
        props.voice_mode_enabled,
        props.settings_voice_enabled,
        props.voice_notice_seen_count,
        props.opus_1m_merge_notice_should_show,
    );

    element! {
        Fragment {
            #(show.then(|| element! {
                View(padding_left: 2u32, flex_direction: FlexDirection::Row) {
                    AnimatedAsterisk
                    Text(content: " Voice mode is now available · /voice to enable".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap)
                }
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    fn render_notice(props: VoiceModeNoticeProps) -> String {
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                VoiceModeNotice(
                    feature_enabled: props.feature_enabled,
                    voice_mode_enabled: props.voice_mode_enabled,
                    settings_voice_enabled: props.settings_voice_enabled,
                    voice_notice_seen_count: props.voice_notice_seen_count,
                    opus_1m_merge_notice_should_show: props.opus_1m_merge_notice_should_show,
                )
            }
        }
        .render(Some(120))
        .to_string()
    }

    #[test]
    fn voice_mode_notice_show_gate_matches_official_conditions() {
        assert!(should_show_voice_mode_notice(true, true, false, 0, false));
        assert!(!should_show_voice_mode_notice(false, true, false, 0, false));
        assert!(!should_show_voice_mode_notice(true, false, false, 0, false));
        assert!(!should_show_voice_mode_notice(true, true, true, 0, false));
        assert!(!should_show_voice_mode_notice(true, true, false, 3, false));
        assert!(!should_show_voice_mode_notice(true, true, false, 0, true));
    }

    #[test]
    fn voice_mode_notice_renders_official_copy_when_visible() {
        let text = render_notice(VoiceModeNoticeProps {
            feature_enabled: true,
            voice_mode_enabled: true,
            settings_voice_enabled: false,
            voice_notice_seen_count: 0,
            opus_1m_merge_notice_should_show: false,
        });
        assert!(text.contains("✻"), "canvas=\n{text}");
        assert!(
            text.contains("Voice mode is now available · /voice to enable"),
            "canvas=\n{text}"
        );
    }

    #[test]
    fn voice_mode_notice_renders_nothing_when_opus_notice_takes_priority() {
        let text = render_notice(VoiceModeNoticeProps {
            feature_enabled: true,
            voice_mode_enabled: true,
            settings_voice_enabled: false,
            voice_notice_seen_count: 0,
            opus_1m_merge_notice_should_show: true,
        });
        assert!(text.trim().is_empty(), "canvas=\n{text}");
    }
}
