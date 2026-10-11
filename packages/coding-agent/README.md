# Nyan

Nyan is a minimal, extensible agent harness that you can make your own.

Adapt Nyan to your workflows, not the other way around. Customize Nyan with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Nyan packages](docs/packages.md) and share via npm or git.

Nyan ships with powerful defaults but skips features like sub-agents and plan mode. Ask Nyan to build what you want, or install a package that does it your way.

Use Nyan [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Nyan TypeScript SDK](docs/sdk.md).

## Getting started

Install the command-line interface from npm. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @nyan/coding-agent
```

Nyan does not require dependency lifecycle scripts for a normal npm installation. See the [quickstart](docs/quickstart.md#1-install-nyan) for updating and pinning releases.

Start Nyan in the directory where you want it to work:

```bash
cd /path/to/project
nyan
```

For a built-in AI provider, run `/login` inside Nyan to connect a subscription or API key. Then give Nyan a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Share your OSS coding agent sessions

If you use Nyan for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) using a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish Nyan sessions
- Published Nyan development sessions: [`badlogicgames/nyan-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/nyan-mono).

## Development

Clone the repository, install its dependencies, and run Nyan from source:

```bash
git clone https://github.com/blxzer77/nyan
cd nyan
npm install --ignore-scripts
./nyan-test.sh
```

`nyan-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/blxzer77/nyan/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/blxzer77/nyan/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
