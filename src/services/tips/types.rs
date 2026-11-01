//! Maps to: CC `services/tips/types.ts` (usage-inferred Tip / TipContext).

/// Maps to: CC `Tip` — spinner tip identity + already-resolved copy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tip {
    pub id: String,
    pub content: String,
    pub cooldown_sessions: u64,
}

/// Optional context for tip relevance. Nyan passes what the REPL already
/// knows; full CC TipContext (theme / readFileState / bashTools) can grow here.
#[derive(Clone, Debug, Default)]
pub struct TipContext {
    pub num_startups: u64,
}
