//! The model and the thinking effort as ACP session config options.
//!
//! `model` (category `model`) picks one of the profiles in `settings.nyan.models`, and
//! `thought_level` (category `thought_level`) picks the effort: off, medium, high or max.
//! Picking a model resets the effort to that profile's own, as the TUI model picker does.
//!
//! A change takes effect at the start of the next prompt turn, because the engine applies
//! a new profile and effort when a query starts.

use std::sync::{Arc, Mutex, MutexGuard};

use agent_client_protocol_schema::v1::{
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
};

use crate::utils::effort::Effort;

/// Id of the model option.
pub(super) const MODEL: &str = "model";
/// Id of the thinking effort option.
pub(super) const THOUGHT_LEVEL: &str = "thought_level";

/// One configured model profile.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Profile {
    /// The profile name, as in `settings.nyan.models`.
    pub name: String,
    /// What the client shows.
    pub display_name: String,
    /// The model id the profile calls.
    pub model: String,
    /// The effort the profile runs at unless the session picks another.
    pub effort: Effort,
}

/// Changes the next prompt turn has to apply, in this order.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Pending {
    /// Switch to this profile, at its own effort.
    pub profile: Option<String>,
    /// Then run at this effort.
    pub effort: Option<Effort>,
}

/// A session's model and effort options.
pub(super) struct ConfigOptions {
    profiles: Vec<Profile>,
    profile: String,
    effort: Effort,
    pending: Pending,
}

/// Shared between the session and the switch handle the server calls.
pub(super) type SharedConfigOptions = Arc<Mutex<ConfigOptions>>;

impl ConfigOptions {
    /// The options for a session on `profile` at `effort`. `None` when no profiles are
    /// configured, or `profile` is not one of them.
    pub(super) fn new(profiles: Vec<Profile>, profile: &str, effort: Effort) -> Option<Self> {
        profiles
            .iter()
            .any(|candidate| candidate.name == profile)
            .then(|| Self {
                profile: profile.to_string(),
                profiles,
                effort,
                pending: Pending::default(),
            })
    }

    /// The options as `session/new` and `session/set_config_option` report them.
    pub(super) fn options(&self) -> Vec<SessionConfigOption> {
        let models = self
            .profiles
            .iter()
            .map(|profile| {
                SessionConfigSelectOption::new(profile.name.clone(), profile.display_name.clone())
                    .description(profile.model.clone())
            })
            .collect::<Vec<_>>();
        let efforts = Effort::ALL
            .iter()
            .map(|effort| SessionConfigSelectOption::new(effort.as_str(), effort.title_label()))
            .collect::<Vec<_>>();
        vec![
            SessionConfigOption::select(MODEL, "Model", self.profile.clone(), models)
                .category(SessionConfigOptionCategory::Model),
            SessionConfigOption::select(THOUGHT_LEVEL, "Thinking", self.effort.as_str(), efforts)
                .description("How hard the model thinks before answering".to_string())
                .category(SessionConfigOptionCategory::ThoughtLevel),
        ]
    }

    /// Sets option `config_id` to `value`, for the next prompt turn to apply. Fails for an
    /// unknown option or a value it does not offer.
    pub(super) fn set(&mut self, config_id: &str, value: &str) -> Result<(), String> {
        match config_id {
            MODEL => {
                let profile = self
                    .profiles
                    .iter()
                    .find(|profile| profile.name == value)
                    .ok_or_else(|| format!("Unknown model: {value}"))?;
                self.profile = profile.name.clone();
                self.effort = profile.effort;
                // The profile switch resets the effort, so an earlier effort pick is dropped.
                self.pending = Pending {
                    profile: Some(profile.name.clone()),
                    effort: None,
                };
            }
            THOUGHT_LEVEL => {
                let effort = Effort::ALL
                    .into_iter()
                    .find(|effort| effort.as_str() == value)
                    .ok_or_else(|| format!("Unknown thinking level: {value}"))?;
                self.effort = effort;
                self.pending.effort = Some(effort);
            }
            _ => return Err(format!("Unknown config option: {config_id}")),
        }
        Ok(())
    }

    /// The changes the next prompt turn has to apply.
    pub(super) fn take_pending(&mut self) -> Pending {
        std::mem::take(&mut self.pending)
    }
}

/// Locks the options, recovering from a poisoned lock.
pub(super) fn lock_config(options: &SharedConfigOptions) -> MutexGuard<'_, ConfigOptions> {
    options
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn profiles() -> Vec<Profile> {
        vec![
            Profile {
                name: "sonnet".into(),
                display_name: "Claude Sonnet".into(),
                model: "claude-sonnet-5-5".into(),
                effort: Effort::High,
            },
            Profile {
                name: "fast".into(),
                display_name: "fast".into(),
                model: "deepseek-flash".into(),
                effort: Effort::Off,
            },
        ]
    }

    fn reported(options: &ConfigOptions) -> Value {
        serde_json::to_value(options.options()).unwrap()
    }

    #[test]
    fn acp_config_options_report_model_and_thought_level() {
        assert!(ConfigOptions::new(profiles(), "missing", Effort::High).is_none());
        assert!(ConfigOptions::new(Vec::new(), "sonnet", Effort::High).is_none());

        let options = ConfigOptions::new(profiles(), "sonnet", Effort::High).unwrap();
        let value = reported(&options);
        assert_eq!(value[0]["id"], json!("model"));
        assert_eq!(value[0]["category"], json!("model"));
        assert_eq!(value[0]["type"], json!("select"));
        assert_eq!(value[0]["currentValue"], json!("sonnet"));
        assert_eq!(
            value[0]["options"][0],
            json!({"value": "sonnet", "name": "Claude Sonnet", "description": "claude-sonnet-5-5"})
        );
        assert_eq!(value[1]["id"], json!("thought_level"));
        assert_eq!(value[1]["category"], json!("thought_level"));
        assert_eq!(value[1]["currentValue"], json!("high"));
        let levels: Vec<&str> = value[1]["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|option| option["value"].as_str().unwrap())
            .collect();
        assert_eq!(levels, ["off", "medium", "high", "max"]);
    }

    #[test]
    fn acp_config_options_switch_model_then_effort() {
        let mut options = ConfigOptions::new(profiles(), "sonnet", Effort::High).unwrap();
        assert_eq!(options.take_pending(), Pending::default());

        options.set(THOUGHT_LEVEL, "max").unwrap();
        // A model pick resets the effort to the profile's, dropping the earlier pick.
        options.set(MODEL, "fast").unwrap();
        let value = reported(&options);
        assert_eq!(value[0]["currentValue"], json!("fast"));
        assert_eq!(value[1]["currentValue"], json!("off"));
        assert_eq!(
            options.take_pending(),
            Pending {
                profile: Some("fast".into()),
                effort: None
            }
        );

        options.set(THOUGHT_LEVEL, "medium").unwrap();
        assert_eq!(
            options.take_pending(),
            Pending {
                profile: None,
                effort: Some(Effort::Medium)
            }
        );

        assert!(options.set(MODEL, "nope").is_err());
        assert!(options.set(THOUGHT_LEVEL, "low").is_err());
        assert!(options.set("speed", "fast").is_err());
        assert_eq!(options.take_pending(), Pending::default());
        assert_eq!(reported(&options)[1]["currentValue"], json!("medium"));
    }
}
