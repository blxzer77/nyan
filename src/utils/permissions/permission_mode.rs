//! Permission mode helpers.
//! Maps to: CC `utils/permissions/PermissionMode.ts`.

use crate::types::permissions::PermissionMode;

/// Re-export for backward compatibility, matching CC
/// `utils/permissions/PermissionMode.ts`.
pub use crate::types::permissions::{EXTERNAL_PERMISSION_MODES, PERMISSION_MODES};

/// Maps to: CC `PermissionMode.ts:4` `permissionModeSchema` —
/// `z.enum(PERMISSION_MODES)`.
///
/// CC's `PERMISSION_MODES` is itself gated (`types/permissions.ts:33-38`):
/// `'auto'` joins the set only under `feature('TRANSCRIPT_CLASSIFIER')`. The
/// Rust constant above hardcodes `'auto'` instead — a separate deviation that
/// also reaches settings/CLI validation — so the gate is applied here, where
/// the model-visible enum is produced.
pub fn permission_mode_schema() -> &'static crate::utils::zod::Schema {
    static SCHEMA: std::sync::LazyLock<crate::utils::zod::Schema> =
        std::sync::LazyLock::new(|| {
            let mut modes = EXTERNAL_PERMISSION_MODES.to_vec();
            if crate::utils::feature_flags::feature_enabled(
                crate::utils::feature_flags::FeatureFlag::TranscriptClassifier,
            ) {
                modes.push("auto");
            }
            crate::utils::zod::enumeration(modes)
        });
    &SCHEMA
}

/// Maps to: CC `PermissionMode.ts:22-24` `externalPermissionModeSchema` —
/// `z.enum(EXTERNAL_PERMISSION_MODES)` (no auto gate; this is the
/// user-addressable external set).
pub fn external_permission_mode_schema() -> &'static crate::utils::zod::Schema {
    static SCHEMA: std::sync::OnceLock<crate::utils::zod::Schema> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| crate::utils::zod::enumeration(EXTERNAL_PERMISSION_MODES.to_vec()))
}

/// Maps to CC `ModeColorKey` in `PermissionMode.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionModeColor {
    Text,
    Plan,
    AutoAccept,
    Error,
    /// Auto classifier mode (internal).
    Auto,
}

/// Maps to CC `toExternalPermissionMode(...)`.
/// Internal `auto` and `bubble` are not external modes; both resolve through
/// the `getModeConfig` default fallback to `default` for external surfaces.
pub fn to_external_permission_mode(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default | PermissionMode::Auto | PermissionMode::Bubble => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Plan => "plan",
        PermissionMode::DontAsk => "dontAsk",
        PermissionMode::BypassPermissions => "bypassPermissions",
    }
}

/// Internal mode string used by transition/attachment helpers.
/// Maps to CC permission mode string union including `'auto'`.
/// Do **not** use `to_external_permission_mode` for transitions — that collapses
/// Auto → default and breaks `handleAutoModeTransition` / `fromUsesClassifier`.
pub fn permission_mode_internal_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Plan => "plan",
        PermissionMode::DontAsk => "dontAsk",
        PermissionMode::BypassPermissions => "bypassPermissions",
        PermissionMode::Auto => "auto",
        PermissionMode::Bubble => "bubble",
    }
}

/// Maps to CC `permissionModeFromString(...)` (internal, accepts auto).
pub fn permission_mode_from_string(value: &str) -> PermissionMode {
    match value {
        "default" => PermissionMode::Default,
        "acceptEdits" => PermissionMode::AcceptEdits,
        "plan" => PermissionMode::Plan,
        "dontAsk" => PermissionMode::DontAsk,
        "bypassPermissions" => PermissionMode::BypassPermissions,
        "auto" => PermissionMode::Auto,
        // `bubble` is outside CC `PERMISSION_MODES`, so it parses to `default`
        // like any unknown string.
        _ => PermissionMode::Default,
    }
}

/// Strict external parser for schema/update call sites.
/// Maps to CC `externalPermissionModeSchema` (no auto).
pub fn external_permission_mode_from_string(value: &str) -> Option<PermissionMode> {
    match value {
        "default" => Some(PermissionMode::Default),
        "acceptEdits" => Some(PermissionMode::AcceptEdits),
        "plan" => Some(PermissionMode::Plan),
        "dontAsk" => Some(PermissionMode::DontAsk),
        "bypassPermissions" => Some(PermissionMode::BypassPermissions),
        _ => None,
    }
}

/// Maps to CC `permissionModeTitle(...)`.
///
/// `bubble` has no `PERMISSION_MODE_CONFIG` entry, so CC `getModeConfig`
/// serves the `default` config for it — same for the short title, symbol and
/// color below.
pub fn permission_mode_title(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default | PermissionMode::Bubble => "Default",
        PermissionMode::AcceptEdits => "Accept edits",
        PermissionMode::Plan => "Plan Mode",
        PermissionMode::DontAsk => "Don't Ask",
        PermissionMode::BypassPermissions => "Bypass Permissions",
        PermissionMode::Auto => "Auto mode",
    }
}

