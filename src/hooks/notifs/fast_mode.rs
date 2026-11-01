//! Maps to: CC `hooks/notifs/useFastModeNotification.tsx`.
//!
//! These helpers model official notification payloads for fast-mode runtime
//! events while leaving the live event sources and settings writes out of the
//! main-screen-safe Nyan path.

use crate::context::notifications::{Notification, NotificationColor, NotificationPriority};

pub const FAST_MODE_COOLDOWN_STARTED_KEY: &str = "fast-mode-cooldown-started";
pub const FAST_MODE_COOLDOWN_EXPIRED_KEY: &str = "fast-mode-cooldown-expired";
pub const FAST_MODE_ORG_CHANGED_KEY: &str = "fast-mode-org-changed";
pub const FAST_MODE_OVERAGE_REJECTED_KEY: &str = "fast-mode-overage-rejected";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FastModeCooldownReason {
    Overloaded,
    RateLimit,
}

pub fn format_duration_hide_trailing_zeros(ms: i64) -> String {
    if ms < 60_000 {
        if ms == 0 {
            return "0s".to_string();
        }
        if ms < 1 {
            return "0.0s".to_string();
        }
        return format!("{}s", ms / 1000);
    }

    let mut days = ms / 86_400_000;
    let mut hours = (ms % 86_400_000) / 3_600_000;
    let mut minutes = (ms % 3_600_000) / 60_000;
    let mut seconds = ((ms % 60_000) + 500) / 1000;

    if seconds == 60 {
        seconds = 0;
        minutes += 1;
    }
    if minutes == 60 {
        minutes = 0;
        hours += 1;
    }
    if hours == 24 {
        hours = 0;
        days += 1;
    }

    if days > 0 {
        if hours == 0 && minutes == 0 {
            return format!("{days}d");
        }
        if minutes == 0 {
            return format!("{days}d {hours}h");
        }
        return format!("{days}d {hours}h {minutes}m");
    }
    if hours > 0 {
        if minutes == 0 && seconds == 0 {
            return format!("{hours}h");
        }
        if seconds == 0 {
            return format!("{hours}h {minutes}m");
        }
        return format!("{hours}h {minutes}m {seconds}s");
    }
    if minutes > 0 {
        if seconds == 0 {
            return format!("{minutes}m");
        }
        return format!("{minutes}m {seconds}s");
    }
    format!("{seconds}s")
}

pub fn fast_mode_cooldown_message(reason: FastModeCooldownReason, reset_in: &str) -> String {
    match reason {
        FastModeCooldownReason::Overloaded => {
            format!("Fast mode overloaded and is temporarily unavailable · resets in {reset_in}")
        }
        FastModeCooldownReason::RateLimit => {
            format!("Fast limit reached and temporarily disabled · resets in {reset_in}")
        }
    }
}

pub fn fast_mode_cooldown_started_notification(
    reason: FastModeCooldownReason,
    reset_in_ms: i64,
) -> Notification {
    Notification::text(
        FAST_MODE_COOLDOWN_STARTED_KEY,
        fast_mode_cooldown_message(reason, &format_duration_hide_trailing_zeros(reset_in_ms)),
        NotificationPriority::Immediate,
    )
    .with_color(NotificationColor::Warning)
    .with_invalidates([FAST_MODE_COOLDOWN_EXPIRED_KEY.to_string()])
}

pub fn fast_mode_cooldown_expired_notification() -> Notification {
    Notification::text(
        FAST_MODE_COOLDOWN_EXPIRED_KEY,
        "Fast limit reset · now using fast mode",
        NotificationPriority::Immediate,
    )
    .with_color(NotificationColor::FastMode)
    .with_invalidates([FAST_MODE_COOLDOWN_STARTED_KEY.to_string()])
}

pub fn fast_mode_org_changed_notification(
    org_enabled: bool,
    currently_using_fast_mode: bool,
) -> Option<Notification> {
    if org_enabled {
        return Some(
            Notification::text(
                FAST_MODE_ORG_CHANGED_KEY,
                "Fast mode is now available · /fast to turn on",
                NotificationPriority::Immediate,
            )
            .with_color(NotificationColor::FastMode),
        );
    }

    if !currently_using_fast_mode {
        return None;
    }

    Some(
        Notification::text(
            FAST_MODE_ORG_CHANGED_KEY,
            "Fast mode has been disabled by your organization",
            NotificationPriority::Immediate,
        )
        .with_color(NotificationColor::Warning),
    )
}

