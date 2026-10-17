#!/usr/bin/env bash
# Install apt packages on a GitHub-hosted or self-hosted Ubuntu runner.
#
# The hosted images run unattended-upgrades and apt-daily at boot, and they hold /var/lib/apt/lists/lock or the dpkg
# lock while they run; a self-hosted runner shared by several jobs does the same between jobs. `DPkg::Lock::Timeout`
# covers only the dpkg lock, so a lock failure is retried here. Retries are bounded twice: by a number of attempts and
# by a deadline, so that the job's own timeout is not the first thing that stops them. Random jitter keeps jobs that
# started together from retrying together. A transient network error is retried the same way. Any other apt error stops
# at once, with apt's output. `APT_RETRY_DELAY` overrides the 15 s base delay (tests use 0).
set -uo pipefail
# apt's messages are matched below, so they must be in English whatever the runner's locale is.
export LC_ALL=C

attempts=8
deadline=$((SECONDS + 240))
delay="${APT_RETRY_DELAY:-15}"
lock_timeout=30
log=$(mktemp)
trap 'rm -f "$log"' EXIT

# Runs one apt command, showing its output as it goes. Returns 75 for a lock or a transient network error (retryable).
run() {
  local status
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ "$status" -ne 0 ] && grep -Eq 'Could not get lock|Unable to (acquire|lock)|Failed to fetch|Temporary failure resolving|Connection timed out|Could not resolve' "$log"; then
    return 75
  fi
  return "$status"
}

updated=0
for attempt in $(seq 1 "$attempts"); do
  # The index is refreshed until it is; a retry after a failed install does not repeat the refresh.
  if [ "$updated" -eq 0 ]; then
    run sudo apt-get -o DPkg::Lock::Timeout="$lock_timeout" update
    status=$?
    if [ "$status" -eq 0 ]; then updated=1; fi
  fi
  if [ "$updated" -eq 1 ]; then
    run sudo apt-get -o DPkg::Lock::Timeout="$lock_timeout" install -y "$@"
    status=$?
  fi
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$status" -ne 75 ]; then
    exit "$status"
  fi
  if [ "$attempt" -ge "$attempts" ] || [ "$SECONDS" -ge "$deadline" ]; then
    break
  fi
  wait_for=$((delay + RANDOM % (delay + 1)))
  echo "apt is busy or unreachable (attempt $attempt of $attempts); retrying in ${wait_for}s" >&2
  sleep "$wait_for"
done
echo "apt was still busy or unreachable after $attempt attempt(s) or $((SECONDS)) s" >&2
exit 1
