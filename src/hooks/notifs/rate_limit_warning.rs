//! Maps to: CC `hooks/notifs/useRateLimitWarningNotification.tsx`.
//!
//! Nyan keeps the limit-fetching/auth pieces out of this file. Callers pass
//! already-computed strings from a read-only status seam; this module preserves
//! the official notification payloads and duplicate suppression rules.

use crate::context::notifications::{
    Notification, NotificationColor, NotificationPriority, NotificationSegment,
};

pub const RATE_LIMIT_WARNING_NOTIFICATION_KEY: &str = "rate-limit-warning";
pub const LIMIT_REACHED_NOTIFICATION_KEY: &str = "limit-reached";

pub fn rate_limit_warning_notification(
    rate_limit_warning: Option<&str>,
    shown_warning: Option<&str>,
) -> Option<Notification> {
    let warning = rate_limit_warning?;
    if Some(warning) == shown_warning {
        return None;
    }

    Some(
        Notification::text(
            RATE_LIMIT_WARNING_NOTIFICATION_KEY,
            warning,
            NotificationPriority::High,
        )
        .with_segments(vec![
            NotificationSegment::text(warning).with_color(NotificationColor::Warning),
        ]),
    )
}

pub fn overage_mode_notification(
    is_using_overage: bool,
    has_shown_overage_notification: bool,
    is_team_or_enterprise: bool,
    has_billing_access: bool,
    using_overage_text: impl Into<String>,
) -> Option<Notification> {
    if !is_using_overage || has_shown_overage_notification {
        return None;
    }
    if is_team_or_enterprise && !has_billing_access {
        return None;
    }

    Some(Notification::text(
        LIMIT_REACHED_NOTIFICATION_KEY,
        using_overage_text,
        NotificationPriority::Immediate,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_warning_notification_matches_official_key_jsx_color_and_priority() {
        let notification =
            rate_limit_warning_notification(Some("You've used 80% of your weekly limit"), None)
                .expect("new warning should notify");

        assert_eq!(notification.key, RATE_LIMIT_WARNING_NOTIFICATION_KEY);
        assert_eq!(notification.text, "You've used 80% of your weekly limit");
        assert_eq!(notification.priority, NotificationPriority::High);
        assert_eq!(notification.color, None);
        assert_eq!(notification.segments.len(), 1);
        assert_eq!(notification.segments[0].text, notification.text);
        assert_eq!(
            notification.segments[0].color,
            Some(NotificationColor::Warning)
        );
    }

    #[test]
    fn rate_limit_warning_notification_suppresses_repeated_warning() {
        assert!(
            rate_limit_warning_notification(
                Some("You've used 80% of your weekly limit"),
                Some("You've used 80% of your weekly limit"),
            )
            .is_none()
        );
        assert!(rate_limit_warning_notification(None, None).is_none());
    }

    #[test]
    fn overage_mode_notification_matches_official_payload_and_gates() {
        let notification =
            overage_mode_notification(true, false, false, false, "You're now using extra usage")
                .expect("overage should notify");

        assert_eq!(notification.key, LIMIT_REACHED_NOTIFICATION_KEY);
        assert_eq!(notification.text, "You're now using extra usage");
        assert_eq!(notification.priority, NotificationPriority::Immediate);
        assert_eq!(notification.color, None);

        assert!(overage_mode_notification(true, true, false, false, "repeat").is_none());
        assert!(overage_mode_notification(false, false, false, false, "not using").is_none());
        assert!(overage_mode_notification(true, false, true, false, "team hidden").is_none());
        assert!(overage_mode_notification(true, false, true, true, "team visible").is_some());
    }
}
