//! Maps to: CC `utils/awsAuthStatusManager.ts`.
//!
//! The legacy AWS name is preserved for parity; CC uses this singleton for all
//! cloud-provider auth refresh status (Bedrock and Vertex). Nyan keeps the
//! same state transitions in a process-global mutex. React-style subscriptions
//! are represented by polling `get_status()` from render boundaries for now.

use std::sync::{LazyLock, Mutex};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AwsAuthStatus {
    pub is_authenticating: bool,
    pub output: Vec<String>,
    pub error: Option<String>,
}

static STATUS: LazyLock<Mutex<AwsAuthStatus>> =
    LazyLock::new(|| Mutex::new(AwsAuthStatus::default()));

/// Maps to: CC `AwsAuthStatusManager.getStatus`.
pub fn get_status() -> AwsAuthStatus {
    STATUS
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

/// Maps to: CC `AwsAuthStatusManager.startAuthentication`.
pub fn start_authentication() {
    if let Ok(mut status) = STATUS.lock() {
        *status = AwsAuthStatus {
            is_authenticating: true,
            output: Vec::new(),
            error: None,
        };
    }
}

/// Maps to: CC `AwsAuthStatusManager.addOutput`.
pub fn add_output(line: impl Into<String>) {
    if let Ok(mut status) = STATUS.lock() {
        status.output.push(line.into());
    }
}

/// Maps to: CC `AwsAuthStatusManager.setError`.
pub fn set_error(error: impl Into<String>) {
    if let Ok(mut status) = STATUS.lock() {
        status.error = Some(error.into());
    }
}

/// Maps to: CC `AwsAuthStatusManager.endAuthentication`.
pub fn end_authentication(success: bool) {
    if let Ok(mut status) = STATUS.lock() {
        if success {
            *status = AwsAuthStatus::default();
        } else {
            status.is_authenticating = false;
        }
    }
}

/// Maps to: CC `AwsAuthStatusManager.reset`.
pub fn reset() {
    if let Ok(mut status) = STATUS.lock() {
        *status = AwsAuthStatus::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aws_auth_status_manager_matches_official_state_transitions() {
        reset();
        start_authentication();
        assert_eq!(
            get_status(),
            AwsAuthStatus {
                is_authenticating: true,
                output: Vec::new(),
                error: None,
            }
        );

        add_output("open https://example.com");
        set_error("failed");
        end_authentication(false);
        assert_eq!(
            get_status(),
            AwsAuthStatus {
                is_authenticating: false,
                output: vec!["open https://example.com".to_string()],
                error: Some("failed".to_string()),
            }
        );

        start_authentication();
        add_output("ok");
        end_authentication(true);
        assert_eq!(get_status(), AwsAuthStatus::default());
    }
}
