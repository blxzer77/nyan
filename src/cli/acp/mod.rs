//! `nyan acp`: the agent side of ACP (Agent Client Protocol) v1.
//!
//! The protocol is JSON-RPC 2.0, one JSON message per line over stdin and stdout.
//! Stdout carries protocol messages only; any logs must go to stderr, or they
//! corrupt the protocol stream.
//!
//! Implements `initialize`, `session/new` and `session/prompt`, and handles the
//! `session/cancel` notification while a prompt is running. Other requests get a
//! `Method not found` reply. Sessions run on the real engine (see `engine`). One process
//! serves one session, in the `cwd` its `session/new` names: the process waits for that
//! request before it initializes (see `startup`).
//!
//! Tool calls that need approval ask the client with `session/request_permission` and
//! wait for its choice (see `permission`). The client's answer is routed back to the
//! request it answers. When input ends, requests still waiting for an answer fail.

mod config_options;
mod engine;
mod modes;
mod permission;
mod server;
mod session;
mod startup;
mod tools;
mod transport;

/// Usage text for `nyan acp`.
pub const HELP: &str = "\
Usage: nyan acp

Run nyan as an ACP (Agent Client Protocol) agent over stdio.
Reads JSON-RPC 2.0 messages from stdin, one per line, and writes responses
to stdout. Takes no arguments. Logs go to stderr only.
The process serves one session, in the directory its session/new names.
";

/// Outcome of parsing `nyan acp` arguments.
#[derive(Debug, PartialEq, Eq)]
enum Invocation {
    Serve,
    Help,
    Invalid(String),
}

fn parse_args(args: &[String]) -> Invocation {
    if args.is_empty() {
        return Invocation::Serve;
    }
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Invocation::Help;
    }
    Invocation::Invalid(args[0].clone())
}

/// Runs the ACP service over stdio on the current process, returning the exit code.
pub fn run(config: &crate::cli::CliConfig) -> i32 {
    match parse_args(&config.subcommand_args) {
        Invocation::Help => {
            print!("{HELP}");
            return 0;
        }
        Invocation::Invalid(arg) => {
            eprintln!("nyan acp: unexpected argument '{arg}'");
            eprint!("{HELP}");
            return 2;
        }
        Invocation::Serve => {}
    }

    let engine_config = engine::engine_cli_config();
    // Process init reads settings from the working directory, so it waits for the
    // directory `session/new` names. Until then the main thread answers on its own.
    let first_session = {
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        startup::await_first_session(stdin.lock(), &mut stdout, startup::enter_session_dir)
    };
    let (session_id, session_request) = match first_session {
        startup::Startup::Session { id, line } => (id, line),
        startup::Startup::Ended(code) => return code,
    };
    // Process-level startup must run before the runtime exists, as in `print::run`.
    if let Err(error) = crate::cli::print::init_headless_process(&engine_config) {
        eprintln!("nyan acp: {error}");
        // Answer the waiting `session/new` before exiting, so the client sees why.
        let failure = transport::RpcError::new(transport::INTERNAL_ERROR, error);
        let message = transport::response_message(session_id, Err(failure));
        let _ = startup::write_message(&mut std::io::stdout(), &message);
        return 1;
    }
    let launch_cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            eprintln!("nyan acp: failed to read the working directory: {err}");
            return 1;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("nyan acp: failed to start runtime: {err}");
            return 1;
        }
    };
    // Publish this runtime as the process runtime, as `print::run` does.
    crate::utils::process_runtime::set_process_runtime_handle(runtime.handle().clone());
    // The `session/new` read above comes first, then the rest of stdin. Both readers
    // share std's stdin buffer, so nothing read ahead is lost.
    let first = std::io::Cursor::new(format!("{session_request}\n").into_bytes());
    let input = tokio::io::AsyncReadExt::chain(first, tokio::io::stdin());
    runtime.block_on(server::serve(
        tokio::io::BufReader::new(input),
        tokio::io::stdout(),
        engine::EngineHost::new(engine_config, launch_cwd),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_parse_args_recognises_help_and_rejects_extras() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        assert_eq!(parse_args(&args(&[])), Invocation::Serve);
        assert_eq!(parse_args(&args(&["--help"])), Invocation::Help);
        assert_eq!(parse_args(&args(&["-h"])), Invocation::Help);
        assert_eq!(parse_args(&args(&["bogus", "--help"])), Invocation::Help);
        assert_eq!(
            parse_args(&args(&["bogus"])),
            Invocation::Invalid("bogus".to_string())
        );
    }
}
