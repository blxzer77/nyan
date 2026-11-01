//! Teammate model fallback.
//! Maps to: CC `utils/swarm/teammateModel.ts`.
//!
//! CC's file declares EXACTLY ONE symbol. `getDefaultTeammateModel` and
//! `resolveTeammateModel` are declared in `tools/shared/spawnMultiAgent.ts`
//! (`:72` / `:93`) and live in `tools/shared/spawn_multi_agent.rs` here — a
//! symbol belongs to the Rust file named after the CC file that DECLARES it,
//! regardless of which file references it.

/// Maps to: CC `utils/swarm/teammateModel.ts#getHardcodedTeammateModelFallback`.
///
/// CC uses provider-specific `CLAUDE_OPUS_4_6_CONFIG[getAPIProvider()]`.
/// Nyan keeps provider-specific defaults inside `utils/model/model.rs`; the
/// Opus helper is therefore the equivalent hardcoded teammate fallback.
pub fn get_hardcoded_teammate_model_fallback() -> String {
    crate::utils::model::model::get_default_opus_model()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardcoded_teammate_model_fallback_is_opus_like_official() {
        assert!(get_hardcoded_teammate_model_fallback().contains("opus"));
    }
}
