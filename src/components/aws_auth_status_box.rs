//! Maps to: CC `components/AwsAuthStatusBox.tsx`.
//!
//! The official component subscribes to `AwsAuthStatusManager` and re-renders
//! when cloud-provider authentication status changes. Nyan preserves the
//! component and state-manager boundaries; the component reads the current
//! manager snapshot (or a test-provided snapshot) at render time, while caller
//! re-render scheduling remains outside this UI boundary.

use crate::utils::aws_auth_status_manager::{AwsAuthStatus, get_status};
use iocraft::prelude::*;
use regex::Regex;
use std::sync::LazyLock;

static URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S+").unwrap());

#[derive(Default, Props)]
pub struct AwsAuthStatusBoxProps {
    pub status: Option<AwsAuthStatus>,
}

/// Maps to: CC `components/AwsAuthStatusBox.tsx` visibility guards.
pub fn aws_auth_status_box_should_render(status: &AwsAuthStatus) -> bool {
    status.is_authenticating || status.error.is_some()
}

fn split_url_line(line: &str) -> Option<(&str, &str, &str)> {
    let matched = URL_RE.find(line)?;
    Some((
        &line[..matched.start()],
        matched.as_str(),
        &line[matched.end()..],
    ))
}

/// Maps to: CC `components/AwsAuthStatusBox.tsx#AwsAuthStatusBox`.
#[component]
pub fn AwsAuthStatusBox(
    props: &AwsAuthStatusBoxProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<crate::utils::theme::Theme>();
    let status = props.status.clone().unwrap_or_else(get_status);

    if !aws_auth_status_box_should_render(&status) {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    }

    let output_lines = status
        .output
        .iter()
        .rev()
        .take(5)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let error = status.error.clone();

    element! {
        View(
            flex_direction: FlexDirection::Column,
            border_style: BorderStyle::Round,
            border_color: theme.permission,
            padding_left: 1u32,
            padding_right: 1u32,
            margin_top: 1u32,
            margin_bottom: 1u32,
        ) {
            Text(content: "Cloud Authentication".to_string(), weight: Weight::Bold, color: theme.permission)
            #(if !output_lines.is_empty() {
                Some(element! {
                    View(flex_direction: FlexDirection::Column, margin_top: 1u32) {
                        #(output_lines.into_iter().map(|line| {
                            if let Some((before, url, after)) = split_url_line(&line) {
                                element! {
                                    View(flex_direction: FlexDirection::Row) {
                                        Text(content: before.to_string(), dim: true, wrap: TextWrap::NoWrap)
                                        Text(content: url.to_string(), dim: true, href: Some(url.to_string()), wrap: TextWrap::NoWrap)
                                        Text(content: after.to_string(), dim: true, wrap: TextWrap::NoWrap)
                                    }
                                }.into_any()
                            } else {
                                element! { Text(content: line, dim: true, wrap: TextWrap::NoWrap) }.into_any()
                            }
                        }).collect::<Vec<_>>())
                    }
                })
            } else {
                None
            })
            #(error.map(|message| element! {
                View(margin_top: 1u32) {
                    Text(content: message, color: theme.error, wrap: TextWrap::Wrap)
                }
            }))
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::aws_auth_status_manager;
    use crate::utils::theme;

    fn render(status: AwsAuthStatus) -> iocraft::Canvas {
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                AwsAuthStatusBox(status: Some(status))
            }
        }
        .render(Some(120))
    }

    #[test]
    fn aws_auth_status_box_visibility_matches_official_guards() {
        assert!(!aws_auth_status_box_should_render(&AwsAuthStatus::default()));
        assert!(!aws_auth_status_box_should_render(&AwsAuthStatus {
            is_authenticating: false,
            output: vec!["completed".to_string()],
            error: None,
        }));
        assert!(aws_auth_status_box_should_render(&AwsAuthStatus {
            is_authenticating: true,
            output: Vec::new(),
            error: None,
        }));
        assert!(aws_auth_status_box_should_render(&AwsAuthStatus {
            is_authenticating: false,
            output: Vec::new(),
            error: Some("failed".to_string()),
        }));
    }

    #[test]
    fn aws_auth_status_box_renders_title_last_five_lines_links_and_error() {
        let canvas = render(AwsAuthStatus {
            is_authenticating: false,
            output: (1..=6)
                .map(|i| {
                    if i == 6 {
                        "open https://example.com/device now".to_string()
                    } else {
                        format!("line {i}")
                    }
                })
                .collect(),
            error: Some("Authentication failed".to_string()),
        });
        let text = canvas.to_string();

        assert!(text.contains("Cloud Authentication"), "canvas=\n{text}");
        assert!(
            !text.contains("line 1"),
            "should keep only last five output lines; canvas=\n{text}"
        );
        assert!(text.contains("line 2"), "canvas=\n{text}");
        assert!(
            text.contains("https://example.com/device"),
            "canvas=\n{text}"
        );
        assert!(text.contains("Authentication failed"), "canvas=\n{text}");
        assert!(
            (0..canvas.height()).any(|y| (0..canvas.width()).any(|x| {
                canvas.hyperlink_at(x, y).as_deref() == Some("https://example.com/device")
            })),
            "URL segment should carry OSC-8 hyperlink metadata"
        );
    }

    #[test]
    fn aws_auth_status_box_reads_manager_snapshot_when_prop_absent() {
        aws_auth_status_manager::reset();
        aws_auth_status_manager::start_authentication();
        aws_auth_status_manager::add_output("visit https://example.test/login");

        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                AwsAuthStatusBox
            }
        }
        .render(Some(120))
        .to_string();

        assert!(text.contains("Cloud Authentication"), "canvas=\n{text}");
        assert!(
            text.contains("https://example.test/login"),
            "canvas=\n{text}"
        );
        aws_auth_status_manager::reset();
    }
}
