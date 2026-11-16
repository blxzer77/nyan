//! Maps to: CC `components/Spinner/FlashingChar.tsx`.

use super::utils::interpolate_terminal_color;
use crate::utils::theme::{Theme, ThemeColorKey};
use iocraft::prelude::*;

#[derive(Default, Props)]
pub struct FlashingCharProps {
    pub character: String,
    pub flash_opacity: f32,
    pub message_color: Option<ThemeColorKey>,
    pub shimmer_color: Option<ThemeColorKey>,
}

#[component]
pub fn FlashingChar(props: &FlashingCharProps, hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let color = interpolate_terminal_color(
        theme.color(props.message_color.unwrap_or(ThemeColorKey::Nyan)),
        theme.color(props.shimmer_color.unwrap_or(ThemeColorKey::NyanShimmer)),
        props.flash_opacity.clamp(0.0, 1.0),
    );
    element!(Text(content: props.character.clone(), color: color, wrap: TextWrap::NoWrap))
}
