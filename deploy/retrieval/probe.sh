#!/usr/bin/env bash
# Readiness probes for the self-hosted retrieval services. Each check prints
# PASS/FAIL with the observed value; exit code is the number of failures.
#
# These are the cheap checks the contract needs before a provider may serve
# candidates (an HTTP 200 is not readiness). They are not the full
# pactile.cg.readiness-fixture set.

set -uo pipefail

EMBED_URL="${EMBED_URL:-http://127.0.0.1:8090}"
RERANK_URL="${RERANK_URL:-http://127.0.0.1:8091}"
QDRANT_URL="${QDRANT_URL:-http://100.80.19.12:6333}"
QDRANT_KEY_FILE="${QDRANT_KEY_FILE:-$HOME/retrieval/keys/qdrant-api-key}"
EMBED_API="${EMBED_API:-llama}"
EXPECTED_DIM="${EXPECTED_DIM:-1536}"
export EXPECTED_DIM

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

jq_py() { python3 -c "$1"; }

probe_embed() {
  python3 "$(dirname "$0")/probe-embed.py" || fails=$((fails + 1))
}

probe_rerank() {
  echo "== rerank: $RERANK_URL"
  local out
  out="$(curl -s --max-time 60 -X POST "$RERANK_URL/score" -H 'content-type: application/json' -d '{
    "model": "qwen3-reranker-0.6b",
    "text_1": "how do durable tasks checkpoint a phase",
    "text_2": [
      "The harness commits an intent row, performs the effect, then commits the outcome; on restart it replays only intents whose outcome is missing.",
      "The weather in Paris is mild in spring and people enjoy walking along the Seine."
    ]
  }')"
  printf '%s' "$out" | jq_py '
import json,sys
d=json.load(sys.stdin)
data=d.get("data") or d.get("results")
if not data:
    print("CHECK score_shape      FAIL %r" % (d,)); raise SystemExit
scores=[x.get("score") for x in data]
print("CHECK score_shape      PASS n=%d" % len(scores))
ok=all(isinstance(s,(int,float)) and 0.0<=s<=1.0 for s in scores)
print("CHECK score_range_0_1  %s %r" % ("PASS" if ok else "FAIL", scores))
rel=len(scores)==2 and scores[0]>scores[1]
print("CHECK ranking_sanity   %s" % ("PASS" if rel else "FAIL"))
' || fail "rerank request failed"
}

probe_qdrant() {
  echo "== qdrant: $QDRANT_URL"
  if [[ ! -r "$QDRANT_KEY_FILE" ]]; then fail "no api key file at $QDRANT_KEY_FILE"; return; fi
  local key; key="$(tr -d '\n' <"$QDRANT_KEY_FILE")"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$QDRANT_URL/collections")"
  [[ "$code" == "401" ]] && pass "anonymous request refused (401)" || fail "anonymous request answered $code"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "api-key: $key" "$QDRANT_URL/collections")"
  [[ "$code" == "200" ]] && pass "authenticated request ok (200)" || fail "authenticated request answered $code"
}

case "${1:-all}" in
  embed) probe_embed ;;
  rerank) probe_rerank ;;
  qdrant) probe_qdrant ;;
  all) probe_embed; probe_rerank; probe_qdrant ;;
  *) echo "usage: $0 [embed|rerank|qdrant|all]" >&2; exit 2 ;;
esac

echo
echo "failures: $fails"
exit "$fails"
