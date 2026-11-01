//! Maps to: CC `hooks/notifs/useInstallMessages.tsx`.
//!
//! Nyan keeps native installer checks out of the main-screen path. This file
//! only maps already-known setup messages to runtime notifications, preserving
//! official keys, priority rules, colors, and visible text without probing the
//! installation or mutating files.

use crate::context::notifications::{Notification, NotificationColor, NotificationPriority};

pub const INSTALL_MESSAGE_KEY_PREFIX: &str = "install-message";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallMessageType {
    Path,
    Alias,
    Info,
    Error,
}

impl InstallMessageType {
    pub fn as_official_str(self) -> &'static str {
        match self {
            Self::Path => "path",
            Self::Alias => "alias",
            Self::Info => "info",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallMessage {
    pub message: String,
    pub user_action_required: bool,
    pub message_type: InstallMessageType,
}

impl InstallMessage {
    pub fn new(
        message: impl Into<String>,
        user_action_required: bool,
        message_type: InstallMessageType,
    ) -> Self {
        Self {
            message: message.into(),
            user_action_required,
            message_type,
        }
    }
}

pub fn install_message_notifications(messages: &[InstallMessage]) -> Vec<Notification> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| install_message_notification(index, message))
        .collect()
}

pub fn install_message_notification(index: usize, message: &InstallMessage) -> Notification {
    let priority =
        if message.message_type == InstallMessageType::Error || message.user_action_required {
            NotificationPriority::High
        } else if matches!(
            message.message_type,
            InstallMessageType::Path | InstallMessageType::Alias
        ) {
            NotificationPriority::Medium
        } else {
            NotificationPriority::Low
        };
    let color = if message.message_type == InstallMessageType::Error {
        NotificationColor::Error
    } else {
        NotificationColor::Warning
    };

    Notification::text(
        format!(
            "{INSTALL_MESSAGE_KEY_PREFIX}-{index}-{}",
            message.message_type.as_official_str()
        ),
        message.message.clone(),
        priority,
    )
    .with_color(color)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_messages_preserve_official_keys_and_order() {
        let messages = vec![
            InstallMessage::new("Add ~/.local/bin to PATH", false, InstallMessageType::Path),
            InstallMessage::new("Remove old alias", false, InstallMessageType::Alias),
        ];

        let notifications = install_message_notifications(&messages);

        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0].key, "install-message-0-path");
        assert_eq!(notifications[0].text, "Add ~/.local/bin to PATH");
        assert_eq!(notifications[1].key, "install-message-1-alias");
        assert_eq!(notifications[1].text, "Remove old alias");
    }

    #[test]
    fn install_messages_match_official_priority_rules() {
        let info = install_message_notification(
            0,
            &InstallMessage::new("FYI", false, InstallMessageType::Info),
        );
        let path = install_message_notification(
            1,
            &InstallMessage::new("PATH needs update", false, InstallMessageType::Path),
        );
        let alias = install_message_notification(
            2,
            &InstallMessage::new("alias changed", false, InstallMessageType::Alias),
        );
        let action_required = install_message_notification(
            3,
            &InstallMessage::new("manual action", true, InstallMessageType::Info),
        );
        let error = install_message_notification(
            4,
            &InstallMessage::new("failed", false, InstallMessageType::Error),
        );

        assert_eq!(info.priority, NotificationPriority::Low);
        assert_eq!(path.priority, NotificationPriority::Medium);
        assert_eq!(alias.priority, NotificationPriority::Medium);
        assert_eq!(action_required.priority, NotificationPriority::High);
        assert_eq!(error.priority, NotificationPriority::High);
    }

    #[test]
    fn install_messages_match_official_color_rules() {
        let warning = install_message_notification(
            0,
            &InstallMessage::new("warning", false, InstallMessageType::Info),
        );
        let error = install_message_notification(
            1,
            &InstallMessage::new("error", false, InstallMessageType::Error),
        );

        assert_eq!(warning.color, Some(NotificationColor::Warning));
        assert_eq!(error.color, Some(NotificationColor::Error));
    }
}
