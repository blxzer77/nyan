# .agents

Agent-facing material that the root [AGENTS.md](../AGENTS.md) links to. When Nyan runs inside this repository it discovers the skills in `.agents/skills/` on its own and loads one when a task matches its description.

| Directory | Holds |
| --- | --- |
| [`notes/`](notes/README.md) | Design decisions: the problem, what was decided, what was rejected, and the evidence |
| `skills/` | Workflows loaded on demand, one `SKILL.md` per directory |
| `upstream/` | The Pi baseline and the one sync, kept as provenance: source commits, and what was taken, dropped, adapted, or left unintegrated |

## Skills

| Skill | Use it when |
| --- | --- |
| [nyan-checks](skills/nyan-checks/SKILL.md) | Choosing the checks for a change, and before saying that checks pass |
| [nyan-code-review](skills/nyan-code-review/SKILL.md) | Reviewing a change |
| [nyan-error-handling](skills/nyan-error-handling/SKILL.md) | Designing or reviewing failure, recovery, retry, background work, and user-visible error reports |
| [nyan-upstream-sync](skills/nyan-upstream-sync/SKILL.md) | Taking a Pi change the user names into Nyan (Nyan does not follow Pi otherwise) |
| [add-llm-provider](skills/add-llm-provider/SKILL.md) | Adding a provider to `packages/ai` |
| [interactive-testing](skills/interactive-testing/SKILL.md) | Checking interactive behavior in a real terminal |

A skill does not replace code, tests, or the user's authorization.

## Evidence levels

Source exists, types check, tests pass, the built artifact runs, the published package installs and runs: each is stronger than the one before. Say which level a claim reached.
