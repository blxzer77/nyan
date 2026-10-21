#!/usr/bin/env python3
"""Rerank latency benchmark for the local vLLM score endpoint.

The retrieval contract reranks a fused candidate list, so what matters is the
wall time for one /score call with N candidates of realistic chunk length.

Usage: ./bench-rerank.py [--n 20,50] [--chars 1500]
"""
import argparse
import json
import os
import statistics
import time
import urllib.request

URL = os.environ.get("RERANK_URL", "http://127.0.0.1:8091")
MODEL = os.environ.get("RERANK_MODEL", "qwen3-reranker-0.6b")

CHUNK = '''
export async function selectStalePaths(input: {typ}) {{
  const rows = await this.db.query(
    "SELECT path, hash, updated_at FROM file_index WHERE scope = $1 AND generation = $2",
    [input.scope, input.generation],
  );
  const stale = rows.filter((row) => row.hash !== input.hashes[row.path]);
  if (!stale.length) return [];
  this.logger.info("stale paths", {{ count: stale.length, scope: input.scope }});
  return stale.map((row) => row.path);
}}
'''


def score(query, docs):
    body = json.dumps({"model": MODEL, "text_1": query, "text_2": docs}).encode()
    req = urllib.request.Request(URL + "/score", data=body, headers={"content-type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
    return time.perf_counter() - t0, data["data"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", default="20,50")
    ap.add_argument("--chars", type=int, default=1500)
    ap.add_argument("--repeats", type=int, default=3)
    args = ap.parse_args()

    query = "how does the index coordinator decide which generation is active after a crash"
    docs = []
    for i in range(100):
        body = CHUNK.format(typ=f"Scope{i}")
        text = f"// packages/retrieval/src/index/coordinator-{i}.ts\n" + body
        docs.append((text * 3)[: args.chars])

    for n in (int(x) for x in args.n.split(",")):
        lat = []
        for _ in range(args.repeats):
            dt, data = score(query, docs[:n])
            lat.append(dt)
        s = sorted(x["score"] for x in data)
        print(f"n={n:3d}  wall p50 {statistics.median(lat)*1000:6.0f}ms  min {min(lat)*1000:6.0f}ms  "
              f"score range {s[0]:.3f}..{s[-1]:.3f}")


if __name__ == "__main__":
    main()
