//! Maps to: CC `components/PromptInput/PromptInputFooter.tsx`.
//!
//! Nyan keeps this footer in normal document flow for the main-screen /
//! native-scrollback path. It mirrors the official left-side mode/hints plus
//! right-side notifications, with no fullscreen/overlay behavior.

use super::{
    input_modes::PromptInputMode, notifications,
    prompt_input_footer_left_side::PromptInputFooterLeftSide, prompt_input_info_line,
};
use crate::context::notifications::{NotificationColor, NotificationSegment};
use crate::hooks::use_credential_status::CredentialStatus;
use crate::state::app_state::use_app_state;
use crate::types::permissions::PermissionMode;
use crate::utils::permissions::permission_mode::is_default_mode;
use crate::utils::theme::Theme;
use iocraft::prelude::*;

/// Shared segmented footer-row payload (Notifications inline rows + Bridge).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptFooterIndicator {
    pub text: String,
    pub segments: Vec<NotificationSegment>,
    /// Official footer pills can use inverse styling when selected.
    pub inverse: bool,
}

impl PromptFooterIndicator {
    pub(crate) fn from_segments(segments: Vec<NotificationSegment>) -> Self {
        Self::from_segments_with_inverse(segments, false)
    }

    pub(crate) fn from_segments_with_inverse(
        segments: Vec<NotificationSegment>,
        inverse: bool,
    ) -> Self {
        let text = segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect();
        Self {
            text,
            segments,
            inverse,
        }
    }

    pub(crate) fn dim(text: impl Into<String>) -> Self {
        let text = text.into();
        Self::from_segments(vec![NotificationSegment::text(text).with_dim(true)])
    }

    pub(crate) fn inactive(text: impl Into<String>) -> Self {
        Self::from_segments(vec![NotificationSegment::text(text)])
    }

    pub(crate) fn colored(text: impl Into<String>, color: NotificationColor) -> Self {
        Self::from_segments(vec![NotificationSegment::text(text).with_color(color)])
    }
}

#[derive(Default, Props)]
pub struct FooterProps {
    /// Maps to: CC `PromptInputFooter.apiKeyStatus` → `Notifications`.
    pub credential_status: CredentialStatus,
    /// Maps to: CC `PromptInputFooter.tsx:46` `autoUpdaterResult` (REPL-owned),
    /// forwarded to `Notifications` (`:208`).
    pub auto_updater_result: Option<crate::utils::auto_updater::AutoUpdaterResult>,
    /// Maps to: CC `PromptInputFooter.tsx:47` `isAutoUpdating` (PromptInput-owned).
    pub is_auto_updating: bool,
    /// Maps to: CC `PromptInputFooter.tsx:49` `onAutoUpdaterResult`.
    pub on_auto_updater_result: Handler<crate::utils::auto_updater::AutoUpdaterResult>,
    /// Maps to: CC `PromptInputFooter.tsx:50` `onChangeIsUpdating`.
    pub on_change_is_updating: Handler<bool>,
    /// Maps to: CC `PromptInputFooter.tsx:63` `ideSelection` (REPL-owned),
    /// forwarded to `Notifications` (`:215`).
    pub ide_selection: Option<crate::hooks::use_ide_selection::IdeSelection>,
    /// Maps to: CC `PromptInputFooter.tsx:67` `messages` prop, forwarded to
    /// `Notifications` (`:212`) for its component-local tokenUsage derivation.
    pub messages: std::sync::Arc<Vec<crate::types::message::Message>>,
    /// Maps to: CC `PromptInputFooter` → `Notifications.debug` prop flow.
    pub debug: bool,
    pub exit_hint: Option<String>,
    pub suppress_hint: bool,
    pub is_searching: bool,
    /// Maps to: CC `PromptInputFooter` `historyQuery` + `setHistoryQuery`
    /// (PromptInput.tsx:3075-3076), passed through to the left side.
    pub history_query: Option<State<String>>,
    pub history_failed_match: bool,
    pub is_loading: bool,
    pub permission_mode: PermissionMode,
    pub status_indicator_count: usize,
    pub background_task_count: usize,
    /// Maps to: CC `BackgroundTaskStatus.tsx:199-208` — the pill text is
    /// `getPillLabel(runningTasks)` (`tasks/pillLabel.ts`), computed by the
    /// owner from the same set `background_task_count` gates on.
    pub background_tasks_label: String,
    pub teammate_count: usize,
    /// Maps to: CC `PromptInputFooter.tsx:58-60` `tasksSelected` /
    /// `teamsSelected` / `bridgeSelected`, which PromptInput derives from the
    /// effective `footerItemSelected` (`PromptInput.tsx:663-682`), so a pill
    /// that stopped rendering is never drawn selected. `tmuxSelected` is
    /// ant-only (Tungsten) and has no footer item here.
    pub tasks_selected: bool,
    pub teams_selected: bool,
    pub bridge_selected: bool,
    pub vim_mode: Option<String>,
    pub mode: PromptInputMode,
    pub is_pasting: bool,
    /// Terminal columns for the info line's narrow-screen degradation
    /// (`docs/nyan/tui.md` §3.2). `None` reads the process terminal.
    pub info_line_width: Option<u32>,
}

