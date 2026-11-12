# Vendored iocraft

This directory is the `iocraft` crate (`packages/iocraft`) of
[Haleclipse/CometixTUI](https://github.com/Haleclipse/CometixTUI) at commit
`ec7c06155482815a4b4a99be5ad4c62675a632a1`, the commit nyan's `Cargo.lock`
pins for the rest of that repository. CometixTUI is a fork of
[ccbrown/iocraft](https://github.com/ccbrown/iocraft), licensed MIT OR
Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`, copied from the repository root).

nyan's `Cargo.toml` substitutes it with
`[patch."https://github.com/Haleclipse/CometixTUI"]`. Only `iocraft` is
vendored; `chalk` and `iocraft-macros` still resolve from the locked git commit.

## Differences from upstream

- `Cargo.toml`: `chalk` and `iocraft-macros` are `git` dependencies instead of
  `path = "../…"`, since their workspace siblings are not vendored.
- `README.md` (a symlink to the repository README upstream) is dropped.
- 32-bit draw coordinates. Upstream draws with `Point<i16>` / `Size<u16>` /
  `Rect<u16>` and casts Taffy's `f32` layout into them, so a node starting
  past row 32767 lands at a negative `y` and is clipped, while the canvas
  keeps the real height: a long inline transcript renders as blank rows.
  - `render.rs`: `ComponentDrawer` position/size/clip and `LayoutSnapshot` are
    `i32` / `u32`; `size()`, `content_size()`, `visible_size()`,
    `remaining_canvas_size()` return `Size<u32>`, `canvas_position()` returns
    `Point<i32>`.
  - `terminal/backend.rs`: inline row bookkeeping (`prev_canvas_height`,
    `cursor_displacement_rows`, `inline_bottom_gap`) is `usize`; relative line
    moves are split into `u16`-sized CSI steps (`queue_line_moves`), and
    `clear_canvas_inline` no longer underflows at height 0.
  - Callers adapted: `use_terminal_events` (mouse hit-test), `cached_subtree`,
    `offscreen_freeze`, `scroll_view`, `text_input`. ScrollView's public
    heights stay `u16` and saturate at `u16::MAX`.

Regression tests live in nyan (`src/utils/iocraft_tall_canvas_tests.rs`),
because a non-member path dependency's own tests are not run by nyan's CI.
