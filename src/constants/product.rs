pub const NAME: &str = "nyan";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Official Claude Code version reported in HTTP User-Agent.
/// Intentionally pinned (not `CARGO_PKG_VERSION`) so API-facing identity
/// stays `claude-cli/2.1.241`, independent of the Nyan crate version.
pub const USER_AGENT_VERSION: &str = "2.1.241";
pub const DESCRIPTION: &str = "Terminal-based AI coding assistant";
/// Maps to: CC `constants/product.ts#PRODUCT_URL`.
pub const PRODUCT_URL: &str = "https://github.com/blxzer77/nyan";
