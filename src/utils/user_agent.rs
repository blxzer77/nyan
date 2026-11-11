//! User-Agent string helpers.
//!
//! The wire value is [`crate::utils::http::user_agent`].

pub fn get_nyan_user_agent() -> String {
    crate::utils::http::user_agent()
}

#[cfg(test)]
mod tests {
    #[test]
    fn nyan_user_agent_is_the_shared_nyan_agent() {
        assert_eq!(
            super::get_nyan_user_agent(),
            crate::utils::http::user_agent()
        );
    }
}