/// Single source for "the left side renders a body row for footer pills"
/// (bash banner, vim indicator, tasks pill, teammate pill). The HEIGHT BUDGET
/// and the component's own render gate MUST share this predicate.
pub fn footer_has_items(
    mode: PromptInputMode,
    vim_mode_active: bool,
    background_task_count: usize,
    teammate_count: usize,
) -> bool {
    mode == PromptInputMode::Bash
        || vim_mode_active
        || background_task_count > 0
        || teammate_count > 0
}

pub fn footer_row_should_render(
    exit_hint_visible: bool,
    is_searching: bool,
    suppress_hint: bool,
    _is_loading: bool,
    permission_mode: PermissionMode,
    notification_row_count: usize,
    status_indicator_count: usize,
    has_footer_items: bool,
) -> bool {
    exit_hint_visible
        || is_searching
        || notification_row_count > 0
        || status_indicator_count > 0
        || !is_default_mode(permission_mode)
        || !suppress_hint
        || has_footer_items
}

fn footer_body_height_for(
    exit_hint_visible: bool,
    is_searching: bool,
    suppress_hint: bool,
    is_loading: bool,
    permission_mode: PermissionMode,
    notification_row_count: usize,
    status_indicator_count: usize,
    has_footer_items: bool,
) -> usize {
    if footer_row_should_render(
        exit_hint_visible,
        is_searching,
        suppress_hint,
        is_loading,
        permission_mode,
        notification_row_count,
        status_indicator_count,
        has_footer_items,
    ) {
        (notification_row_count + status_indicator_count).max(1)
    } else {
        0
    }
}

/// Total footer height: the built-in info line plus the body row(s).
///
/// @nyan: the info line is always present (docs/nyan/tui.md §3.1) and is NOT
/// affected by `suppress_hint`, so it is added outside the body predicate.
/// The component below mounts it on exactly the same condition.
pub fn footer_height_for(
    exit_hint_visible: bool,
    is_searching: bool,
    suppress_hint: bool,
    is_loading: bool,
    permission_mode: PermissionMode,
    notification_row_count: usize,
    status_indicator_count: usize,
    has_footer_items: bool,
) -> usize {
    prompt_input_info_line::INFO_LINE_HEIGHT
        + footer_body_height_for(
            exit_hint_visible,
            is_searching,
            suppress_hint,
            is_loading,
            permission_mode,
            notification_row_count,
            status_indicator_count,
            has_footer_items,
        )
}

