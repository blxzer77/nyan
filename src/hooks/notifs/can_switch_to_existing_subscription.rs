//! Maps to: CC `hooks/notifs/useCanSwitchToExistingSubscription.tsx`.
//!
//! The official hook checks OAuth/profile state, increments a global config
//! counter, and logs analytics. Nyan models only the visible notification
//! from already-known state so the main-screen path stays UI-only and readonly.

use crate::context::notifications::{
    Notification, NotificationColor, NotificationPriority, NotificationSegment,
};

pub const SWITCH_TO_SUBSCRIPTION_KEY: &str = "switch-to-subscription";
pub const MAX_SWITCH_TO_SUBSCRIPTION_NOTICE_COUNT: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeSubscriptionPlan {
    Max,
    Pro,
}

impl ClaudeSubscriptionPlan {
    pub fn display_label(self) -> &'static str {
        match self {
            Self::Max => "Max",
            Self::Pro => "Pro",
        }
    }
}

pub fn switch_to_subscription_notification(
    subscription_type: ClaudeSubscriptionPlan,
) -> Notification {
    let heading = format!(
        "Use your existing Claude {} plan with nyan",
        subscription_type.display_label()
    );
    let suffix = " · /login to activate";

    Notification::text(
        SWITCH_TO_SUBSCRIPTION_KEY,
        format!("{heading}{suffix}"),
        NotificationPriority::Low,
    )
    .with_segments(vec![
        NotificationSegment::text(heading).with_color(NotificationColor::Suggestion),
        NotificationSegment::text(suffix)
            .with_color(NotificationColor::Text)
            .with_dim(true),
    ])
}

pub fn switch_to_subscription_notification_from_state(
    subscription_notice_count: u32,
    is_claude_ai_subscriber: bool,
    existing_subscription: Option<ClaudeSubscriptionPlan>,
) -> Option<Notification> {
    if subscription_notice_count >= MAX_SWITCH_TO_SUBSCRIPTION_NOTICE_COUNT
        || is_claude_ai_subscriber
    {
        return None;
    }

    existing_subscription.map(switch_to_subscription_notification)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_to_subscription_notification_matches_official_max_copy() {
        let notification = switch_to_subscription_notification(ClaudeSubscriptionPlan::Max);

        assert_eq!(notification.key, SWITCH_TO_SUBSCRIPTION_KEY);
        assert_eq!(notification.priority, NotificationPriority::Low);
        assert_eq!(
            notification.text,
            "Use your existing Claude Max plan with nyan · /login to activate"
        );
        assert_eq!(notification.segments.len(), 2);
        assert_eq!(
            notification.segments[0].text,
            "Use your existing Claude Max plan with nyan"
        );
        assert_eq!(
            notification.segments[0].color,
            Some(NotificationColor::Suggestion)
        );
        assert_eq!(notification.segments[1].text, " · /login to activate");
        assert_eq!(
            notification.segments[1].color,
            Some(NotificationColor::Text)
        );
        assert!(notification.segments[1].dim);
    }

    #[test]
    fn switch_to_subscription_notification_matches_official_pro_copy() {
        let notification = switch_to_subscription_notification(ClaudeSubscriptionPlan::Pro);

        assert_eq!(
            notification.text,
            "Use your existing Claude Pro plan with nyan · /login to activate"
        );
    }

    #[test]
    fn switch_to_subscription_state_gate_is_readonly_and_official_shaped() {
        assert!(
            switch_to_subscription_notification_from_state(
                0,
                false,
                Some(ClaudeSubscriptionPlan::Pro)
            )
            .is_some()
        );
        assert!(
            switch_to_subscription_notification_from_state(
                MAX_SWITCH_TO_SUBSCRIPTION_NOTICE_COUNT,
                false,
                Some(ClaudeSubscriptionPlan::Pro)
            )
            .is_none()
        );
        assert!(
            switch_to_subscription_notification_from_state(
                0,
                true,
                Some(ClaudeSubscriptionPlan::Pro)
            )
            .is_none()
        );
        assert!(switch_to_subscription_notification_from_state(0, false, None).is_none());
    }
}
