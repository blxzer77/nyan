#!/usr/bin/env bash
# Install apt packages on a runner that other jobs share.
#
# Self-hosted runners run several jobs at once, and a concurrent `apt-get update` holds
# /var/lib/apt/lists/lock. `-o DPkg::Lock::Timeout` only waits for the dpkg lock, not this one, so wait by
# retrying. Only a lock failure is retried, a bounded number of times; any other failure, and the last lock
# failure, stops the job with apt's own output.
set -uo pipefail

attempts=8
delay=15

run() {
  local output status
  output=$("$@" 2>&1)
  status=$?
  printf '%s\n' "$output"
  if [ "$status" -ne 0 ] && grep -q 'Could not get lock' <<<"$output"; then
    return 75
  fi
  return "$status"
}

for attempt in $(seq 1 "$attempts"); do
  run sudo apt-get -o DPkg::Lock::Timeout=120 update \
    && run sudo apt-get -o DPkg::Lock::Timeout=120 install -y "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$status" -ne 75 ]; then
    exit "$status"
  fi
  echo "apt lock is held by another job (attempt $attempt of $attempts); retrying in ${delay}s" >&2
  sleep "$delay"
done
echo "apt lock was still held after $attempts attempts" >&2
exit 1