#[component]
pub fn Footer(props: &FooterProps, mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
    // Rows `Notifications` renders directly (CC NotificationContent). Computed
    // here (component-owned) from the same contexts Notifications reads, so
    // every mount point — production or test harness — stays consistent.
    // Maps to: CC `useNotification()` reading `AppState.notifications.current`.
    // Read through the subscribed selector, not through `use_notifications`:
    // that writer carries no subscription, so a notification arriving from a
    // background task would not wake this footer.
    let has_current_notification = crate::state::app_state::use_app_state(&mut hooks, |state| {
        state.notifications.current.is_some()
    });
    // Maps to: CC Notifications.tsx:80-83 tokenUsage useMemo ([messages]
    // identity dep); the retained footer height budget needs the same value.
    let token_usage = hooks.use_memo(
        {
            let messages = std::sync::Arc::clone(&props.messages);
            move || notifications::token_usage_from_messages(&messages)
        },
        std::sync::Arc::as_ptr(&props.messages) as usize,
    );
    // Height computers read the PromptInput-scoped wake epoch (L1
    // `PromptInput-scoped footer layout wake`, PORTING.md): the flip bump
    // wakes the PromptInput owner, which re-renders this Footer; the epoch
    // read keeps both height sites (this one and prompt_input/mod.rs) on the
    // same carrier.
    let _footer_layout_epoch = hooks
        .try_use_context::<super::footer_layout_wake::FooterLayoutWake>()
        .map(|wake| wake.epoch())
        .unwrap_or(0);
    // The non-AppState inputs are captured by value: the selector is retained
    // by the subscription hook so it can re-project off-render, and it is
    // re-boxed every render, so each pass still closes over that pass's props.
    let notification_row_count = {
        let debug = props.debug;
        let credential_status = props.credential_status.clone();
        let auto_updater_result = props.auto_updater_result.clone();
        let is_auto_updating = props.is_auto_updating;
        let ide_selection = props.ide_selection.clone();
        crate::state::app_state::use_app_state(&mut hooks, move |state| {
            notifications::direct_footer_row_count_from_app(
                state,
                has_current_notification,
                debug,
                &credential_status,
                token_usage,
                auto_updater_result.as_ref(),
                is_auto_updating,
                ide_selection.as_ref(),
            )
        })
    };
    let suppress_hint = props.suppress_hint || props.is_searching;
    let exit_hint_visible = props.exit_hint.is_some();
    let has_footer_items = footer_has_items(
        props.mode,
        props.vim_mode.is_some(),
        props.background_task_count,
        props.teammate_count,
    );
    let footer_body_height = footer_body_height_for(
        exit_hint_visible,
        props.is_searching,
        suppress_hint,
        props.is_loading,
        props.permission_mode,
        notification_row_count,
        props.status_indicator_count,
        has_footer_items,
    );
    let has_footer_row = footer_body_height > 0;
    let has_right_side = notification_row_count > 0 || props.status_indicator_count > 0;

    // @nyan: the built-in info line replaces the deleted statusLine and is
    // always present, independent of `suppress_hint` (docs/nyan/tui.md §3.1).
    // `footer_height_for` counts exactly this row.
    let info_line = element! {
        prompt_input_info_line::InfoLine(
            token_usage: token_usage,
            width: props.info_line_width,
        )
    }
    .into_any();

    element! {
        View(flex_direction: FlexDirection::Column, width: 100pct) {
            #(Some(info_line))
            #(if has_footer_row {
                Some(element! {
                    View(
                        flex_direction: FlexDirection::Row,
                        justify_content: JustifyContent::SPACE_BETWEEN,
                        column_gap: 1u32,
                        width: 100pct,
                        height: footer_body_height as u32,
                        padding_left: 2u32,
                        padding_right: 2u32,
                        overflow: Overflow::Hidden,
                    ) {
                        View(flex_direction: FlexDirection::Row, flex_shrink: 1.0f32, overflow: Overflow::Hidden) {
                            PromptInputFooterLeftSide(
                                exit_hint: props.exit_hint.clone(),
                                is_pasting: props.is_pasting,
                                vim_mode: props.vim_mode.clone(),
                                mode: props.mode,
                                suppress_hint: suppress_hint,
                                is_searching: props.is_searching,
                                history_query: props.history_query,
                                history_failed_match: props.history_failed_match,
                                is_loading: props.is_loading,
                                permission_mode: props.permission_mode,
                                background_task_count: props.background_task_count,
                                background_tasks_label: props.background_tasks_label.clone(),
                                teammate_count: props.teammate_count,
                                // CC :130-132 `pillSelected` also clears when the
                                // pointer is inside CoordinatorTaskPanel
                                // (`coordinatorTaskIndex >= 0`). The panel is not
                                // ported and the index never leaves its -1
                                // default, so it is `tasksSelected`; restore the
                                // formula when the panel lands.
                                tasks_selected: props.tasks_selected,
                                teams_selected: props.teams_selected,
                            )
                        }
                        #(if has_right_side {
                            Some(element! {
                                View(flex_direction: FlexDirection::Column, flex_shrink: 1.0f32, overflow: Overflow::Hidden) {
                                    #(if notification_row_count > 0 {
                                        // Maps to: CC PromptInputFooter.tsx:206-214
                                        // — forward the auto-updater value/callback
                                        // props to Notifications.
                                        Some(element! {
                                            notifications::Notifications(
                                                credential_status: props.credential_status.clone(),
                                                auto_updater_result: props.auto_updater_result.clone(),
                                                is_auto_updating: props.is_auto_updating,
                                                on_auto_updater_result: props.on_auto_updater_result.clone(),
                                                on_change_is_updating: props.on_change_is_updating.clone(),
                                                debug: props.debug,
                                                messages: props.messages.clone(),
                                                ide_selection: props.ide_selection.clone(),
                                                suppressed: false,
                                                inline: true,
                                            )
                                        })
                                    } else {
                                        None
                                    })
                                    #(if props.status_indicator_count > 0 {
                                        Some(element! { BridgeStatusIndicator(bridge_selected: props.bridge_selected) })
                                    } else {
                                        None
                                    })
                                }
                            })
                        } else {
                            None
                        })
                    }
                })
            } else {
                None
            })
        }
    }
    .into_any()
}