pub fn fast_mode_overage_rejected_notification(message: impl Into<String>) -> Notification {
    Notification::text(
        FAST_MODE_OVERAGE_REJECTED_KEY,
        message.into(),
        NotificationPriority::Immediate,
    )
    .with_color(NotificationColor::Warning)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_mode_cooldown_started_matches_official_text_color_priority_and_invalidates() {
        let notification =
            fast_mode_cooldown_started_notification(FastModeCooldownReason::RateLimit, 3_600_000);

        assert_eq!(notification.key, FAST_MODE_COOLDOWN_STARTED_KEY);
        assert_eq!(
            notification.text,
            "Fast limit reached and temporarily disabled · resets in 1h"
        );
        assert_eq!(notification.color, Some(NotificationColor::Warning));
        assert_eq!(notification.priority, NotificationPriority::Immediate);
        assert_eq!(
            notification.invalidates,
            vec![FAST_MODE_COOLDOWN_EXPIRED_KEY.to_string()]
        );
    }

    #[test]
    fn fast_mode_cooldown_overloaded_message_matches_official_copy() {
        let notification =
            fast_mode_cooldown_started_notification(FastModeCooldownReason::Overloaded, 90_000);

        assert_eq!(
            notification.text,
            "Fast mode overloaded and is temporarily unavailable · resets in 1m 30s"
        );
    }

    #[test]
    fn fast_mode_cooldown_expired_matches_official_payload() {
        let notification = fast_mode_cooldown_expired_notification();

        assert_eq!(notification.key, FAST_MODE_COOLDOWN_EXPIRED_KEY);
        assert_eq!(notification.text, "Fast limit reset · now using fast mode");
        assert_eq!(notification.color, Some(NotificationColor::FastMode));
        assert_eq!(notification.priority, NotificationPriority::Immediate);
        assert_eq!(
            notification.invalidates,
            vec![FAST_MODE_COOLDOWN_STARTED_KEY.to_string()]
        );
    }

    #[test]
    fn fast_mode_org_changed_matches_official_payloads() {
        let enabled = fast_mode_org_changed_notification(true, false).expect("enabled should show");
        assert_eq!(enabled.key, FAST_MODE_ORG_CHANGED_KEY);
        assert_eq!(
            enabled.text,
            "Fast mode is now available · /fast to turn on"
        );
        assert_eq!(enabled.color, Some(NotificationColor::FastMode));

        let disabled =
            fast_mode_org_changed_notification(false, true).expect("active fast mode should warn");
        assert_eq!(disabled.key, FAST_MODE_ORG_CHANGED_KEY);
        assert_eq!(
            disabled.text,
            "Fast mode has been disabled by your organization"
        );
        assert_eq!(disabled.color, Some(NotificationColor::Warning));

        assert!(fast_mode_org_changed_notification(false, false).is_none());
    }

    #[test]
    fn fast_mode_overage_rejected_preserves_official_event_message() {
        let notification = fast_mode_overage_rejected_notification(
            "Fast mode requires extra usage billing · /extra-usage to enable",
        );

        assert_eq!(notification.key, FAST_MODE_OVERAGE_REJECTED_KEY);
        assert_eq!(
            notification.text,
            "Fast mode requires extra usage billing · /extra-usage to enable"
        );
        assert_eq!(notification.color, Some(NotificationColor::Warning));
        assert_eq!(notification.priority, NotificationPriority::Immediate);
    }

    #[test]
    fn format_duration_hide_trailing_zeros_matches_needed_official_cases() {
        assert_eq!(format_duration_hide_trailing_zeros(0), "0s");
        assert_eq!(format_duration_hide_trailing_zeros(59_000), "59s");
        assert_eq!(format_duration_hide_trailing_zeros(60_000), "1m");
        assert_eq!(format_duration_hide_trailing_zeros(90_000), "1m 30s");
        assert_eq!(format_duration_hide_trailing_zeros(3_600_000), "1h");
        assert_eq!(format_duration_hide_trailing_zeros(3_660_000), "1h 1m");
    }
}
