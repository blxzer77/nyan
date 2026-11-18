//! `nyan acp`: the agent side of ACP (Agent Client Protocol) v1.
//!
//! The protocol is JSON-RPC 2.0, one JSON message per line over stdin and stdout.
//! Stdout carries protocol messages only; any logs must go to stderr, or they
//! corrupt the protocol stream.
//!
//! This is a skeleton: only `initialize` is implemented; other requests get a
//! `Method not found` reply.

mod server;
mod transport;

/// Usage text for `nyan acp`.
pub const HELP: &str = "\
Usage: nyan acp

Run nyan as an ACP (Agent Client Protocol) agent over stdio.
Reads JSON-RPC 2.0 messages from stdin, one per line, and writes responses
to stdout. Takes no arguments. Logs go to stderr only.
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

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("nyan acp: failed to start runtime: {err}");
            return 1;
        }
    };
    runtime.block_on(server::serve(
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
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