/// Maps to: CC `PromptInputFooter.tsx` `BridgeStatusIndicator`. Reads the
/// flat `AppState.repl_bridge_*` fields and delegates the status label/color
/// to the canonical `bridge_status_util::get_bridge_status` port (CC calls
/// `bridgeStatusUtil.getBridgeStatus`, PromptInputFooter.tsx:257-262);
/// `selected` is the component's `bridgeSelected` prop.
///
/// The gates are explicit params because they are NOT AppState in CC either:
/// `feature_enabled` mirrors PromptInputFooter.tsx:241 `feature('BRIDGE_MODE')`
/// and `entitlement_enabled` mirrors :255 `isBridgeEnabled()` — both evaluated
/// live at the call sites (`FeatureFlag::BridgeMode` /
/// `bridge::bridge_enabled::is_bridge_enabled`).
pub fn bridge_status_indicator(
    state: &crate::state::app_state_store::AppState,
    feature_enabled: bool,
    entitlement_enabled: bool,
    selected: bool,
) -> Option<PromptFooterIndicator> {
    if !feature_enabled || !entitlement_enabled || !state.repl_bridge_enabled {
        return None;
    }

    // Maps to: CC PromptInputFooter.tsx:257-262 — the footer calls the
    // canonical `bridgeStatusUtil.getBridgeStatus` with `error: undefined`
    // (failed state is surfaced via notification, not a footer pill), so the
    // failed branch is unreachable here.
    let status = crate::bridge::bridge_status_util::get_bridge_status(
        None,
        state.repl_bridge_connected,
        state.repl_bridge_session_active,
        state.repl_bridge_reconnecting,
    );

    // Maps to: CC PromptInputFooter.tsx:265-267 — implicit (config-driven)
    // remote shows only the reconnecting state.
    if !state.repl_bridge_explicit && status.label != "Remote Control reconnecting" {
        return None;
    }

    let mut segments =
        vec![NotificationSegment::text(status.label).with_color(bridge_status_color(status.color))];
    if selected {
        segments.push(NotificationSegment::text(" · Enter to view").with_dim(true));
    }
    Some(PromptFooterIndicator::from_segments_with_inverse(
        segments, selected,
    ))
}

