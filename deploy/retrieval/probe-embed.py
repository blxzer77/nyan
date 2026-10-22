#!/usr/bin/env python3
"""Embedding readiness probe (llama.cpp /v1/embeddings or TEI /embed).

Checks what the retrieval contract needs before a provider may serve candidates:
declared dim, finiteness, unit norm, batch alignment. An HTTP 200 alone is not
readiness.
"""
import json
import math
import os
import sys
import urllib.request

URL = os.environ.get("EMBED_URL", "http://127.0.0.1:8090")
API = os.environ.get("EMBED_API", "llama")
MODEL = os.environ.get("EMBED_MODEL", "jina-code-embeddings-1.5b")
DIM = int(os.environ.get("EXPECTED_DIM", "1536"))

fails = 0

if API not in ("llama", "tei"):
    # An unknown value is a configuration mistake, not a reason to probe llama.cpp's endpoints with the wrong protocol.
    print(f"FAIL  EMBED_API {API!r} is not 'llama' or 'tei'", file=sys.stderr)
    sys.exit(2)


def check(name, ok, detail=""):
    global fails
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' ' + detail if detail else ''}")
    if not ok:
        fails += 1


def embed(items, timeout=120):
    if API == "tei":
        body = {"inputs": items, "normalize": True}
        path = "/embed"
    else:
        body = {"model": MODEL, "input": items}
        path = "/v1/embeddings"
    req = urllib.request.Request(
        URL + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.load(r)
    return [x["embedding"] for x in data["data"]] if "data" in data else data


print(f"== embedding ({API}): {URL}")
try:
    if API == "tei":
        with urllib.request.urlopen(URL + "/info", timeout=10) as r:
            info = json.load(r)
        check("GET /info", True, f"model_id={info.get('model_id')} max_batch={info.get('max_client_batch_size')}")
    else:
        with urllib.request.urlopen(URL + "/props", timeout=10) as r:
            props = json.load(r)
        n_ctx = props.get("default_generation_settings", {}).get("n_ctx")
        check("GET /props", True, f"n_ctx={n_ctx}")
except Exception as e:  # noqa: BLE001 - a probe reports, it does not recover
    check("service reachable", False, str(e))
    sys.exit(1)

vec = embed(["export function add(a: number, b: number) { return a + b; }"])[0]
check("dim", len(vec) == DIM, f"{len(vec)} (expected {DIM})")
check("finite", all(math.isfinite(x) for x in vec))
norm = math.sqrt(sum(x * x for x in vec))
check("unit_norm", abs(norm - 1.0) < 0.02, f"{norm:.6f}")

vecs = embed([f"chunk {i}: function f{i}() {{ return {i}; }}" for i in range(32)])
check("batch_32", len(vecs) == 32, f"n={len(vecs)}")
check("batch_aligned", all(len(v) == DIM for v in vecs))

# A document and a query must not be identical vectors: the profile is last-token
# pooled, so an accidental mean-pooling or wrong tokenizer shows up here.
a, b = embed(["the durable harness commits an intent before the effect",
              "how does the durable harness recover after a crash"])
cos = sum(x * y for x, y in zip(a, b))
check("distinct_texts", cos < 0.999, f"cos={cos:.4f}")

print(f"\nfailures: {fails}")
sys.exit(1 if fails else 0)
