//! Maps to: CC `components/permissions/PermissionExplanation.tsx`.
//!
//! Official React stores `{ visible, enabled, promise }` in
//! `usePermissionExplainerUI` and resolves the promise with Suspense. Nyan
//! keeps the same render states as explicit snapshots: hidden/not-requested,
//! loading, unavailable, and ready explanation. Live generation is
//! `utils/permissions/permission_explainer.rs` → `utils/side_query.rs`
//! (CC `sideQuery`).

use crate::types::message::Message;
use crate::utils::permissions::permission_explainer::{
    GenerateExplanationParams, PermissionExplanation, RiskLevel, generate_permission_explanation,
};
use crate::utils::theme::Theme;
use iocraft::prelude::*;
use serde_json::Value;
use std::sync::Arc;

pub const LOADING_MESSAGE: &str = "Loading explanation…";

/// Maps to: CC `ExplainerState` with `promise` projected into an explicit
/// retained-mode status.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExplainerState {
    pub visible: bool,
    pub enabled: bool,
    pub load_state: PermissionExplanationLoadState,
}

/// Maps to: CC `promise: Promise<PermissionExplanation | null> | null` states.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PermissionExplanationLoadState {
    /// `visible === false || promise === null`.
    #[default]
    NotRequested,
    /// Suspense fallback while the promise is pending.
    Loading,
    /// Promise resolved to `null` or errored.
    Unavailable,
    /// Promise resolved to a valid `PermissionExplanation`.
    Ready(PermissionExplanation),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionExplanationRiskColor {
    Success,
    Warning,
    Error,
}

/// Maps to: CC `getRiskColor(riskLevel)`.
pub fn get_risk_color(risk_level: RiskLevel) -> PermissionExplanationRiskColor {
    match risk_level {
        RiskLevel::Low => PermissionExplanationRiskColor::Success,
        RiskLevel::Medium => PermissionExplanationRiskColor::Warning,
        RiskLevel::High => PermissionExplanationRiskColor::Error,
    }
}

/// Maps to: CC `getRiskLabel(riskLevel)`.
pub fn get_risk_label(risk_level: RiskLevel) -> &'static str {
    match risk_level {
        RiskLevel::Low => "Low risk",
        RiskLevel::Medium => "Med risk",
        RiskLevel::High => "High risk",
    }
}

pub fn risk_color(theme: Theme, color: PermissionExplanationRiskColor) -> Color {
    match color {
        PermissionExplanationRiskColor::Success => theme.success,
        PermissionExplanationRiskColor::Warning => theme.warning,
        PermissionExplanationRiskColor::Error => theme.error,
    }
}

/// Maps to: CC Bash/PowerShell footer fragment
/// `ctrl+e to ${visible ? 'hide' : 'explain'}`.
pub fn permission_explainer_footer_hint(enabled: bool, visible: bool) -> Option<String> {
    enabled.then(|| {
        if visible {
            "ctrl+e to hide".to_string()
        } else {
            "ctrl+e to explain".to_string()
        }
    })
}

#[derive(Clone, Debug)]
struct PermissionExplanationRequest {
    tool_name: String,
    input: Value,
    description: Option<String>,
    messages: Arc<Vec<Message>>,
}

/// Retained projection of the official visibility and lazy-load state.
#[derive(Clone, Copy)]
pub struct PermissionExplanationController {
    visible: State<bool>,
    load_state: State<PermissionExplanationLoadState>,
}

impl PermissionExplanationController {
    pub fn visible(self) -> bool {
        self.visible.get()
    }

    pub fn load_state(self) -> PermissionExplanationLoadState {
        self.load_state.read().clone()
    }
}

