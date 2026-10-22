#!/usr/bin/env python3
"""Embedding throughput benchmark for the local embedding service.

Measures sustained document-embedding throughput and query-embed latency at the
profile the retrieval contract will use: chunk ~400 tokens, client batch 32.

Usage: EMBED_URL=http://127.0.0.1:8090 ./bench-embed.py [--chunks 512] [--batch 32]
       (EMBED_API=tei switches to the TEI /embed endpoint instead of llama.cpp /v1/embeddings)

The default is llama.cpp on this workstation, which is what serves the profile
measured in README.md; TEI cannot serve this model here.
"""
import argparse
import json
import math
import os
import random
import statistics
import sys
import time
import urllib.request

URL = os.environ.get("EMBED_URL", "http://127.0.0.1:8090")
# "llama" = llama.cpp /v1/embeddings ({"input": [...]}), "tei" = TEI /embed ({"inputs": [...]})
API = os.environ.get("EMBED_API", "llama")
CODE = '''
export async function {name}(input: {typ}) {{
  const rows = await this.db.query(
    "SELECT id, path, score FROM embeddings WHERE scope = $1 ORDER BY score DESC LIMIT {n}",
    [input.scope],
  );
  if (!rows.length) {{
    this.logger.warn("no rows for scope", {{ scope: input.scope }});
    return [];
  }}
  return rows.map((row) => ({{
    id: row.id,
    path: row.path,
    score: Number(row.score).toFixed(4),
    stale: row.path !== input.expectedPath,
  }}));
}}
'''


def embed(items, timeout=300):
    if API == "tei":
        v = post("/embed", {"inputs": items, "normalize": True}, timeout)
        return v
    v = post("/v1/embeddings", {"model": os.environ.get("EMBED_MODEL", "jina-code-embeddings-1.5b"), "input": items}, timeout)
    return [x["embedding"] for x in v["data"]]


def post(path, payload, timeout=300):
    req = urllib.request.Request(
        URL + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def make_chunks(n):
    out = []
    for i in range(n):
        body = CODE.format(name=f"query{i}", typ=f"Scope{i}", n=(i % 40) + 5)
        # ~400 tokens: repeat the body with a per-chunk breadcrumb so the service
        # cannot deduplicate and the tokenizer sees realistic identifier density.
        out.append(f"// packages/core/src/db/query-{i}.ts\n{body}\n{body[:600]}")
    return out


def main():
    if API not in ("llama", "tei"):
        # An unknown value is a configuration mistake, not a reason to fall through to llama.cpp's protocol.
        print(f"EMBED_API {API!r} is not 'llama' or 'tei'", file=sys.stderr)
        return 2
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunks", type=int, default=512)
    ap.add_argument("--batch", type=int, default=32)
    args = ap.parse_args()
    if args.chunks < 1 or args.batch < 1:
        ap.error("--chunks and --batch must be at least 1")

    if API == "tei":
        info = json.load(urllib.request.urlopen(URL + "/info", timeout=10))
        print(f"model={info.get('model_id')} max_client_batch_size={info.get('max_client_batch_size')} max_input_length={info.get('max_input_length')}")
    else:
        props = json.load(urllib.request.urlopen(URL + "/props", timeout=10))
        print(f"api={API} n_ctx={props.get('default_generation_settings', {}).get('n_ctx')} model={props.get('model_path', '').split('/')[-1]}")

    chunks = make_chunks(args.chunks)
    random.seed(0)
    random.shuffle(chunks)
    batches = [chunks[i : i + args.batch] for i in range(0, len(chunks), args.batch)]

    embed(batches[0][:2])  # warmup
    lat = []
    t0 = time.perf_counter()
    for b in batches:
        s = time.perf_counter()
        v = embed(b)
        lat.append(time.perf_counter() - s)
        assert len(v) == len(b), (len(v), len(b))
    wall = time.perf_counter() - t0
    print(f"documents   {len(chunks)} in {wall:.2f}s -> {len(chunks)/wall:.2f} chunks/s")
    print(f"batch lat   p50 {statistics.median(lat)*1000:.0f}ms  max {max(lat)*1000:.0f}ms  n={len(lat)}")

    ql = []
    for i in range(20):
        s = time.perf_counter()
        embed(["how does the durable harness checkpoint a phase boundary? " + str(i)])
        ql.append(time.perf_counter() - s)
    ql.sort()
    # Nearest-rank percentiles, the same definition for both, and the same one statistics.median uses for p50.
    p90 = ql[min(len(ql) - 1, math.ceil(0.9 * len(ql)) - 1)]
    print(f"query lat   p50 {statistics.median(ql)*1000:.0f}ms  p90 {p90*1000:.0f}ms  (short query, single item)")

    # Header values only; the retrieval contract records dim/normalization in the
    # generation tuple, so print what this profile actually produces.
    v = embed(["x"])
    print(f"dim         {len(v[0])}")


if __name__ == "__main__":
    main()
