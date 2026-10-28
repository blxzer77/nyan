pub const CODE_SEARCH_TOOL_NAME: &str = "CodeSearch";

pub const DESCRIPTION: &str = "Search the current codebase using exact, symbol, text, and optional semantic retrieval. Use this for natural-language code questions, definitions, callers, and dependencies. Results are verified against the current worktree.";

pub fn get_description() -> String {
    DESCRIPTION.to_string()
}
