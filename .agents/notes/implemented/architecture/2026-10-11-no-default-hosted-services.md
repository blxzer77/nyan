# Agent Note: No default hosted services

Status: implemented

## Problem

Pi v1.1.0 talks to services that Earendil Works operates under `pi.dev` and `radius.pi.dev`. Renaming those hosts to a Nyan domain would point shipped code at names Nyan does not own: whoever registers them would receive version checks, OAuth client metadata lookups, shared-session links and model-catalog requests. Leaving them would send Nyan users' traffic to a third party and, for the install ping, report Nyan installs to it.

The services were:

| Use | Pi v1.1.0 behavior |
| --- | --- |
| Install telemetry | `GET pi.dev/api/report-install` on first run and after upgrades |
| Version feed | `pi.dev/api/latest-version` at startup and for `update` |
| Installer | `pi.dev/api/installer/releases`, `install.sh`, `install.ps1` |
| Share viewer | `pi.dev/session/` as the `/share` preview |
| Model catalog | `pi.dev/api/models/providers/<id>` overlay |
| MCP client metadata | `pi.dev/oauth/client.json` for `clientRegistration: "cimd"` |
| Radius gateway | `radius.pi.dev` login, artifacts, MCP and a build-time model catalog |
| Attribution | `HTTP-Referer: https://pi.dev` for OpenRouter |

## Decision

Nyan assumes no hosted service. Each feature that needs one reads its base URL from the environment and is off, or fails with a message naming the variable, until the operator sets it:

| Variable | Without it |
| --- | --- |
| `NYAN_LATEST_VERSION_URL` | the npm registry answers for this package's `latest` dist-tag; set it to ask a release feed instead (`NYAN_NPM_REGISTRY` redirects the registry lookup) |
| `NYAN_INSTALLER_API_BASE` | a managed install update stops with an error naming the variable |
| `NYAN_SHARE_VIEWER_URL` | `/share` prints only the gist URL |
| `NYAN_CATALOG_BASE_URL` | the remote catalog overlay is not applied |
| `NYAN_MCP_CLIENT_METADATA_URL` | `clientRegistration: "cimd"` fails with an error naming the variable |

The install ping and the `/dementedelves` Earendil announcement are removed. The npm "migrate to the installer" hint after `update` is removed. Provider attribution identifies Nyan with its repository URL. The Pi installer scripts and the Nix instructions are removed from the quickstart; Nyan ships through npm.

The Radius gateway cluster was first neutralized with a reserved `.invalid` host and then removed altogether; see [remove unused upstream content](../process/2026-10-12-remove-unused-upstream-content.md).

## Alternatives considered

**Rename the hosts to `nyan.dev`.** Rejected: the domain is not owned, the failure is silent, and squatting would receive real traffic.

**Point every default at a `.invalid` host.** Rejected for all but Radius: it would make every startup attempt a DNS lookup that is guaranteed to fail. Radius keeps the placeholder because its default is read at module load by several callers.

**Keep the Radius cluster for any gateway the operator configures.** Superseded: it was removed in a follow-up, because it could only talk to the upstream company's gateway product.

## Consequences

Out of the box Nyan makes no request to any service other than the model providers the user configures and the npm registry (the version check). `nyan update` for an npm install still runs the package manager. Re-enabling a feature is a configuration change, not a code change. A hosted Nyan service, if one ever exists, sets these variables or replaces the defaults in a new note.

`generate-models` no longer includes a Radius catalog, so `radius.models.ts` and `data/radius.json` are gone and `models.generated.ts` lists one provider fewer.

## Verification

Searching the tracked files for `pi.dev` finds only this note, the productization note, and the protection rule in the upstream normalizer. The affected tests set the new variables explicitly: `version-check`, `package-command-paths`, `mcp-oauth-refresh`, `remote-catalog-provider`, `model-catalog-protocol`, `sdk-openrouter-attribution` (coding-agent) and `providers` (ai). The Radius tests were deleted with the Radius code.
