//! Maps to: CC `components/Spinner/ShimmerChar.tsx`.

use crate::utils::theme::{Theme, ThemeColorKey};
use iocraft::prelude::*;

#[derive(Default, Props)]
pub struct ShimmerCharProps {
    pub character: String,
    pub index: isize,
    pub glimmer_index: isize,
    pub message_color: Option<ThemeColorKey>,
    pub shimmer_color: Option<ThemeColorKey>,
}

#[component]
pub fn ShimmerChar(props: &ShimmerCharProps, hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let theme = hooks.use_context::<Theme>();
    let use_shimmer = props.index.abs_diff(props.glimmer_index) <= 1;
    let message_color = props.message_color.unwrap_or(ThemeColorKey::Nyan);
    let shimmer_color = props.shimmer_color.unwrap_or(ThemeColorKey::NyanShimmer);
    element!(Text(
        content: props.character.clone(),
        color: theme.color(if use_shimmer { shimmer_color } else { message_color }),
        wrap: TextWrap::NoWrap,
    ))
}
