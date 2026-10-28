#!/usr/bin/env bash
# One test entrypoint for the developer machine and CI.
#
# It owns the three layers of host-state pinning the justfile used to inline,
# so `just test` and the shard jobs cannot drift apart:
#
#   settings root   CLAUDE_CONFIG_DIR -> target/test-home (also moves
#                   ~/.claude.json; see justfile:17-19)
#   project settings COMETIX_TEST_PROJECT_DIR -> tracked hook-free fixture
#                   (projectSettings is process state, not reachable by env)
#   host session    empty privacy vars, and the model/gateway variables a
#                   host Claude Code session injects are removed — empty
#                   strings would be adopted as model NAMES (justfile:86)
#
# Usage:
#   scripts/ci/test.sh [--archive FILE] [--partition SPEC] [nextest args...]
#
#   --archive    run a `cargo nextest archive` instead of building; the
#                extraction directory is created because nextest does not
#                create it
#   --partition  hash:k/n shard selection
#
# In CI (CI=true) the `ci` nextest profile is selected, which writes
# target/nextest/ci/junit.xml and disables retries. Locally the default
# profile is kept, so `just test` behaves exactly as before.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

archive=""
partition=""
extra=()
while (($#)); do
    case "$1" in
        --archive) archive="$2"; shift 2 ;;
        --archive=*) archive="${1#*=}"; shift ;;
        --partition) partition="$2"; shift 2 ;;
        --partition=*) partition="${1#*=}"; shift ;;
        *) extra+=("$1"); shift ;;
    esac
done

python3 "$root/scripts/ci/prepare-test-home.py" --root "$root" >/dev/null

export CLAUDE_CONFIG_DIR="$root/target/test-home"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=
export DISABLE_TELEMETRY=
export NODE_ENV=
export CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=
export COMETIX_TEST_PROJECT_DIR="$root/tests/fixtures/isolated-project"

# Not `VAR=`: the model resolvers read these without an is-empty filter, so an
# empty value becomes a model name. They must be absent.
unset ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL \
    ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL \
    CLAUDE_CODE_MODEL CLAUDE_CODE_SMALL_FAST_MODEL CLAUDE_CODE_SUBAGENT_MODEL \
    CLAUDE_CODE_DEFAULT_OPUS_MODEL CLAUDE_CODE_DEFAULT_SONNET_MODEL CLAUDE_CODE_DEFAULT_HAIKU_MODEL \
    CLAUDE_CLASSIFIER_MODEL COMETIX_MODEL \
    ANTHROPIC_CUSTOM_MODEL_OPTION ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION \
    ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY

args=(cargo nextest run --lib --no-fail-fast)
if [[ -n "${CI:-}" ]]; then
    args+=(--profile ci)
fi
if [[ -n "$archive" ]]; then
    mkdir -p "$root/.ci-extract"
    args+=(--archive-file "$archive" --workspace-remap "$root" --extract-to "$root/.ci-extract")
fi
if [[ -n "$partition" ]]; then
    args+=(--partition "$partition")
fi
args+=("${extra[@]}")

exec "${args[@]}"
