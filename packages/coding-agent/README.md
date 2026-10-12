# Nyan

Nyan is a minimal, extensible agent harness that you can make your own.

Adapt Nyan to your workflows, not the other way around. Customize Nyan with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Nyan packages](docs/packages.md) and share via npm or git.

Nyan ships with powerful defaults but skips features like sub-agents and plan mode. Ask Nyan to build what you want, or install a package that does it your way.

Use Nyan [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Nyan TypeScript SDK](docs/sdk.md).

## Getting started

Install the command-line interface from npm. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @ny4n/coding-agent
```

Nyan does not require dependency lifecycle scripts for a normal npm installation. See the [quickstart](docs/quickstart.md#1-install-nyan) for updating and pinning releases.

Start Nyan in the directory where you want it to work:

```bash
cd /path/to/project
nyan
```

For a built-in AI provider, run `/login` inside Nyan to connect a subscription or API key. Then give Nyan a task.

See the [documentation](docs/index.md) for full setup and usage instructions.


## Development

Clone the repository, install its dependencies, and run Nyan from source:

```bash
git clone https://github.com/blxzer77/nyan
cd nyan
npm ci --ignore-scripts
npm run hydrate:model-data
node scripts/nyan-source.mjs
```

`scripts/nyan-source.mjs` runs Nyan from the TypeScript sources without a build. It can be called from any directory (`node /path/to/nyan/scripts/nyan-source.mjs`) and keeps the caller's working directory.

Before submitting changes, run `npm run check` and the tests of the packages you changed. [AGENTS.md](https://github.com/blxzer77/nyan/blob/main/AGENTS.md) has the repository's implementation, testing, dependency, and release rules.

## License

MIT
