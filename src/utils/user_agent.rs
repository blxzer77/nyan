//! User-Agent string helpers.
//!
//! The wire value is [`crate::utils::http::user_agent`]. This name remains so
//! older call sites keep compiling.

pub fn get_claude_code_user_agent() -> String {
    crate::utils::http::user_agent()
}

#[cfg(test)]
mod tests {
    #[test]
    fn claude_code_user_agent_is_the_shared_nyan_agent() {
        assert_eq!(
            super::get_claude_code_user_agent(),
            crate::utils::http::user_agent()
        );
    }
}
