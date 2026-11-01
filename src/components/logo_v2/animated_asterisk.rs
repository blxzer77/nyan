//! Maps to: CC `components/LogoV2/AnimatedAsterisk.tsx`.
//!
//! Official uses the shared animation-frame clock for a two-pass hue sweep and
//! settles to grey. nyan keeps the component boundary and settled rendering;
//! live hue animation remains deferred until LogoV2 onboarding notices are
//! wired into the shared animation clock.

use crate::constants::figures::TEARDROP_ASTERISK;
use iocraft::prelude::*;

pub const SWEEP_DURATION_MS: u64 = 1500;
pub const SWEEP_COUNT: u64 = 2;
pub const TOTAL_ANIMATION_MS: u64 = SWEEP_DURATION_MS * SWEEP_COUNT;
pub const SETTLED_GREY: Color = Color::Rgb {
    r: 153,
    g: 153,
    b: 153,
};

#[derive(Default, Props)]
pub struct AnimatedAsteriskProps {
    pub ch: Option<String>,
}

#[component]
pub fn AnimatedAsterisk(props: &AnimatedAsteriskProps) -> impl Into<AnyElement<'static>> {
    let ch = props
        .ch
        .clone()
        .unwrap_or_else(|| TEARDROP_ASTERISK.to_string());
    element! {
        View {
            Text(content: ch, color: SETTLED_GREY, wrap: TextWrap::NoWrap)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn animated_asterisk_preserves_official_timing_constants() {
        assert_eq!(SWEEP_DURATION_MS, 1500);
        assert_eq!(SWEEP_COUNT, 2);
        assert_eq!(TOTAL_ANIMATION_MS, 3000);
        assert_eq!(
            SETTLED_GREY,
            Color::Rgb {
                r: 153,
                g: 153,
                b: 153
            }
        );
    }

    #[test]
    fn animated_asterisk_renders_default_and_custom_chars() {
        let default_text = element! { AnimatedAsterisk }.render(Some(10)).to_string();
        assert!(default_text.contains("✻"), "canvas=\n{default_text}");

        let custom_text = element! { AnimatedAsterisk(ch: Some("↑".to_string())) }
            .render(Some(10))
            .to_string();
        assert!(custom_text.contains("↑"), "canvas=\n{custom_text}");
    }
}
