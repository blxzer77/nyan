//! Maps to: CC `commands/plugin/index.tsx`.
//! All local JSX routes delegate to the source-owned PluginSettings view state.
pub mod parse_args;
pub mod plugin;
pub mod plugin_settings;
pub mod use_pagination;
pub mod validate_plugin;

/// Maps to: CC `commands/plugin/index.tsx:3-10` default descriptor.
pub fn command() -> crate::commands::Command {
    crate::commands::Command::local_ui("plugin", "Manage nyan plugins")
        .aliases(&["plugins", "marketplace"])
        .immediate()
        .executable(dispatch)
}

/// Native executable transport for plugin.tsx#call.
/// Domain routing remains PluginSettings.getInitialViewState.
fn dispatch(
    command: &crate::commands::Command,
    args: &str,
    _uuid: Option<String>,
    _context: &crate::tool::ToolUseContext,
) -> crate::utils::process_user_input::ProcessUserInputBaseResult {
    use crate::utils::process_user_input::ProcessUserInputBaseResult;
    use crate::utils::process_user_input::process_slash_command::{
        LocalCommandUi, SlashCommandAction, SlashCommandInvocation,
    };
    ProcessUserInputBaseResult {
        messages: Vec::new(),
        should_query: false,
        allowed_tools: None,
        local_action: Some(SlashCommandAction::OpenLocalCommandUi {
            command: LocalCommandUi::PluginSettings {
                data: plugin::call(Some(args)),
                preceding_input_blocks: Vec::new(),
            },
            invocation: SlashCommandInvocation::new(
                crate::commands::get_command_name(command),
                args,
            ),
        }),
        query_source: crate::constants::query_source::QuerySource::Prompt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plugin_routes_all_source_arguments_to_local_ui_without_model_query() {
        let command = command();
        assert!(command.immediate);
        assert_eq!(
            command.aliases,
            vec!["plugins".to_string(), "marketplace".to_string()]
        );
        let context = crate::tool::ToolUseContext::default();
        let validation = dispatch(&command, "validate a b", None, &context);
        assert!(validation.messages.is_empty());
        assert!(!validation.should_query);
        assert!(matches!(validation.local_action, Some(crate::utils::process_user_input::process_slash_command::SlashCommandAction::OpenLocalCommandUi { command: crate::utils::process_user_input::process_slash_command::LocalCommandUi::PluginSettings { .. }, .. })));
        for args in ["help", "--help", "-h", "marketplace list", "market list"] {
            let result = dispatch(&command, args, None, &context);
            assert!(matches!(result.local_action, Some(crate::utils::process_user_input::process_slash_command::SlashCommandAction::OpenLocalCommandUi { command: crate::utils::process_user_input::process_slash_command::LocalCommandUi::PluginSettings { .. }, .. })));
            assert!(result.messages.is_empty());
            assert!(!result.should_query);
        }
        for args in ["", "install", "marketplace", "marketplace add", "manage"] {
            let result = dispatch(&command, args, None, &context);
            assert!(matches!(result.local_action, Some(crate::utils::process_user_input::process_slash_command::SlashCommandAction::OpenLocalCommandUi { command: crate::utils::process_user_input::process_slash_command::LocalCommandUi::PluginSettings { .. }, .. })));
            assert!(result.messages.is_empty());
            assert!(!result.should_query);
        }
    }
}

pub mod add_marketplace;
pub mod browse_marketplace;
pub mod discover_plugins;
pub mod manage_plugins;
pub mod plugin_details_helpers;
pub mod plugin_errors;
pub mod plugin_options_dialog;
pub mod plugin_options_flow;
pub mod plugin_trust_warning;
pub mod unified_installed_cell;
pub mod unified_types;

pub mod manage_marketplaces;
