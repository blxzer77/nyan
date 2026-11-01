//! Maps to: CC `components/PromptInput/IssueFlagBanner.tsx:1-27`.
//!
//! The source is explicitly ANT-only (`"external" !== 'ant'`), so the external
//! Nyan build preserves its dead-code-eliminated null result. No telemetry or
//! `/issue` submission flow is introduced.

use iocraft::prelude::*;

#[component]
pub fn IssueFlagBanner() -> impl Into<AnyElement<'static>> {
    element! { Fragment }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_build_eliminates_ant_only_banner() {
        assert!(
            element! { IssueFlagBanner }
                .render(Some(80))
                .to_string()
                .is_empty()
        );
    }
}
