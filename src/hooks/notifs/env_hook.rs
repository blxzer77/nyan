//! Maps to the PromptInput env-hook notifier registered in
//! `components/PromptInput/Notifications.tsx`.
//!
//! Official Claude Code lets cwd/file-change hook feedback enqueue an `env-hook`
//! footer notification. Nyan keeps this as a pure payload constructor over
//! already-known hook feedback; it does not register file watchers, run hooks, or
//! write settings/session data.

#![allow(dead_code)]

use crate::context::notifications::{Notification, NotificationColor, NotificationPriority};

pub const ENV_HOOK_NOTIFICATION_KEY: &str = "env-hook";
pub const ENV_HOOK_SUCCESS_TIMEOUT_MS: u64 = 5_000;
pub const ENV_HOOK_ERROR_TIMEOUT_MS: u64 = 8_000;

pub fn env_hook_notification(text: impl Into<String>, is_error: bool) -> Notification {
    let mut notification = Notification::text(
        ENV_HOOK_NOTIFICATION_KEY,
        text.into(),
        if is_error {
            NotificationPriority::Medium
        } else {
            NotificationPriority::Low
        },
    )
    .with_timeout_ms(if is_error {
        ENV_HOOK_ERROR_TIMEOUT_MS
    } else {
        ENV_HOOK_SUCCESS_TIMEOUT_MS
    });

    if is_error {
        notification = notification.with_color(NotificationColor::Error);
    }

    notification
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_hook_success_notification_matches_official_footer_payload() {
        let notification = env_hook_notification("CwdChanged hook ran", false);

        assert_eq!(notification.key, ENV_HOOK_NOTIFICATION_KEY);
        assert_eq!(notification.text, "CwdChanged hook ran");
        assert_eq!(notification.priority, NotificationPriority::Low);
        assert_eq!(notification.timeout_ms, Some(ENV_HOOK_SUCCESS_TIMEOUT_MS));
        assert!(notification.color.is_none());
    }

    #[test]
    fn env_hook_error_notification_matches_official_footer_payload() {
        let notification = env_hook_notification("FileChanged hook failed", true);

        assert_eq!(notification.key, ENV_HOOK_NOTIFICATION_KEY);
        assert_eq!(notification.text, "FileChanged hook failed");
        assert_eq!(notification.priority, NotificationPriority::Medium);
        assert_eq!(notification.timeout_ms, Some(ENV_HOOK_ERROR_TIMEOUT_MS));
        assert_eq!(notification.color, Some(NotificationColor::Error));
    }
}
