//! Maps to: CC `components/mcp/ElicitationDialog.tsx`.
//!
//! Intentional safety divergence: the official URL dialog calls `openBrowser`
//! when the user accepts/reopens a URL. Nyan does not launch external
//! browsers from this component; it emits the same accept/retry/dismiss actions
//! and leaves any future safe browser-opening policy to the MCP service/runtime
//! boundary.

use crate::components::design_system::dialog::Dialog;
use crate::constants::figures;
use crate::services::mcp::elicitation_handler::{
    ElicitationAction, ElicitationRequestEvent, ElicitationRequestParams, ElicitationResult,
    ElicitationWaitingDismissAction,
};
use crate::utils::mcp::elicitation_validation::get_format_hint;
use crate::utils::theme::Theme;
use iocraft::prelude::*;
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ElicitationButton {
    Accept,
    Decline,
    Open,
    Action,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UrlDialogPhase {
    Prompt,
    Waiting,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UrlParts {
    pub before_domain: String,
    pub domain: String,
    pub after_domain: String,
}

/// Maps to: CC `new URL(url)` domain highlighting in `ElicitationURLDialog`.
pub fn split_url_for_display(url: &str) -> UrlParts {
    let Some(scheme_end) = url.find("://") else {
        return UrlParts {
            before_domain: String::new(),
            domain: url.to_string(),
            after_domain: String::new(),
        };
    };
    let host_start = scheme_end + 3;
    let host_end = url[host_start..]
        .find(['/', '?', '#'])
        .map(|offset| host_start + offset)
        .unwrap_or(url.len());
    UrlParts {
        before_domain: url[..host_start].to_string(),
        domain: url[host_start..host_end].to_string(),
        after_domain: url[host_end..].to_string(),
    }
}

#[derive(Clone, Debug, PartialEq)]
struct FormFieldView {
    name: String,
    title: String,
    description: Option<String>,
    is_required: bool,
    value: Option<Value>,
    schema: Value,
}

fn schema_required_names(schema: &Value) -> Vec<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn form_fields_from_schema(schema: &Value) -> Vec<FormFieldView> {
    let required = schema_required_names(schema);
    schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|properties| {
            properties
                .iter()
                .map(|(name, prop_schema)| FormFieldView {
                    name: name.clone(),
                    title: prop_schema
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(name)
                        .to_string(),
                    description: prop_schema
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    is_required: required.iter().any(|candidate| candidate == name),
                    value: prop_schema.get("default").cloned(),
                    schema: prop_schema.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn default_form_content(fields: &[FormFieldView]) -> Option<Value> {
    let mut content = Map::new();
    for field in fields {
        if let Some(value) = &field.value {
            content.insert(field.name.clone(), value.clone());
        }
    }
    (!content.is_empty()).then(|| Value::Object(content))
}

#[derive(Default, Props)]
pub struct ElicitationDialogProps {
    pub event: Option<ElicitationRequestEvent>,
    pub on_response: Handler<ElicitationResult>,
    pub on_waiting_dismiss: Handler<ElicitationWaitingDismissAction>,
}

/// Maps to: CC `ElicitationDialog(...)` dispatcher.
#[component]
pub fn ElicitationDialog(
    props: &mut ElicitationDialogProps,
    _hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let Some(event) = props.event.clone() else {
        return element!(View(width: 0u32, height: 0u32)).into_any();
    };
    let on_response = props.on_response.clone();
    let on_waiting_dismiss = props.on_waiting_dismiss.clone();
    match &event.params {
        ElicitationRequestParams::Url { .. } => element! {
            ElicitationURLDialog(
                event: Some(event),
                on_response: on_response,
                on_waiting_dismiss: on_waiting_dismiss,
            )
        }
        .into_any(),
        ElicitationRequestParams::Form { .. } => element! {
            ElicitationFormDialog(event: Some(event), on_response: on_response)
        }
        .into_any(),
    }
}

#[derive(Default, Props)]
struct ElicitationFormDialogProps {
    event: Option<ElicitationRequestEvent>,
    on_response: Handler<ElicitationResult>,
}

/// Maps to: CC `ElicitationFormDialog(...)` rendering and accept/decline flow.
#[component]
fn ElicitationFormDialog(
    props: &mut ElicitationFormDialogProps,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let Some(event) = props.event.clone() else {
        return element!(View(width: 0u32, height: 0u32)).into_any();
    };
    let focused_button = hooks.use_state(|| ElicitationButton::Accept);
    let mut pending_response = hooks.use_state(|| Option::<ElicitationResult>::None);

    let (message, fields) = match &event.params {
        ElicitationRequestParams::Form {
            message,
            requested_schema,
        } => (message.clone(), form_fields_from_schema(requested_schema)),
        _ => (String::new(), Vec::new()),
    };

    hooks.use_terminal_events({
        let mut focused_button = focused_button;
        let mut pending_response = pending_response;
        let fields = fields.clone();
        move |event| {
            let TerminalEvent::Key(KeyEvent { code, kind, .. }) = event else {
                return;
            };
            if kind == KeyEventKind::Release {
                return;
            }
            match code {
                KeyCode::Left | KeyCode::Right => {
                    focused_button.set(if focused_button.get() == ElicitationButton::Accept {
                        ElicitationButton::Decline
                    } else {
                        ElicitationButton::Accept
                    });
                }
                KeyCode::Enter => {
                    let action = if focused_button.get() == ElicitationButton::Accept {
                        ElicitationAction::Accept
                    } else {
                        ElicitationAction::Decline
                    };
                    pending_response.set(Some(ElicitationResult {
                        action,
                        content: (action == ElicitationAction::Accept)
                            .then(|| default_form_content(&fields))
                            .flatten(),
                    }));
                }
                _ => {}
            }
        }
    });

    let response = { pending_response.read().clone() };
    if let Some(response) = response {
        pending_response.set(None);
        (props.on_response)(response);
    }

    let rows = fields
        .iter()
        .enumerate()
        .flat_map(|(index, field)| {
            let has_value = field.value.is_some();
            let marker = if has_value {
                figures::get().tick.to_string()
            } else if field.is_required {
                "*".to_string()
            } else {
                " ".to_string()
            };
            let value = field
                .value
                .as_ref()
                .map(|value| match value {
                    Value::String(value) => value.clone(),
                    _ => value.to_string(),
                })
                .or_else(|| get_format_hint(&field.schema))
                .unwrap_or_else(|| "not set".to_string());
            let pointer = if index == 0 { figures::get().pointer } else { " " };
            let mut out = vec![
                element! {
                    View(gap: 1u32) {
                        Text(content: pointer.to_string(), color: theme.suggestion, wrap: TextWrap::NoWrap)
                        Text(content: marker, color: if has_value { theme.success } else if field.is_required { theme.error } else { theme.text }, wrap: TextWrap::NoWrap)
                        Text(content: format!("{}: ", field.title), weight: if index == 0 { Weight::Bold } else { Weight::Normal }, wrap: TextWrap::NoWrap)
                        Text(content: value, dim: field.value.is_none(), italic: field.value.is_none(), wrap: TextWrap::NoWrap)
                    }
                }
                .into_any(),
            ];
            if let Some(description) = &field.description {
                out.push(
                    element! {
                        View(margin_left: 6u32) {
                            Text(content: description.clone(), dim: true, wrap: TextWrap::NoWrap)
                        }
                    }
                    .into_any(),
                );
            }
            out
        })
        .collect::<Vec<_>>();

    let accept_focused = focused_button.get() == ElicitationButton::Accept;
    let decline_focused = focused_button.get() == ElicitationButton::Decline;

    element! {
        Dialog(
            title: format!("MCP server “{}” requests your input", event.server_name),
            subtitle: Some(format!("\n{message}")),
            color: Some(theme.permission),
            on_cancel: move |_| pending_response.set(Some(ElicitationResult::new(ElicitationAction::Cancel))),
            input_guide: Some("Esc to cancel · ↑↓ navigate · ←→ switch".to_string()),
        ) {
            View(flex_direction: FlexDirection::Column) {
                #(rows)
                View(gap: 1u32) {
                    Text(content: if accept_focused { figures::get().pointer.to_string() } else { " ".to_string() }, color: theme.success, wrap: TextWrap::NoWrap)
                    Text(content: " Accept  ".to_string(), color: if accept_focused { theme.success } else { theme.text }, weight: if accept_focused { Weight::Bold } else { Weight::Normal }, dim: !accept_focused, wrap: TextWrap::NoWrap)
                    Text(content: if decline_focused { figures::get().pointer.to_string() } else { " ".to_string() }, color: theme.error, wrap: TextWrap::NoWrap)
                    Text(content: " Decline".to_string(), color: if decline_focused { theme.error } else { theme.text }, weight: if decline_focused { Weight::Bold } else { Weight::Normal }, dim: !decline_focused, wrap: TextWrap::NoWrap)
                }
            }
        }
    }
    .into_any()
}

#[derive(Default, Props)]
struct ElicitationURLDialogProps {
    event: Option<ElicitationRequestEvent>,
    on_response: Handler<ElicitationResult>,
    on_waiting_dismiss: Handler<ElicitationWaitingDismissAction>,
}

/// Maps to: CC `ElicitationURLDialog(...)` prompt/waiting phases.
#[component]
fn ElicitationURLDialog(
    props: &mut ElicitationURLDialogProps,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let Some(event) = props.event.clone() else {
        return element!(View(width: 0u32, height: 0u32)).into_any();
    };
    let phase = hooks.use_state(|| UrlDialogPhase::Prompt);
    let focused_button = hooks.use_state(|| ElicitationButton::Accept);
    let mut pending_response = hooks.use_state(|| Option::<ElicitationResult>::None);
    let mut pending_waiting_dismiss =
        hooks.use_state(|| Option::<ElicitationWaitingDismissAction>::None);

    let (message, url) = match &event.params {
        ElicitationRequestParams::Url { message, url, .. } => (message.clone(), url.clone()),
        _ => (String::new(), String::new()),
    };
    let url_parts = split_url_for_display(&url);
    let waiting_state = event.waiting_state.clone();
    let show_cancel = waiting_state
        .as_ref()
        .is_some_and(|state| state.show_cancel);

    hooks.use_terminal_events({
        let mut phase = phase;
        let mut focused_button = focused_button;
        let mut pending_response = pending_response;
        let mut pending_waiting_dismiss = pending_waiting_dismiss;
        move |event| {
            let TerminalEvent::Key(KeyEvent { code, kind, .. }) = event else {
                return;
            };
            if kind == KeyEventKind::Release {
                return;
            }
            match (phase.get(), code) {
                (UrlDialogPhase::Prompt, KeyCode::Left | KeyCode::Right) => {
                    focused_button.set(if focused_button.get() == ElicitationButton::Accept {
                        ElicitationButton::Decline
                    } else {
                        ElicitationButton::Accept
                    });
                }
                (UrlDialogPhase::Prompt, KeyCode::Enter) => {
                    if focused_button.get() == ElicitationButton::Accept {
                        pending_response
                            .set(Some(ElicitationResult::new(ElicitationAction::Accept)));
                        phase.set(UrlDialogPhase::Waiting);
                        focused_button.set(ElicitationButton::Open);
                    } else {
                        pending_response
                            .set(Some(ElicitationResult::new(ElicitationAction::Decline)));
                    }
                }
                (UrlDialogPhase::Waiting, KeyCode::Left | KeyCode::Right) => {
                    let next = match (focused_button.get(), show_cancel) {
                        (ElicitationButton::Open, _) => ElicitationButton::Action,
                        (ElicitationButton::Action, true) => ElicitationButton::Cancel,
                        (ElicitationButton::Action, false) => ElicitationButton::Open,
                        (ElicitationButton::Cancel, _) => ElicitationButton::Open,
                        _ => ElicitationButton::Open,
                    };
                    focused_button.set(next);
                }
                (UrlDialogPhase::Waiting, KeyCode::Enter) => match focused_button.get() {
                    ElicitationButton::Cancel => {
                        pending_waiting_dismiss.set(Some(ElicitationWaitingDismissAction::Cancel))
                    }
                    ElicitationButton::Action => {
                        pending_waiting_dismiss.set(Some(if show_cancel {
                            ElicitationWaitingDismissAction::Retry
                        } else {
                            ElicitationWaitingDismissAction::Dismiss
                        }))
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    });

    if event.completed && phase.get() == UrlDialogPhase::Waiting {
        pending_waiting_dismiss.set(Some(if show_cancel {
            ElicitationWaitingDismissAction::Retry
        } else {
            ElicitationWaitingDismissAction::Dismiss
        }));
    }
    let response = { pending_response.read().clone() };
    if let Some(response) = response {
        pending_response.set(None);
        (props.on_response)(response);
    }
    if let Some(action) = pending_waiting_dismiss.get() {
        pending_waiting_dismiss.set(None);
        (props.on_waiting_dismiss)(action);
    }

    if phase.get() == UrlDialogPhase::Waiting {
        let action_label = waiting_state
            .as_ref()
            .map(|state| state.action_label.clone())
            .unwrap_or_else(|| "Continue without waiting".to_string());
        let open_focused = focused_button.get() == ElicitationButton::Open;
        let action_focused = focused_button.get() == ElicitationButton::Action;
        let cancel_focused = focused_button.get() == ElicitationButton::Cancel;
        return element! {
            Dialog(
                title: format!("MCP server “{}” — waiting for completion", event.server_name),
                subtitle: Some(format!("\n{message}")),
                color: Some(theme.permission),
                on_cancel: move |_| pending_waiting_dismiss.set(Some(ElicitationWaitingDismissAction::Cancel)),
                input_guide: Some("Esc to cancel · ←→ switch".to_string()),
            ) {
                View(flex_direction: FlexDirection::Column) {
                    View {
                        Text(content: url_parts.before_domain.clone(), wrap: TextWrap::NoWrap)
                        Text(content: url_parts.domain.clone(), weight: Weight::Bold, wrap: TextWrap::NoWrap)
                        Text(content: url_parts.after_domain.clone(), wrap: TextWrap::NoWrap)
                    }
                    Text(content: "Waiting for the server to confirm completion…".to_string(), dim: true, italic: true, wrap: TextWrap::NoWrap)
                    View(gap: 1u32) {
                        Text(content: if open_focused { figures::get().pointer.to_string() } else { " ".to_string() }, color: theme.success, wrap: TextWrap::NoWrap)
                        Text(content: " Reopen URL  ".to_string(), color: if open_focused { theme.success } else { theme.text }, weight: if open_focused { Weight::Bold } else { Weight::Normal }, dim: !open_focused, wrap: TextWrap::NoWrap)
                        Text(content: if action_focused { figures::get().pointer.to_string() } else { " ".to_string() }, color: theme.success, wrap: TextWrap::NoWrap)
                        Text(content: format!(" {action_label}"), color: if action_focused { theme.success } else { theme.text }, weight: if action_focused { Weight::Bold } else { Weight::Normal }, dim: !action_focused, wrap: TextWrap::NoWrap)
                        #(if show_cancel { Some(element! {
                            Fragment {
                                Text(content: " ".to_string(), wrap: TextWrap::NoWrap)
                                Text(content: if cancel_focused { figures::get().pointer.to_string() } else { " ".to_string() }, color: theme.error, wrap: TextWrap::NoWrap)
                                Text(content: " Cancel".to_string(), color: if cancel_focused { theme.error } else { theme.text }, weight: if cancel_focused { Weight::Bold } else { Weight::Normal }, dim: !cancel_focused, wrap: TextWrap::NoWrap)
                            }
                        }) } else { None })
                    }
                }
            }
        }
        .into_any();
    }

    let accept_focused = focused_button.get() == ElicitationButton::Accept;
    let decline_focused = focused_button.get() == ElicitationButton::Decline;
    element! {
        Dialog(
            title: format!("MCP server “{}” wants to open a URL", event.server_name),
            subtitle: Some(format!("\n{message}")),
            color: Some(theme.permission),
            on_cancel: move |_| pending_response.set(Some(ElicitationResult::new(ElicitationAction::Cancel))),
            input_guide: Some("Esc to cancel · ←→ switch".to_string()),
        ) {
            View(flex_direction: FlexDirection::Column) {
                View {
                    Text(content: url_parts.before_domain, wrap: TextWrap::NoWrap)
                    Text(content: url_parts.domain, weight: Weight::Bold, wrap: TextWrap::NoWrap)
                    Text(content: url_parts.after_domain, wrap: TextWrap::NoWrap)
                }
                View(gap: 1u32) {
                    Text(content: if accept_focused { figures::get().pointer.to_string() } else { " ".to_string() }, color: theme.success, wrap: TextWrap::NoWrap)
                    Text(content: " Accept  ".to_string(), color: if accept_focused { theme.success } else { theme.text }, weight: if accept_focused { Weight::Bold } else { Weight::Normal }, dim: !accept_focused, wrap: TextWrap::NoWrap)
                    Text(content: if decline_focused { figures::get().pointer.to_string() } else { " ".to_string() }, color: theme.error, wrap: TextWrap::NoWrap)
                    Text(content: " Decline".to_string(), color: if decline_focused { theme.error } else { theme.text }, weight: if decline_focused { Weight::Bold } else { Weight::Normal }, dim: !decline_focused, wrap: TextWrap::NoWrap)
                }
            }
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::theme;
    use futures::{StreamExt, stream};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn key(code: KeyCode) -> TerminalEvent {
        TerminalEvent::Key(KeyEvent::new(KeyEventKind::Press, code))
    }

    fn form_event() -> ElicitationRequestEvent {
        ElicitationRequestEvent::new(
            "docs",
            "1",
            ElicitationRequestParams::Form {
                message: "Enter profile".to_string(),
                requested_schema: serde_json::json!({
                    "type": "object",
                    "required": ["email"],
                    "properties": {
                        "email": {
                            "type": "string",
                            "title": "Email",
                            "description": "Work email",
                            "format": "email",
                            "default": "user@example.com"
                        }
                    }
                }),
            },
        )
    }

    fn url_event() -> ElicitationRequestEvent {
        ElicitationRequestEvent::new(
            "docs",
            "2",
            ElicitationRequestParams::Url {
                message: "Authorize docs".to_string(),
                url: "https://example.com/auth?x=1".to_string(),
                elicitation_id: Some("elicit-1".to_string()),
            },
        )
    }

    #[test]
    fn split_url_for_display_highlights_domain_like_official_dialog() {
        assert_eq!(
            split_url_for_display("https://example.com/auth?x=1"),
            UrlParts {
                before_domain: "https://".to_string(),
                domain: "example.com".to_string(),
                after_domain: "/auth?x=1".to_string(),
            }
        );
    }

    #[test]
    fn elicitation_form_dialog_renders_official_title_fields_and_buttons() {
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                ElicitationDialog(event: Some(form_event()))
            }
        }
        .render(Some(120))
        .to_string();

        assert!(
            text.contains("MCP server “docs” requests your input"),
            "canvas=\n{text}"
        );
        assert!(text.contains("Enter profile"), "canvas=\n{text}");
        assert!(text.contains("Email:"), "canvas=\n{text}");
        assert!(text.contains("Work email"), "canvas=\n{text}");
        assert!(text.contains("Accept"), "canvas=\n{text}");
        assert!(text.contains("Decline"), "canvas=\n{text}");
    }

    #[test]
    fn elicitation_url_dialog_renders_prompt_and_domain() {
        let text = element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                ElicitationDialog(event: Some(url_event()))
            }
        }
        .render(Some(120))
        .to_string();

        assert!(
            text.contains("MCP server “docs” wants to open a URL"),
            "canvas=\n{text}"
        );
        assert!(text.contains("Authorize docs"), "canvas=\n{text}");
        assert!(text.contains("example.com"), "canvas=\n{text}");
        assert!(text.contains("Accept"), "canvas=\n{text}");
        assert!(text.contains("Decline"), "canvas=\n{text}");
    }

    #[test]
    fn elicitation_form_enter_emits_accept_with_default_content() {
        let responses = Arc::new(Mutex::new(Vec::<ElicitationResult>::new()));
        let responses_for_handler = Arc::clone(&responses);
        futures::executor::block_on(async move {
            let mut app = element! {
                ContextProvider(value: Context::owned(*theme::current())) {
                    ElicitationDialog(
                        event: Some(form_event()),
                        on_response: move |response| responses_for_handler.lock().expect("responses mutex").push(response),
                    )
                }
            };
            let mut render_loop = Box::pin(
                app.mock_terminal_render_loop(
                    MockTerminalConfig::with_events(stream::iter(vec![key(KeyCode::Enter)]))
                        .with_size(120, 24),
                ),
            );
            for _ in 0..8 {
                let next = crate::utils::race(render_loop.next(), async {
                    futures_timer::Delay::new(Duration::from_millis(100)).await;
                    None
                })
                .await;
                if next.is_none() {
                    break;
                }
            }
        });
        assert_eq!(
            responses.lock().expect("responses mutex").as_slice(),
            &[ElicitationResult {
                action: ElicitationAction::Accept,
                content: Some(serde_json::json!({"email":"user@example.com"})),
            }]
        );
    }

    #[test]
    fn elicitation_url_accept_enters_waiting_and_emits_accept_without_opening_browser() {
        let responses = Arc::new(Mutex::new(Vec::<ElicitationResult>::new()));
        let responses_for_handler = Arc::clone(&responses);
        futures::executor::block_on(async move {
            let mut app = element! {
                ContextProvider(value: Context::owned(*theme::current())) {
                    ElicitationDialog(
                        event: Some(url_event()),
                        on_response: move |response| responses_for_handler.lock().expect("responses mutex").push(response),
                    )
                }
            };
            let mut render_loop = Box::pin(
                app.mock_terminal_render_loop(
                    MockTerminalConfig::with_events(stream::iter(vec![key(KeyCode::Enter)]))
                        .with_size(120, 24),
                ),
            );
            let mut last = String::new();
            for _ in 0..8 {
                let next = crate::utils::race(render_loop.next(), async {
                    futures_timer::Delay::new(Duration::from_millis(100)).await;
                    None
                })
                .await;
                if let Some(canvas) = next {
                    last = canvas.to_string();
                } else {
                    break;
                }
            }
            assert!(last.contains("waiting for completion"), "canvas=\n{last}");
            assert!(last.contains("Skip confirmation"), "canvas=\n{last}");
        });
        assert_eq!(
            responses.lock().expect("responses mutex").as_slice(),
            &[ElicitationResult::new(ElicitationAction::Accept)]
        );
    }
}
