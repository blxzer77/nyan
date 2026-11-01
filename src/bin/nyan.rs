//! Rust process entry — not a CC source file.
//!
//! Maps to: Node loading `entrypoints/cli.tsx` (`void main()`).
//! CC `main.tsx` lives at [`nyan::main`].

fn main() {
    if let Some(code) =
        nyan::utils::sandbox::sandbox_adapter::run_linux_seccomp_helper_if_requested()
    {
        nyan::utils::cleanup_registry::exit_process(code);
    }
    nyan::entrypoints::cli::run();
    nyan::utils::cleanup_registry::run_cleanup_functions_sync();
}
