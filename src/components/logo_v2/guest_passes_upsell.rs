//! Maps to: CC `components/LogoV2/GuestPassesUpsell.tsx`.
//!
//! Official reads referral caches, resets global-config counters when passes
//! refresh, increments impression count, and logs analytics. nyan keeps the
//! same predicate and condensed-row render boundary as pure inputs; callers own
//! cache refresh, config writes, and analytics.

use iocraft::prelude::*;

pub const GUEST_PASSES_MAX_SHOW_COUNT: u32 = 3;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GuestPassesUpsellSnapshot {
    pub eligible: bool,
    pub has_cache: bool,
    pub remaining_passes: Option<u32>,
    pub passes_last_seen_remaining: u32,
    pub passes_upsell_seen_count: u32,
    pub has_visited_passes: bool,
}

#[derive(Default, Props)]
pub struct GuestPassesUpsellProps {
    /// Already-formatted reward amount, matching official `formatCreditAmount`.
    pub reward_text: Option<String>,
}

pub fn passes_should_reset(snapshot: &GuestPassesUpsellSnapshot) -> bool {
    snapshot
        .remaining_passes
        .is_some_and(|remaining| remaining > 0 && remaining > snapshot.passes_last_seen_remaining)
}

pub fn should_show_guest_passes_upsell(snapshot: &GuestPassesUpsellSnapshot) -> bool {
    if !snapshot.eligible || !snapshot.has_cache {
        return false;
    }

    let seen_count = if passes_should_reset(snapshot) {
        0
    } else {
        snapshot.passes_upsell_seen_count
    };
    let has_visited_passes = if passes_should_reset(snapshot) {
        false
    } else {
        snapshot.has_visited_passes
    };

    seen_count < GUEST_PASSES_MAX_SHOW_COUNT && !has_visited_passes
}

#[component]
pub fn GuestPassesUpsell(
    props: &GuestPassesUpsellProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    let copy = props
        .reward_text
        .as_ref()
        .map(|reward| format!("Share Claude Code and earn {reward} of extra usage · /passes"))
        .unwrap_or_else(|| "3 guest passes at /passes".to_string());

    element! {
        View(flex_direction: FlexDirection::Row) {
            Text(content: "[✻]".to_string(), color: theme.claude, wrap: TextWrap::NoWrap)
            Text(content: " ".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap)
            Text(content: "[✻]".to_string(), color: theme.claude, wrap: TextWrap::NoWrap)
            Text(content: " ".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap)
            Text(content: "[✻]".to_string(), color: theme.claude, wrap: TextWrap::NoWrap)
            Text(content: " · ".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap)
            Text(content: copy, color: theme.inactive, wrap: TextWrap::NoWrap)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    fn render_guest(reward_text: Option<&str>) -> String {
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                GuestPassesUpsell(reward_text: reward_text.map(str::to_string))
            }
        }
        .render(Some(120))
        .to_string()
    }

    #[test]
    fn guest_passes_show_gate_matches_official_cache_and_config_rules() {
        let base = GuestPassesUpsellSnapshot {
            eligible: true,
            has_cache: true,
            passes_upsell_seen_count: 0,
            ..GuestPassesUpsellSnapshot::default()
        };
        assert!(should_show_guest_passes_upsell(&base));

        assert!(!should_show_guest_passes_upsell(
            &GuestPassesUpsellSnapshot {
                eligible: false,
                ..base.clone()
            }
        ));
        assert!(!should_show_guest_passes_upsell(
            &GuestPassesUpsellSnapshot {
                has_cache: false,
                ..base.clone()
            }
        ));
        assert!(!should_show_guest_passes_upsell(
            &GuestPassesUpsellSnapshot {
                passes_upsell_seen_count: 3,
                ..base.clone()
            }
        ));
        assert!(!should_show_guest_passes_upsell(
            &GuestPassesUpsellSnapshot {
                has_visited_passes: true,
                ..base.clone()
            }
        ));
    }

    #[test]
    fn guest_passes_refresh_resets_seen_and_visited_gate_without_writing() {
        let snapshot = GuestPassesUpsellSnapshot {
            eligible: true,
            has_cache: true,
            remaining_passes: Some(5),
            passes_last_seen_remaining: 3,
            passes_upsell_seen_count: 3,
            has_visited_passes: true,
        };

        assert!(passes_should_reset(&snapshot));
        assert!(should_show_guest_passes_upsell(&snapshot));
    }

    #[test]
    fn guest_passes_upsell_renders_official_condensed_copy() {
        let text = render_guest(Some("$5"));
        assert!(text.contains("[✻] [✻] [✻]"), "canvas=\n{text}");
        assert!(
            text.contains("Share Claude Code and earn $5 of extra usage · /passes"),
            "canvas=\n{text}"
        );

        let fallback = render_guest(None);
        assert!(
            fallback.contains("3 guest passes at /passes"),
            "canvas=\n{fallback}"
        );
    }
}
