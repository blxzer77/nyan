//! Maps to: CC `hooks/notifs/usePluginAutoupdateNotification.tsx` and
//! `hooks/notifs/usePluginInstallationStatus.tsx`.
//!
//! Nyan does not have a live plugin state store yet, so these are pure
//! main-screen notification producers. They flatten official JSX notifications
//! into visible text while preserving keys, priorities, timeouts, and copy.

use crate::context::notifications::{
    Notification, NotificationColor, NotificationPriority, NotificationSegment,
};

pub const PLUGIN_AUTOUPDATE_RESTART_KEY: &str = "plugin-autoupdate-restart";
pub const PLUGIN_AUTOUPDATE_RESTART_TIMEOUT_MS: u64 = 10_000;
pub const PLUGIN_INSTALL_FAILED_KEY: &str = "plugin-install-failed";

pub fn plugin_autoupdate_notification(
    updated_plugin_ids: &[impl AsRef<str>],
) -> Option<Notification> {
    if updated_plugin_ids.is_empty() {
        return None;
    }

    let plugin_names = updated_plugin_ids
        .iter()
        .map(|id| plugin_display_name(id.as_ref()))
        .collect::<Vec<_>>();
    let display_names = if plugin_names.len() <= 2 {
        plugin_names.join(" and ")
    } else {
        format!("{} plugins", plugin_names.len())
    };
    let subject = if plugin_names.len() == 1 {
        "Plugin"
    } else {
        "Plugins"
    };

    let heading = format!("{subject} updated: {display_names}");
    let suffix = " · Run /reload-plugins to apply";
    Some(
        Notification::text(
            PLUGIN_AUTOUPDATE_RESTART_KEY,
            format!("{heading}{suffix}"),
            NotificationPriority::Low,
        )
        .with_segments(vec![
            NotificationSegment::text(heading).with_color(NotificationColor::Success),
            NotificationSegment::text(suffix).with_dim(true),
        ])
        .with_timeout_ms(PLUGIN_AUTOUPDATE_RESTART_TIMEOUT_MS),
    )
}

pub fn plugin_install_failed_notification(
    failed_marketplaces_count: usize,
    failed_plugins_count: usize,
) -> Option<Notification> {
    let total_failed = failed_marketplaces_count + failed_plugins_count;
    if total_failed == 0 {
        return None;
    }

    let plugin_word = if total_failed == 1 {
        "plugin"
    } else {
        "plugins"
    };
    let heading = format!("{total_failed} {plugin_word} failed to install");
    let suffix = " · /plugin for details";
    Some(
        Notification::text(
            PLUGIN_INSTALL_FAILED_KEY,
            format!("{heading}{suffix}"),
            NotificationPriority::Medium,
        )
        .with_segments(vec![
            NotificationSegment::text(heading).with_color(NotificationColor::Error),
            NotificationSegment::text(suffix).with_dim(true),
        ]),
    )
}

fn plugin_display_name(plugin_id: &str) -> String {
    match plugin_id.find('@') {
        Some(index) if index > 0 => plugin_id[..index].to_string(),
        _ => plugin_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_autoupdate_notification_matches_single_plugin_copy() {
        let ids = vec!["formatter@marketplace"];
        let notification = plugin_autoupdate_notification(&ids).expect("one plugin should notify");

        assert_eq!(notification.key, PLUGIN_AUTOUPDATE_RESTART_KEY);
        assert_eq!(
            notification.text,
            "Plugin updated: formatter · Run /reload-plugins to apply"
        );
        assert_eq!(notification.color, None);
        assert_eq!(notification.segments.len(), 2);
        assert_eq!(
            notification.segments[0].color,
            Some(NotificationColor::Success)
        );
        assert!(!notification.segments[0].dim);
        assert_eq!(notification.segments[1].color, None);
        assert!(notification.segments[1].dim);
        assert_eq!(notification.priority, NotificationPriority::Low);
        assert_eq!(
            notification.timeout_ms,
            Some(PLUGIN_AUTOUPDATE_RESTART_TIMEOUT_MS)
        );
    }

    #[test]
    fn plugin_autoupdate_notification_matches_two_plugin_join_copy() {
        let ids = vec!["formatter@marketplace", "linter@marketplace"];
        let notification = plugin_autoupdate_notification(&ids).expect("two plugins should notify");

        assert_eq!(
            notification.text,
            "Plugins updated: formatter and linter · Run /reload-plugins to apply"
        );
    }

    #[test]
    fn plugin_autoupdate_notification_matches_many_plugin_summary_copy() {
        let ids = vec!["a@marketplace", "b@marketplace", "c@marketplace"];
        let notification =
            plugin_autoupdate_notification(&ids).expect("many plugins should notify");

        assert_eq!(
            notification.text,
            "Plugins updated: 3 plugins · Run /reload-plugins to apply"
        );
    }

    #[test]
    fn plugin_autoupdate_notification_preserves_at_prefix_ids_like_official() {
        let ids = vec!["@scoped/plugin@marketplace"];
        let notification =
            plugin_autoupdate_notification(&ids).expect("scoped plugin should notify");

        assert_eq!(
            notification.text,
            "Plugin updated: @scoped/plugin@marketplace · Run /reload-plugins to apply"
        );
    }

    #[test]
    fn plugin_autoupdate_notification_is_suppressed_without_plugins() {
        let ids: Vec<&str> = Vec::new();
        assert!(plugin_autoupdate_notification(&ids).is_none());
    }

    #[test]
    fn plugin_install_failed_notification_matches_official_copy() {
        let notification =
            plugin_install_failed_notification(1, 2).expect("failed installs should notify");

        assert_eq!(notification.key, PLUGIN_INSTALL_FAILED_KEY);
        assert_eq!(
            notification.text,
            "3 plugins failed to install · /plugin for details"
        );
        assert_eq!(notification.color, None);
        assert_eq!(notification.segments.len(), 2);
        assert_eq!(
            notification.segments[0].color,
            Some(NotificationColor::Error)
        );
        assert!(!notification.segments[0].dim);
        assert_eq!(notification.segments[1].color, None);
        assert!(notification.segments[1].dim);
        assert_eq!(notification.priority, NotificationPriority::Medium);
    }

    #[test]
    fn plugin_install_failed_notification_uses_singular_copy() {
        let notification =
            plugin_install_failed_notification(0, 1).expect("one failed plugin should notify");

        assert_eq!(
            notification.text,
            "1 plugin failed to install · /plugin for details"
        );
    }

    #[test]
    fn plugin_install_failed_notification_is_suppressed_without_failures() {
        assert!(plugin_install_failed_notification(0, 0).is_none());
    }
}