/// Maps to: CC `PermissionExplanation.tsx` state/effect/keybinding setup.
pub fn use_permission_explanation(
    hooks: &mut Hooks,
    enabled: bool,
    initially_visible: bool,
    initial_load_state: PermissionExplanationLoadState,
    tool_name: String,
    input: Value,
    description: Option<String>,
    messages: Arc<Vec<Message>>,
) -> PermissionExplanationController {
    let mut visible = hooks.use_state(|| initially_visible);
    let mut load_state = hooks.use_state(|| initial_load_state.clone());
    let request_key = format!(
        "{tool_name}\u{0}{}\u{0}{}",
        serde_json::to_string(&input).unwrap_or_default(),
        description.as_deref().unwrap_or_default()
    );
    hooks.use_effect(
        move || {
            visible.set(initially_visible);
            load_state.set(initial_load_state);
        },
        request_key,
    );
    let channel =
        hooks.use_const(|| Arc::new(async_channel::unbounded::<PermissionExplanationRequest>()));

    hooks.use_future({
        let receiver = channel.1.clone();
        let mut load_state = load_state;
        async move {
            while let Ok(request) = receiver.recv().await {
                // Maps to: CC `generatePermissionExplanation`'s defensive
                // re-check of `isPermissionExplainerEnabled()`
                // (permissionExplainer.ts:155) against the real global config.
                // A fabricated `Some(true)` config here previously bypassed the
                // user's opt-out.
                let config = crate::utils::config::load_global_config();
                let explanation = generate_permission_explanation(
                    GenerateExplanationParams {
                        tool_name: &request.tool_name,
                        tool_input: &request.input,
                        tool_description: request.description.as_deref(),
                        messages: Some(request.messages.as_slice()),
                        aborted: false,
                        abort_signal: None,
                    },
                    &config,
                )
                .await;
                load_state.set(explanation.map_or(
                    PermissionExplanationLoadState::Unavailable,
                    PermissionExplanationLoadState::Ready,
                ));
            }
        }
    });

    let runtime = hooks
        .try_use_context::<crate::keybindings::keybinding_context::KeybindingRuntime>()
        .map(|runtime| runtime.clone());
    crate::keybindings::use_keybinding::use_keybinding(
        hooks,
        runtime,
        "confirm:toggleExplanation",
        crate::keybindings::types::ContextName::Confirmation,
        move || enabled,
        {
            let sender = channel.0.clone();
            move || {
                let next_visible = !visible.get();
                if next_visible
                    && matches!(
                        *load_state.read(),
                        PermissionExplanationLoadState::NotRequested
                    )
                {
                    load_state.set(PermissionExplanationLoadState::Loading);
                    let _ = sender.try_send(PermissionExplanationRequest {
                        tool_name: tool_name.clone(),
                        input: input.clone(),
                        description: description.clone(),
                        messages: Arc::clone(&messages),
                    });
                }
                visible.set(next_visible);
                true
            }
        },
    );

    PermissionExplanationController {
        visible,
        load_state,
    }
}

#[derive(Default, Props)]
pub struct PermissionExplainerContentProps {
    pub visible: bool,
    pub load_state: PermissionExplanationLoadState,
}

