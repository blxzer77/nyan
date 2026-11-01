//! Maps to: CC `utils/preflightChecks.tsx`:1-158.
//!
//! The official module performs network checks against Anthropic/OAuth
//! endpoints and exits the process on failure. Nyan keeps this slice
//! render-only: callers pass an already-known result, and this module never
//! performs network I/O, process exit, analytics, or logging side effects.

use crate::utils::theme::Theme;
use iocraft::prelude::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PreflightCheckResult {
    pub success: bool,
    pub error: Option<String>,
    pub ssl_hint: Option<String>,
}

/// Maps to: CC `utils/preflightChecks.tsx`:85-158 `PreflightStep(...)`.
#[derive(Default, Props)]
pub struct PreflightStepProps {
    pub result: Option<PreflightCheckResult>,
    pub is_checking: bool,
    pub show_spinner: bool,
}

#[component]
pub fn PreflightStep(props: &PreflightStepProps, hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = *hooks.use_context::<Theme>();
    let result = props.result.clone();
    let show_checking = props.is_checking && props.show_spinner;
    let show_failure = !props.is_checking && !result.as_ref().is_some_and(|result| result.success);

    element! {
        View(flex_direction: FlexDirection::Column, row_gap: 1u32, padding_left: 1u32) {
            #(if show_checking {
                Some(element! {
                    View(padding_left: 1u32, flex_direction: FlexDirection::Row) {
                        Text(content: "⠋ ".to_string(), color: theme.permission, wrap: TextWrap::NoWrap)
                        Text(content: "Checking connectivity...".to_string())
                    }
                }.into_any())
            } else { None })
            #(if show_failure {
                Some(render_failure(result, theme))
            } else { None })
        }
    }
}

fn render_failure(result: Option<PreflightCheckResult>, theme: Theme) -> AnyElement<'static> {
    let error = result
        .as_ref()
        .and_then(|result| result.error.clone())
        .unwrap_or_default();
    let ssl_hint = result.and_then(|result| result.ssl_hint);

    element! {
        View(flex_direction: FlexDirection::Column, row_gap: 1u32) {
            Text(content: "Unable to connect to Anthropic services".to_string(), color: theme.error)
            Text(content: error, color: theme.error)
            #(if let Some(ssl_hint) = ssl_hint {
                element! {
                    View(flex_direction: FlexDirection::Column, row_gap: 1u32) {
                        Text(content: ssl_hint)
                        Text(content: "See https://code.claude.com/docs/en/network-config".to_string(), color: theme.suggestion)
                    }
                }.into_any()
            } else {
                element! {
                    View(flex_direction: FlexDirection::Column, row_gap: 1u32) {
                        Text(content: "Please check your internet connection and network settings.".to_string())
                        View(flex_direction: FlexDirection::Row) {
                            Text(content: "Note: Claude Code might not be available in your country. Check supported countries at ".to_string())
                            Text(content: "https://anthropic.com/supported-countries".to_string(), color: theme.suggestion)
                        }
                    }
                }.into_any()
            })
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;

    fn render_preflight(props: PreflightStepProps) -> String {
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                PreflightStep(
                    result: props.result,
                    is_checking: props.is_checking,
                    show_spinner: props.show_spinner,
                )
            }
        }
        .render(Some(120))
        .to_string()
    }

    #[test]
    fn preflight_step_renders_official_checking_state_without_network() {
        let text = render_preflight(PreflightStepProps {
            is_checking: true,
            show_spinner: true,
            ..PreflightStepProps::default()
        });

        assert!(text.contains("Checking connectivity..."), "canvas=\n{text}");
    }

    #[test]
    fn preflight_step_renders_official_failure_copy_without_ssl_hint() {
        let text = render_preflight(PreflightStepProps {
            result: Some(PreflightCheckResult {
                success: false,
                error: Some("Failed to connect to api.anthropic.com: ECONNRESET".to_string()),
                ssl_hint: None,
            }),
            is_checking: false,
            show_spinner: false,
        });

        assert!(
            text.contains("Unable to connect to Anthropic services"),
            "canvas=\n{text}"
        );
        assert!(text.contains("ECONNRESET"), "canvas=\n{text}");
        assert!(
            text.contains("Please check your internet connection and network settings."),
            "canvas=\n{text}"
        );
        assert!(
            text.contains("https://anthropic.com/supported-") && text.contains("countries"),
            "canvas=\n{text}"
        );
    }

    #[test]
    fn preflight_step_renders_ssl_hint_branch() {
        let text = render_preflight(PreflightStepProps {
            result: Some(PreflightCheckResult {
                success: false,
                error: Some("Failed to connect to oauth.example".to_string()),
                ssl_hint: Some("Install your enterprise CA certificate.".to_string()),
            }),
            is_checking: false,
            show_spinner: false,
        });

        assert!(
            text.contains("Install your enterprise CA certificate."),
            "canvas=\n{text}"
        );
        assert!(
            text.contains("https://code.claude.com/docs/en/network-config"),
            "canvas=\n{text}"
        );
    }
}
