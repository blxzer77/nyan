//! Maps to: CC `keybindings/match.ts` — the terminal-event → keystroke
//! bridge. CC receives Ink's `(input, Key)` pair; Nyan receives
//! crossterm's `KeyEvent` (re-exported through iocraft).
//!
//! Behavior notes vs CC:
//! - Alt/Meta: crossterm reports ALT for both ESC-prefixed alt sequences and
//!   kitty-protocol alt; both fold into `alt` here, matching the resolver's
//!   alt/meta collapse (CC modifiersMatch does the same on `key.meta`).
//! - The CC escape quirk (Ink sets `key.meta = true` for a bare Escape) is
//!   an Ink parser legacy; crossterm reports a bare Esc without modifiers,
//!   so no quirk compensation is needed here.
//! - Wheel events are not key events in iocraft; the ChordInterceptor layer
//!   skips them the way CC's does.

use iocraft::prelude::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::types::ParsedKeystroke;

/// Maps to: CC `getKeyName` + `getInkModifiers` combined. Returns `None`
/// for events the binding system cannot address (releases, IME, F-keys
/// beyond the named set, media keys).
pub fn key_event_to_keystroke(event: &KeyEvent) -> Option<ParsedKeystroke> {
    if event.kind == KeyEventKind::Release {
        return None;
    }

    let key: String = match event.code {
        KeyCode::Esc => "escape".into(),
        KeyCode::Enter => "enter".into(),
        KeyCode::Tab | KeyCode::BackTab => "tab".into(),
        KeyCode::Backspace => "backspace".into(),
        KeyCode::Delete => "delete".into(),
        KeyCode::Up => "up".into(),
        KeyCode::Down => "down".into(),
        KeyCode::Left => "left".into(),
        KeyCode::Right => "right".into(),
        KeyCode::PageUp => "pageup".into(),
        KeyCode::PageDown => "pagedown".into(),
        KeyCode::Home => "home".into(),
        KeyCode::End => "end".into(),
        KeyCode::F(n) => format!("f{n}"),
        KeyCode::Char(c) => c.to_lowercase().to_string(),
        _ => return None,
    };

    // BackTab arrives as its own code with SHIFT implied by some terminals
    // but not others; normalize so `shift+tab` bindings always match.
    let backtab_shift = matches!(event.code, KeyCode::BackTab);

    Some(ParsedKeystroke {
        key,
        ctrl: event.modifiers.contains(KeyModifiers::CONTROL),
        // crossterm ALT covers both legacy ESC-prefix alt and kitty alt;
        // META arrives only from kitty-protocol terminals. Fold both into
        // `alt` — the resolver treats alt/meta as one logical modifier.
        alt: event
            .modifiers
            .intersects(KeyModifiers::ALT | KeyModifiers::META),
        shift: event.modifiers.contains(KeyModifiers::SHIFT) || backtab_shift,
        meta: false,
        super_key: event.modifiers.contains(KeyModifiers::SUPER),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybindings::parser::parse_keystroke;
    use crate::keybindings::resolver::keystrokes_equal;

    fn press(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        let mut event = KeyEvent::new(KeyEventKind::Press, code);
        event.modifiers = modifiers;
        event
    }

    #[test]
    fn named_keys_map_to_cc_key_names() {
        let esc = key_event_to_keystroke(&press(KeyCode::Esc, KeyModifiers::NONE)).unwrap();
        assert_eq!(esc.key, "escape");
        assert!(!esc.alt, "crossterm bare Esc has no Ink meta quirk");

        let enter = key_event_to_keystroke(&press(KeyCode::Enter, KeyModifiers::NONE)).unwrap();
        assert_eq!(enter.key, "enter");
    }

    #[test]
    fn char_keys_lowercase_and_keep_shift_flag() {
        let upper =
            key_event_to_keystroke(&press(KeyCode::Char('A'), KeyModifiers::SHIFT)).unwrap();
        assert_eq!(upper.key, "a");
        assert!(upper.shift);
    }

    #[test]
    fn ctrl_c_matches_parsed_binding_keystroke() {
        let event =
            key_event_to_keystroke(&press(KeyCode::Char('c'), KeyModifiers::CONTROL)).unwrap();
        assert!(keystrokes_equal(&event, &parse_keystroke("ctrl+c")));
    }

    #[test]
    fn alt_and_kitty_meta_both_fold_into_alt() {
        let alt = key_event_to_keystroke(&press(KeyCode::Char('v'), KeyModifiers::ALT)).unwrap();
        let meta = key_event_to_keystroke(&press(KeyCode::Char('v'), KeyModifiers::META)).unwrap();
        assert!(keystrokes_equal(&alt, &parse_keystroke("alt+v")));
        assert!(keystrokes_equal(&meta, &parse_keystroke("meta+v")));
        assert!(keystrokes_equal(&alt, &meta));
    }

    #[test]
    fn shift_tab_matches_mode_cycle_binding_via_backtab() {
        let backtab = key_event_to_keystroke(&press(KeyCode::BackTab, KeyModifiers::NONE)).unwrap();
        assert!(keystrokes_equal(&backtab, &parse_keystroke("shift+tab")));
    }

    #[test]
    fn release_events_are_ignored() {
        let mut event = press(KeyCode::Char('a'), KeyModifiers::NONE);
        event.kind = KeyEventKind::Release;
        assert!(key_event_to_keystroke(&event).is_none());
    }
}