/// Maps to CC `permissionModeShortTitle(...)`.
pub fn permission_mode_short_title(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default | PermissionMode::Bubble => "Default",
        PermissionMode::AcceptEdits => "Accept",
        PermissionMode::Plan => "Plan",
        PermissionMode::DontAsk => "DontAsk",
        PermissionMode::BypassPermissions => "Bypass",
        PermissionMode::Auto => "Auto",
    }
}

/// Footer display copy used by Nyan prompt UI.
pub fn permission_mode_display_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default | PermissionMode::Bubble => "manual mode",
        PermissionMode::AcceptEdits => "accept edits",
        PermissionMode::Plan => "plan mode",
        PermissionMode::DontAsk => "don't ask",
        PermissionMode::BypassPermissions => "bypass permissions",
        PermissionMode::Auto => "auto mode",
    }
}

/// Maps to CC `permissionModeSymbol(...)`.
///
/// CC `PermissionMode.ts` auto config uses the same `⏵⏵` symbol as acceptEdits /
/// bypass / dontAsk (only plan uses PAUSE_ICON ⏸). Color differs (warning vs
/// autoAccept) — symbol does not invent a separate glyph.
pub fn permission_mode_symbol(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default | PermissionMode::Plan | PermissionMode::Bubble => "⏸",
        PermissionMode::AcceptEdits
        | PermissionMode::DontAsk
        | PermissionMode::BypassPermissions
        | PermissionMode::Auto => "⏵⏵",
    }
}

/// Maps to CC `getModeColor(...)`.
pub fn get_mode_color(mode: PermissionMode) -> PermissionModeColor {
    match mode {
        PermissionMode::Default | PermissionMode::Bubble => PermissionModeColor::Text,
        PermissionMode::Plan => PermissionModeColor::Plan,
        PermissionMode::AcceptEdits => PermissionModeColor::AutoAccept,
        PermissionMode::Auto => PermissionModeColor::Auto,
        PermissionMode::DontAsk | PermissionMode::BypassPermissions => PermissionModeColor::Error,
    }
}

/// Maps to CC `isDefaultMode(...)`.
pub fn is_default_mode(mode: PermissionMode) -> bool {
    mode == PermissionMode::Default
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mode_helpers_match_official_external_config_subset() {
        assert_eq!(
            EXTERNAL_PERMISSION_MODES,
            &[
                "acceptEdits",
                "bypassPermissions",
                "default",
                "dontAsk",
                "plan"
            ]
        );
        assert!(PERMISSION_MODES.contains(&"auto"));
        assert_eq!(
            to_external_permission_mode(PermissionMode::AcceptEdits),
            "acceptEdits"
        );
        assert_eq!(
            permission_mode_from_string("unknown"),
            PermissionMode::Default
        );
        assert_eq!(permission_mode_from_string("auto"), PermissionMode::Auto);
        assert_eq!(
            external_permission_mode_from_string("dontAsk"),
            Some(PermissionMode::DontAsk)
        );
        assert_eq!(
            external_permission_mode_from_string("auto"),
            None,
            "auto is internal-only"
        );
        assert_eq!(permission_mode_title(PermissionMode::Plan), "Plan Mode");
        assert_eq!(permission_mode_title(PermissionMode::Auto), "Auto mode");
        assert_eq!(
            permission_mode_short_title(PermissionMode::BypassPermissions),
            "Bypass"
        );
        assert_eq!(permission_mode_symbol(PermissionMode::Plan), "⏸");
        assert_eq!(
            get_mode_color(PermissionMode::AcceptEdits),
            PermissionModeColor::AutoAccept
        );
        assert!(is_default_mode(PermissionMode::Default));
    }

    /// CC `types/permissions.ts:28-38` keeps `bubble` in the `PermissionMode`
    /// union but out of `PERMISSION_MODES`, and `PermissionMode.ts:107-108`
    /// serves it the `default` config because it has no entry of its own.
    #[test]
    fn bubble_is_internal_only_and_falls_back_to_the_default_mode_config() {
        assert!(!PERMISSION_MODES.contains(&"bubble"));
        assert_eq!(
            permission_mode_from_string("bubble"),
            PermissionMode::Default,
            "bubble is not user-addressable"
        );
        assert_eq!(external_permission_mode_from_string("bubble"), None);
        assert_eq!(
            permission_mode_internal_name(PermissionMode::Bubble),
            "bubble"
        );
        assert_eq!(
            to_external_permission_mode(PermissionMode::Bubble),
            "default"
        );
        assert_eq!(permission_mode_title(PermissionMode::Bubble), "Default");
        assert_eq!(
            permission_mode_short_title(PermissionMode::Bubble),
            "Default"
        );
        assert_eq!(
            get_mode_color(PermissionMode::Bubble),
            PermissionModeColor::Text
        );
        assert!(
            !is_default_mode(PermissionMode::Bubble),
            "CC isDefaultMode only accepts 'default' / undefined"
        );
    }
}
