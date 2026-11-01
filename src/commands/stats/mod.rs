//! Maps to: CC `commands/stats/index.ts`.

pub mod stats;

pub const NAME: &str = "stats";
pub const DESCRIPTION: &str = "Show your nyan usage statistics and activity";

pub use stats::call;
