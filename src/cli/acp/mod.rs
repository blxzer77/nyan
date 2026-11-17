//! `nyan acp`: the agent side of ACP (Agent Client Protocol) v1.
//!
//! The protocol is JSON-RPC 2.0, one JSON message per line over stdin and stdout.
//! Stdout carries protocol messages only; any logs must go to stderr, or they
//! corrupt the protocol stream.
//!
//! Implements `initialize`, `session/new` and `session/prompt`, and handles the
//! `session/cancel` notification while a prompt is running. Other requests get a
//! `Method not found` reply. Sessions run on the real engine (see `engine`). One process
//! serves one session, in the directory it was started in.

mod engine;
mod server;
mod session;
mod tools;
mod transport;

/// Usage text for `nyan acp`.
pub const HELP: &str = "\
Usage: nyan acp

Run nyan as an ACP (Agent Client Protocol) agent over stdio.
Reads JSON-RPC 2.0 messages from stdin, one per line, and writes responses
to stdout. Takes no arguments. Logs go to stderr only.
The process serves one session, in the directory it was started in.
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
    // Process-level startup must run before the runtime exists, as in `print::run`.
    if let Err(error) = crate::cli::print::init_headless_process(&engine_config) {
        eprintln!("nyan acp: {error}");
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
    runtime.block_on(server::serve(
        tokio::io::BufReader::new(tokio::io::stdin()),
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
