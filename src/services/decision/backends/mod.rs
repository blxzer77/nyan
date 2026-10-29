//! Decision backends.
//!
//! One protocol: System One (decision-provider.md §5). [`system_one`] holds
//! the reusable client and transport seam; [`emrank`] is the first provider
//! built on it. `chat` (a different protocol) and `local` are later slices.

pub mod emrank;
pub mod system_one;
