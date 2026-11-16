//! Regression tests for transcripts taller than 16-bit terminal coordinates.
//!
//! iocraft used to carry draw positions as `i16` and inline row bookkeeping as
//! `u16`. A node starting past row 32767 was drawn at a wrapped, negative `y`
//! and clipped away, while the canvas kept the real layout height, so an
//! inline session past that length rendered a screen of blank rows. The
//! vendored copy (`vendor/iocraft/NYAN.md`) widens both.

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use iocraft::prelude::*;

fn column_of_rows(rows: usize) -> AnyElement<'static> {
    element! {
        View(flex_direction: FlexDirection::Column) {
            #((0..rows).map(|n| element! { Text(content: format!("row {n}")) }))
        }
    }
    .into_any()
}

fn assert_rows_drawn(rows: usize) {
    let canvas = column_of_rows(rows).render(Some(60));
    let text = canvas.to_string();
    let lines: Vec<&str> = text.lines().collect();

    assert_eq!(canvas.height(), rows);
    assert_eq!(lines.len(), rows, "the canvas has trailing blank rows");
    for n in [0, 32_767, 32_768, rows - 1] {
        assert_eq!(lines[n].trim_end(), format!("row {n}"));
    }
}

#[test]
fn rows_past_i16_max_are_drawn_in_place() {
    assert_rows_drawn(40_000);
}

#[test]
fn rows_past_u16_max_are_drawn_in_place() {
    assert_rows_drawn(70_000);
}

const TALL: usize = 70_000;

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Frame 1: `TALL` rows with the cursor declared on row 0, so the inline
/// backend moves up `TALL - 1` rows. Frame 2: two rows, written after moving
/// back down to the old canvas bottom. Then exits.
#[component]
fn TallThenShort(mut hooks: Hooks) -> impl Into<AnyElement<'static>> {
    let mut tall = hooks.use_state(|| true);
    let mut system = hooks.use_context_mut::<SystemContext>();
    hooks.use_declared_cursor(0, 0, tall.get());
    hooks.use_future(async move { tall.set(false) });
    if !tall.get() {
        system.exit();
    }
    column_of_rows(if tall.get() { TALL } else { 2 })
}

#[test]
fn inline_cursor_moves_past_u16_max_do_not_wrap() {
    let out = Capture::default();
    futures::executor::block_on(
        element!(TallThenShort)
            .render_loop()
            .without_throttle()
            .stdout(out.clone()),
    )
    .unwrap();

    let bytes = out.0.lock().unwrap();
    let output = String::from_utf8_lossy(&bytes);
    // `TALL - 1` rows, in steps a CSI count can carry. A `u16` height would
    // have wrapped to 70_000 - 65_536 = 4_464 rows.
    let (max, rest) = (u16::MAX, TALL - 1 - u16::MAX as usize);
    let up = format!("\x1b[{max}F\x1b[{rest}F");
    let down = format!("\x1b[{max}E\x1b[{rest}E");
    assert!(output.contains(&up), "missing cursor move up {up:?}");
    assert!(output.contains(&down), "missing cursor move down {down:?}");
    assert!(output.contains("row 69999"));
}
