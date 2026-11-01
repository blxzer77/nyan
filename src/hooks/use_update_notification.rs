//! Maps to: CC `hooks/useUpdateNotification.ts`.
//!
//! Per-instance `lastNotifiedSemver` state seeded from the running version.
//! Each updater child calls this hook with its latest `autoUpdaterResult`
//! version; the hook records each newly seen update semver. As executed by
//! React, the committed return value is always `null` (see
//! [`use_update_notification`]), so the "✓ Update installed" copy it gates
//! never commits in CC either — Nyan reproduces that committed output.

use iocraft::prelude::*;

/// Maps to: CC `useUpdateNotification.ts:4-6` `getSemverPart` (loose semver
/// major.minor.patch). CC's `semver` throws on unparseable input; Nyan
/// returns the input unchanged so the comparison stays total.
pub fn get_semver_part(version: &str) -> String {
    match crate::utils::auto_updater::parse_triplet(version) {
        Some([major, minor, patch]) => format!("{major}.{minor}.{patch}"),
        None => version.to_string(),
    }
}

/// Maps to: CC `useUpdateNotification.ts:8-14` `shouldShowUpdateNotification`.
pub fn should_show_update_notification(
    updated_version: &str,
    last_notified_semver: Option<&str>,
) -> bool {
    let updated_semver = get_semver_part(updated_version);
    Some(updated_semver.as_str()) != last_notified_semver
}

/// Maps to: CC `useUpdateNotification.ts:16-33` `useUpdateNotification`
/// (initialVersion defaulted to `MACRO.VERSION`).
///
/// Committed-null parity (slice-3b decision): CC sets state during render and
/// returns the semver from that pass, but React discards a pass that set
/// state mid-render and immediately re-runs it — the re-run takes the
/// equal-semver branch and returns `null`, so CC's *committed* output is
/// always `null` (both reviews verified the "✓ Update installed" copy never
/// commits through this gate). iocraft has no render restart, so the 3a port
/// committed the `Some` for one frame; this now applies the state update and
/// returns `None` directly, reproducing CC-as-executed committed output
/// exactly. The `Option` return is kept for CC signature parity.
pub fn use_update_notification(hooks: &mut Hooks, updated_version: Option<&str>) -> Option<String> {
    let mut last_notified_semver = hooks.use_state(|| get_semver_part(env!("CARGO_PKG_VERSION")));

    let updated_version = updated_version?;
    let updated_semver = get_semver_part(updated_version);
    if *last_notified_semver.read() != updated_semver {
        last_notified_semver.set(updated_semver);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_semver_part_strips_prerelease_and_build_like_official_loose_parse() {
        assert_eq!(get_semver_part("1.2.3"), "1.2.3");
        assert_eq!(get_semver_part("1.2.3-beta.1"), "1.2.3");
        assert_eq!(get_semver_part("1.2.3+sha"), "1.2.3");
        // CC throws here; Nyan documented deviation returns input unchanged.
        assert_eq!(get_semver_part("not-a-version"), "not-a-version");
    }

    #[test]
    fn should_show_update_notification_matches_official_semver_compare() {
        assert!(should_show_update_notification("1.2.3", None));
        assert!(should_show_update_notification("1.2.4", Some("1.2.3")));
        assert!(!should_show_update_notification("1.2.3", Some("1.2.3")));
        assert!(!should_show_update_notification("1.2.3+sha", Some("1.2.3")));
    }
}