/// Consumer-side mapping from the canonical bridge status color
/// (`bridge/bridge_status_util.rs`, CC `bridgeStatusUtil.ts` color keys) to
/// the footer's segment color vocabulary.
fn bridge_status_color(
    color: crate::bridge::bridge_status_util::BridgeStatusColor,
) -> NotificationColor {
    match color {
        crate::bridge::bridge_status_util::BridgeStatusColor::Error => NotificationColor::Error,
        crate::bridge::bridge_status_util::BridgeStatusColor::Warning => NotificationColor::Warning,
        crate::bridge::bridge_status_util::BridgeStatusColor::Success => NotificationColor::Success,
    }
}

/// Bridge-only right-side stack count (CC `BridgeStatusIndicator`). The
/// feature gate is a cheap constant; the entitlement is lazy.
///
/// Documented deviation from CC's operand order: CC evaluates
/// `!isBridgeEnabled() || !enabled` (PromptInputFooter.tsx:255) with an
/// in-memory-cached `isBridgeEnabled`. The Rust entitlement read performs
/// real config/token-file/keychain IO per call, so the cheap
/// `repl_bridge_enabled` AppState gate short-circuits first — the conjunction
/// result is identical, and hot render frames stay free of auth IO (pinned by
/// `logo_header_hot_path_avoids_uncached_auth_io...` in screens/repl.rs).
pub fn bridge_status_indicator_count_from_app(
    state: &crate::state::app_state_store::AppState,
    feature_enabled: bool,
    entitlement_enabled: impl FnOnce() -> bool,
) -> usize {
    if !feature_enabled || !state.repl_bridge_enabled {
        return 0;
    }
    // Selection only styles the pill (CC :270-276); it never decides whether
    // one renders.
    usize::from(
        bridge_status_indicator(state, feature_enabled, entitlement_enabled(), false).is_some(),
    )
}

fn indicator_color(color: Option<NotificationColor>, theme: &Theme) -> Color {
    match color {
        Some(NotificationColor::Error) => theme.error,
        Some(NotificationColor::Warning) => theme.warning,
        Some(NotificationColor::Success) => theme.success,
        Some(NotificationColor::Claude) => theme.claude,
        Some(NotificationColor::Text) => theme.text,
        Some(NotificationColor::Ide) => theme.ide,
        Some(NotificationColor::Suggestion) => theme.suggestion,
        None => theme.inactive,
    }
}

/// Maps to: CC `PromptInputFooter.tsx:234-236` `BridgeStatusProps`.
#[derive(Default, Props)]
pub struct BridgeStatusIndicatorProps {
    pub bridge_selected: bool,
}

