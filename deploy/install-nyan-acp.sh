#!/usr/bin/env bash
# Copies a built nyan binary to the server as /opt/nyan-acp/bin/nyan, keeping the
# previous one as nyan.prev and recording where the build came from in BUILD-INFO.
#
# Usage: deploy/install-nyan-acp.sh <ssh-host> [binary]
#   binary defaults to target/release/nyan. Build it first with
#   `cargo build --release --locked --bin nyan` on a machine whose glibc is not
#   newer than the server's (or use the musl build from the release workflow).
set -euo pipefail

host=${1:?usage: deploy/install-nyan-acp.sh <ssh-host> [binary]}
binary=${2:-target/release/nyan}
[ -x "$binary" ] || { echo "no executable at $binary" >&2; exit 1; }

commit=$(git rev-parse HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)
dirty=$(git status --porcelain --untracked-files=no | head -1)

scp -q "$binary" "$host:/opt/nyan-acp/bin/nyan.new"
ssh "$host" bash -s -- "$commit" "$branch" "${dirty:+dirty}" <<'REMOTE'
set -euo pipefail
commit=$1 branch=$2 dirty=${3:-}
cd /opt/nyan-acp/bin
chmod 755 nyan.new
./nyan.new --version >/dev/null   # refuse a binary the server cannot run
[ -e nyan ] && cp -p nyan nyan.prev
mv -f nyan.new nyan
{
  echo "branch $branch"
  echo "commit $commit${dirty:+ (with uncommitted changes)}"
  echo "installed $(date -Is)"
  echo "previous binary: bin/nyan.prev"
} > /opt/nyan-acp/BUILD-INFO
./nyan --version
REMOTE
echo "Installed. New sessions use it; running sessions keep the old process."