/// Maps to: CC `PermissionExplainerContent` and `ExplanationResult` render
/// branches.
#[component]
pub fn PermissionExplainerContent(
    props: &PermissionExplainerContentProps,
    hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    let theme = *hooks.use_context::<Theme>();

    if !props.visible
        || matches!(
            props.load_state,
            PermissionExplanationLoadState::NotRequested
        )
    {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    }

    match &props.load_state {
        PermissionExplanationLoadState::NotRequested => {
            element! { View(width: 0u32, height: 0u32) }.into_any()
        }
        PermissionExplanationLoadState::Loading => element! {
            View(margin_top: 1u32) {
                Text(content: LOADING_MESSAGE.to_string(), color: theme.inactive, wrap: TextWrap::NoWrap)
            }
        }
        .into_any(),
        PermissionExplanationLoadState::Unavailable => element! {
            View(margin_top: 1u32) {
                Text(content: "Explanation unavailable".to_string(), color: theme.inactive, wrap: TextWrap::NoWrap)
            }
        }
        .into_any(),
        PermissionExplanationLoadState::Ready(explanation) => {
            let risk_label = get_risk_label(explanation.risk_level).to_string();
            let risk_color_value = risk_color(theme, get_risk_color(explanation.risk_level));
            element! {
                View(flex_direction: FlexDirection::Column, margin_top: 1u32) {
                    Text(content: explanation.explanation.clone(), wrap: TextWrap::Wrap)
                    View(margin_top: 1u32) {
                        Text(content: explanation.reasoning.clone(), wrap: TextWrap::Wrap)
                    }
                    View(flex_direction: FlexDirection::Row, margin_top: 1u32) {
                        Text(content: format!("{risk_label}:"), color: risk_color_value, wrap: TextWrap::NoWrap)
                        Text(content: format!(" {}", explanation.risk), wrap: TextWrap::Wrap)
                    }
                }
            }
            .into_any()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::permissions::permission_explainer::PermissionExplanation;
    use crate::utils::theme;
    use futures::{StreamExt, stream};
    use std::time::Duration;

    #[component]
    fn ExplanationHarness(mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
        let controller = use_permission_explanation(
            &mut hooks,
            true,
            false,
            PermissionExplanationLoadState::Unavailable,
            "Bash".to_string(),
            serde_json::json!({"command": "pwd"}),
            Some("Print cwd".to_string()),
            Arc::new(Vec::new()),
        );
        element! {
            Text(content: if controller.visible() { "visible" } else { "hidden" }.to_string())
        }
    }

    #[component]
    fn ExplanationRoot(mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
        let runtime = crate::keybindings::keybinding_provider_setup::use_keybinding_setup(
            &mut hooks,
            crate::keybindings::keybinding_context::KeybindingRuntime::with_default_bindings(),
        );
        element! {
            ContextProvider(value: Context::owned(runtime)) {

                ExplanationHarness
            }
        }
    }

    fn render_content(visible: bool, load_state: PermissionExplanationLoadState) -> String {
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                PermissionExplainerContent(
                    visible: visible,
                    load_state: load_state,
                )
            }
        }
        .render(Some(100))
        .to_string()
    }

    #[test]
    fn permission_explanation_risk_labels_and_footer_match_official() {
        assert_eq!(get_risk_label(RiskLevel::Low), "Low risk");
        assert_eq!(get_risk_label(RiskLevel::Medium), "Med risk");
        assert_eq!(get_risk_label(RiskLevel::High), "High risk");
        assert_eq!(
            get_risk_color(RiskLevel::High),
            PermissionExplanationRiskColor::Error
        );
        assert_eq!(
            permission_explainer_footer_hint(true, false).as_deref(),
            Some("ctrl+e to explain")
        );
        assert_eq!(
            permission_explainer_footer_hint(true, true).as_deref(),
            Some("ctrl+e to hide")
        );
        assert!(permission_explainer_footer_hint(false, true).is_none());
    }

    #[test]
    fn confirm_toggle_explanation_dispatches_through_shared_runtime() {
        let text = futures::executor::block_on(async move {
            let mut app = element!(ExplanationRoot);
            let mut render_loop = Box::pin(
                app.mock_terminal_render_loop(
                    MockTerminalConfig::with_events(stream::iter(vec![TerminalEvent::Key({
                        let mut event = KeyEvent::new(KeyEventKind::Press, KeyCode::Char('e'));
                        event.modifiers = KeyModifiers::CONTROL;
                        event
                    })]))
                    .with_size(40, 4),
                ),
            );
            let mut last = String::new();
            for _ in 0..8 {
                let next = crate::utils::race(render_loop.next(), async {
                    futures_timer::Delay::new(Duration::from_millis(100)).await;
                    None
                })
                .await;
                let Some(canvas) = next else {
                    break;
                };
                last = canvas.to_string();
                if last.contains("visible") {
                    break;
                }
            }
            last
        });
        assert!(text.contains("visible"), "canvas=\n{text}");
    }

    #[test]
    fn permission_explainer_content_renders_loading_unavailable_and_result() {
        let hidden = render_content(false, PermissionExplanationLoadState::Loading);
        assert!(!hidden.contains(LOADING_MESSAGE), "canvas=\n{hidden}");

        let loading = render_content(true, PermissionExplanationLoadState::Loading);
        assert!(loading.contains(LOADING_MESSAGE), "canvas=\n{loading}");

        let unavailable = render_content(true, PermissionExplanationLoadState::Unavailable);
        assert!(
            unavailable.contains("Explanation unavailable"),
            "canvas=\n{unavailable}"
        );

        let ready = render_content(
            true,
            PermissionExplanationLoadState::Ready(PermissionExplanation {
                risk_level: RiskLevel::Medium,
                explanation: "Lists modified files.".to_string(),
                reasoning: "I need to inspect the working tree.".to_string(),
                risk: "Could reveal local paths".to_string(),
            }),
        );
        assert!(ready.contains("Lists modified files."), "canvas=\n{ready}");
        assert!(
            ready.contains("I need to inspect the working tree."),
            "canvas=\n{ready}"
        );
        assert!(
            ready.contains("Med risk: Could reveal local paths"),
            "canvas=\n{ready}"
        );
    }
}
