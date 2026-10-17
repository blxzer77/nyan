#!/usr/bin/env bash
# Install apt packages on a GitHub-hosted or self-hosted Ubuntu runner.
#
# The hosted images run unattended-upgrades and apt-daily at boot, and they hold /var/lib/apt/lists/lock or the dpkg
# lock while they run; a self-hosted runner shared by several jobs does the same between jobs. `DPkg::Lock::Timeout`
# covers only the dpkg lock, so a lock failure is retried here, with a bounded number of attempts and a random
# jitter so that jobs which started together do not retry together. Any other apt error stops at once, with apt's
# output. `APT_RETRY_DELAY` overrides the 15 s base delay (tests use 0).
set -uo pipefail

attempts=8
delay="${APT_RETRY_DELAY:-15}"
lock_timeout=30
log=$(mktemp)
trap 'rm -f "$log"' EXIT

# Runs one apt command, showing its output as it goes. Returns 75 when it failed because a lock was held.
run() {
  local status
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ "$status" -ne 0 ] && grep -Eq 'Could not get lock|Unable to (acquire|lock)' "$log"; then
    return 75
  fi
  return "$status"
}

for attempt in $(seq 1 "$attempts"); do
  run sudo apt-get -o DPkg::Lock::Timeout="$lock_timeout" update \
    && run sudo apt-get -o DPkg::Lock::Timeout="$lock_timeout" install -y "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$status" -ne 75 ]; then
    exit "$status"
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    wait_for=$((delay + RANDOM % (delay + 1)))
    echo "apt lock is held by another process (attempt $attempt of $attempts); retrying in ${wait_for}s" >&2
    sleep "$wait_for"
  fi
done
echo "apt lock was still held after $attempts attempts" >&2
exit 1
