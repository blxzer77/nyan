//! @nyan: Anthropic Messages adapter (provider redesign PR 4).
//!
//! Everything Anthropic-specific lives here: the SDK client factory for
//! Direct/Bedrock/Vertex/Foundry, outbound headers, beta flags, and (in later
//! commits) request/stream translation. Callers outside this module see only
//! the adapter contract in `services::provider::adapter`.

pub mod betas;
pub mod client;
pub mod headers;