/// Maps to: CC `PromptInputFooter.tsx:238-279` `BridgeStatusIndicator`.
#[component]
pub fn BridgeStatusIndicator(
    props: &BridgeStatusIndicatorProps,
    mut hooks: Hooks,
) -> impl Into<AnyElement<'static>> {
    // Maps to: CC PromptInputFooter.tsx:241 `if (!feature('BRIDGE_MODE'))
    // return null` — build gate checked before any state read.
    if !crate::utils::feature_flags::feature_enabled(
        crate::utils::feature_flags::FeatureFlag::BridgeMode,
    ) {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    }
    let theme = hooks.use_context::<Theme>();
    let bridge_selected = props.bridge_selected;
    let indicator = use_app_state(&mut hooks, move |state| {
        // Cheap AppState gate first, then the CC PromptInputFooter.tsx:255
        // `isBridgeEnabled()` entitlement. Same documented operand-order
        // deviation as `bridge_status_indicator_count_from_app`: the Rust
        // entitlement read does real config/keychain IO, and `&&` keeps the
        // result identical.
        if !state.repl_bridge_enabled {
            return None;
        }
        bridge_status_indicator(
            state,
            true,
            crate::bridge::bridge_enabled::is_bridge_enabled(),
            bridge_selected,
        )
    });

    let Some(indicator) = indicator else {
        return element! { View(width: 0u32, height: 0u32) }.into_any();
    };

    element! {
        View(flex_direction: FlexDirection::Row, height: 1u32, overflow: Overflow::Hidden) {
            #(indicator.segments.iter().map(|segment| {
                // Maps to: CC PromptInputFooter.tsx:270-277 — the selected
                // pill renders `color={bridgeSelected ? 'background' :
                // status.color}` with `inverse`; the nested dim suffix sits
                // inside the same background-keyed inverse Text.
                let segment_color = if indicator.inverse {
                    theme.background
                } else {
                    indicator_color(segment.color, &theme)
                };
                element! {
                    Text(
                        content: segment.text.clone(),
                        color: segment_color,
                        dim: segment.dim,
                        invert: indicator.inverse,
                        wrap: TextWrap::NoWrap,
                    )
                }
            }))
        }
    }
    .into_any()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::notifications::{Notification, NotificationsState};
    use crate::utils::theme;

    #[test]
    fn footer_height_matches_hint_and_notification_rows() {
        // @nyan: +1 for the built-in info line, which is always present.
        assert_eq!(
            footer_height_for(
                false,
                false,
                false,
                true,
                PermissionMode::Default,
                1,
                0,
                false,
            ),
            2,
            "loading hint and notification share the official footer row above the info line"
        );
        assert_eq!(
            footer_height_for(false, false, true, false, PermissionMode::Plan, 0, 0, false,),
            2,
            "active permission mode renders even when shortcut hints are suppressed"
        );
        assert_eq!(
            footer_height_for(
                false,
                false,
                true,
                false,
                PermissionMode::Default,
                0,
                2,
                false,
            ),
            3,
            "right-side status indicators keep their official stacked footer rows"
        );
    }

    #[test]
    fn footer_height_budgets_the_pill_row() {
        assert_eq!(
            footer_height_for(
                false,
                false,
                true,
                false,
                PermissionMode::Default,
                0,
                0,
                true,
            ),
            2,
            "footer pills own one body row plus the info line"
        );
        assert!(footer_has_items(PromptInputMode::Prompt, false, 2, 0));
        assert!(footer_has_items(PromptInputMode::Bash, false, 0, 0));
        assert!(!footer_has_items(PromptInputMode::Prompt, false, 0, 0));
    }

    #[test]
    fn footer_height_keeps_the_info_line_when_no_body_row_renders() {
        assert_eq!(
            footer_height_for(
                false,
                false,
                true,
                false,
                PermissionMode::Default,
                0,
                0,
                false,
            ),
            1,
            "the info line survives a fully suppressed hint row"
        );
    }

    #[component]
    fn FooterLoadingWithPermissionMode(mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
        let store = hooks.use_state(|| {
            crate::state::store::AppStore::new(
                crate::state::app_state_store::AppState::default(),
                None,
            )
        });
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                crate::state::app_state::AppStateProvider(
                    prebuilt_store: Some(store.read().clone()),
                    children: crate::state::app_state::ProviderChildren::new(|| element! {
                        Footer(
                            suppress_hint: false,
                            is_loading: true,
                            permission_mode: PermissionMode::AcceptEdits,
                        )
                    }.into_any()),
                )
            }
        }
    }

    #[test]
    fn footer_renders_loading_and_permission_mode_without_interrupt_hint() {
        let text = element!(FooterLoadingWithPermissionMode)
            .render(Some(100))
            .to_string();

        // Nyan-specific deviation (product requirement — skip in parity
        // audits): CC renders "accept edits on"; Nyan drops the " on".
        assert!(text.contains("⏵⏵ accept edits"), "canvas=\n{text}");
        assert!(!text.contains("accept edits on"), "canvas=\n{text}");
        assert!(text.contains("shift+tab to cycle"), "canvas=\n{text}");
        // Nyan-specific deviation (product requirement — skip in parity
        // audits): CC appends "esc to interrupt" while loading
        // (PromptInputFooterLeftSide hintParts); Nyan does not clone it.
        assert!(!text.contains("esc to interrupt"), "canvas=\n{text}");
        assert!(!text.contains("? for shortcuts"), "canvas=\n{text}");
    }

    #[component]
    fn FooterWithNotification(mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
        let notifications = hooks.use_state(|| {
            let mut initial = crate::state::app_state_store::AppState::default();
            initial.notifications = std::sync::Arc::new(NotificationsState {
                current: Some(Notification::text(
                    "demo",
                    "footer notification",
                    crate::context::notifications::NotificationPriority::Medium,
                )),
                queue: Vec::new(),
            });
            crate::state::store::AppStore::new(initial, None)
        });
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                crate::state::app_state::AppStateProvider(
                    prebuilt_store: Some(notifications.read().clone()),
                    children: crate::state::app_state::ProviderChildren::new(|| element! {
                        Footer(suppress_hint: false)
                    }.into_any()),
                )
            }
        }
    }

    #[test]
    fn footer_places_runtime_notification_in_same_footer_row() {
        let text = element!(FooterWithNotification)
            .render(Some(100))
            .to_string();

        assert!(text.contains("? for shortcuts"), "canvas=\n{text}");
        assert!(text.contains("footer notification"), "canvas=\n{text}");
    }

    #[component]
    fn FooterWithStatusIndicators(mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
        let store = hooks.use_const(|| {
            let mut initial = crate::state::app_state_store::AppState::default();
            initial.verbose = true;
            // no footer_indicators bag (D9)
            crate::state::store::AppStore::new(initial, None)
        });
        // CC: tokenUsage derives from the messages prop (Notifications.tsx:80-83).
        let messages = hooks.use_const(|| {
            std::sync::Arc::new(vec![crate::types::message::Message::Assistant(
                crate::types::message::AssistantMessage {
                    uuid: uuid::Uuid::new_v4().to_string(),
                    timestamp: chrono::Utc::now(),
                    content: vec![crate::types::message::AssistantContent::Text("hi".into())],
                    model: Some("claude".into()),
                    stop_reason: None,
                    usage: Some(crate::types::message::TokenUsage {
                        input_tokens: 70,
                        output_tokens: 7,
                        ..Default::default()
                    }),
                },
            )])
        });
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                crate::state::app_state::AppStateProvider(
                    prebuilt_store: Some(store.clone()),
                    children: crate::state::app_state::ProviderChildren::new(move || element! {
                        Footer(debug: true, messages: messages.clone(), suppress_hint: false)
                    }.into_any()),
                )
            }
        }
    }

    #[test]
    fn footer_renders_status_indicators_as_right_side_rows() {
        let text = element!(FooterWithStatusIndicators)
            .render(Some(100))
            .to_string();

        assert!(text.contains("? for shortcuts"), "canvas=\n{text}");
        assert!(text.contains("Debug mode"), "canvas=\n{text}");
        // @nyan: the verbose `N tokens` row moved to the info line (tui.md
        // §3.4), so the debug rows no longer carry it.
        assert!(!text.contains("77 tokens"), "canvas=\n{text}");
        assert!(!text.contains(" tokens"), "canvas=\n{text}");
    }

    #[derive(Default, Props)]
    struct FooterWithTasksPillProps {
        raw_selection: Option<crate::state::app_state_store::FooterItem>,
        tasks_selected: bool,
    }

    /// A tasks pill under an AppState whose raw `footer_selection` may
    /// disagree with the `tasks_selected` prop.
    #[component]
    fn FooterWithTasksPill(
        props: &FooterWithTasksPillProps,
        mut hooks: Hooks,
    ) -> impl Into<AnyElement<'static>> {
        let raw_selection = props.raw_selection;
        let store = hooks.use_const(move || {
            let mut initial = crate::state::app_state_store::AppState::default();
            initial.footer_selection = raw_selection;
            crate::state::store::AppStore::new(initial, None)
        });
        let tasks_selected = props.tasks_selected;
        element! {
            ContextProvider(value: Context::owned(*theme::current())) {
                crate::state::app_state::AppStateProvider(
                    prebuilt_store: Some(store.clone()),
                    children: crate::state::app_state::ProviderChildren::new(move || element! {
                        Footer(
                            suppress_hint: false,
                            background_task_count: 1usize,
                            background_tasks_label: "1 shell".to_string(),
                            tasks_selected: tasks_selected,
                        )
                    }.into_any()),
                )
            }
        }
    }

    /// The background of the tasks pill's first cell.
    fn tasks_pill_background(
        raw_selection: Option<crate::state::app_state_store::FooterItem>,
        tasks_selected: bool,
    ) -> Option<Color> {
        let canvas = element!(
            FooterWithTasksPill(raw_selection: raw_selection, tasks_selected: tasks_selected)
        )
        .render(Some(100));
        let text = canvas.to_string();
        let (y, line) = text
            .lines()
            .enumerate()
            .find(|(_, line)| line.contains("1 shell"))
            .unwrap_or_else(|| panic!("no pill in canvas=\n{text}"));
        let x = line[..line.find("1 shell").unwrap()].chars().count();
        canvas.cell(x, y).and_then(|cell| cell.background_color)
    }

    #[test]
    fn footer_pills_follow_the_owners_selection_not_the_raw_app_state() {
        use crate::state::app_state_store::FooterItem;
        // CC PromptInput.tsx:663-682 hands the pills the owner's effective
        // selection as props; the raw AppState value does not decide it.
        let highlight = Some(theme::current().suggestion);
        assert_eq!(tasks_pill_background(Some(FooterItem::Tasks), false), None);
        assert_eq!(tasks_pill_background(None, true), highlight);
    }

    /// Flat AppState fixture for bridge visibility tests (CC AppStateStore.ts
    /// replBridge* fields). Truthful seam: production has no producer that
    /// sets `repl_bridge_enabled` true (CC settings-screen toggle and
    /// useReplBridge transport are unported), so these fixture states are
    /// test-only reachable even though the two gates are now live-computed
    /// (BridgeMode build gate is on; the isBridgeEnabled entitlement can be
    /// genuinely true for a claude.ai subscriber with a cached
    /// `tengu_ccr_bridge` GrowthBook value).
    fn bridge_fixture(
        enabled: bool,
        explicit: bool,
        connected: bool,
        session_active: bool,
        reconnecting: bool,
    ) -> crate::state::app_state_store::AppState {
        let mut state = crate::state::app_state_store::AppState::default();
        state.repl_bridge_enabled = enabled;
        state.repl_bridge_explicit = explicit;
        state.repl_bridge_connected = connected;
        state.repl_bridge_session_active = session_active;
        state.repl_bridge_reconnecting = reconnecting;
        state
    }

    #[test]
    fn bridge_status_indicator_matches_official_footer_visibility_and_copy() {
        // Gate args mirror PromptInputFooter.tsx:241 feature('BRIDGE_MODE')
        // and :255 isBridgeEnabled().
        let explicit_connected = bridge_fixture(true, true, true, false, false);
        assert!(bridge_status_indicator(&explicit_connected, false, true, false).is_none());
        assert!(bridge_status_indicator(&explicit_connected, true, false, false).is_none());
        assert!(
            bridge_status_indicator(
                &bridge_fixture(false, true, true, false, false),
                true,
                true,
                false,
            )
            .is_none()
        );
        assert!(
            bridge_status_indicator(
                &bridge_fixture(true, false, true, false, false),
                true,
                true,
                false,
            )
            .is_none()
        );

        let active = bridge_status_indicator(
            &bridge_fixture(true, true, false, true, false),
            true,
            true,
            false,
        )
        .unwrap();
        assert_eq!(active.text, "Remote Control active");
        assert_eq!(active.segments[0].color, Some(NotificationColor::Success));
        assert!(!active.inverse);

        let connecting = bridge_status_indicator(
            &bridge_fixture(true, true, false, false, false),
            true,
            true,
            false,
        )
        .unwrap();
        assert_eq!(connecting.text, "Remote Control connecting…");
        assert_eq!(
            connecting.segments[0].color,
            Some(NotificationColor::Warning)
        );
    }

    #[test]
    fn bridge_status_indicator_allows_implicit_reconnecting_and_selected_suffix() {
        let reconnecting = bridge_status_indicator(
            &bridge_fixture(true, false, false, false, true),
            true,
            true,
            true,
        )
        .unwrap();

        assert_eq!(
            reconnecting.text,
            "Remote Control reconnecting · Enter to view"
        );
        assert_eq!(
            reconnecting.segments[0].color,
            Some(NotificationColor::Warning)
        );
        assert!(reconnecting.segments[1].dim);
        assert!(reconnecting.inverse);
    }
}
