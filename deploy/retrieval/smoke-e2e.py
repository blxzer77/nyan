#!/usr/bin/env python3
"""End-to-end smoke test across the three retrieval services.

Proves the pieces work together before any @ny4n/retrieval code exists:
embed documents -> upsert into a Qdrant collection with generation/path payload
-> embed a query with the nl2code task prefix -> filtered vector search -> rerank
the candidates -> snapshot the collection -> delete it.

Usage: ./smoke-e2e.py        (QDRANT_KEY_FILE must point at the api key)
"""
import json
import math
import os
import sys
import urllib.error
import urllib.request

EMBED = os.environ.get("EMBED_URL", "http://127.0.0.1:8090")
RERANK = os.environ.get("RERANK_URL", "http://127.0.0.1:8091")
QDRANT = os.environ.get("QDRANT_URL", "http://100.80.19.12:6333")
QDRANT_KEY = os.environ.get("QDRANT_KEY_FILE", os.path.expanduser("~/retrieval/keys/qdrant-api-key"))
MODEL = "jina-code-embeddings-1.5b"
DIM = 1536
GEN = "gen-smoke-0001"
WT = "wt-nyan"

fails = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' ' + detail if detail else ''}")
    if not ok:
        fails.append(name)


def call(url, payload=None, method=None, headers=None, raw=False):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read()
        return r.status, (body if raw else json.loads(body or b"null"))


def qdrant_headers():
    with open(QDRANT_KEY) as f:
        return {"api-key": f.read().strip()}


def embed(items):
    _, d = call(f"{EMBED}/v1/embeddings", {"model": MODEL, "input": items})
    return [x["embedding"] for x in d["data"]]


DOCS = [
    ("packages/durable/src/tasks/harness.ts",
     "async commitOutcome(intent, result) { await this.db.tx(async (tx) => { await tx.update('intent', intent.id, {state: 'done', result}); }); }"),
    ("packages/durable/src/tasks/intent.ts",
     "// an intent row is written before the effect and settled after it, so a crash\n// between the two leaves an intent whose outcome is missing and is replayed."),
    ("packages/retrieval/src/index/coordinator.ts",
     "export async function publish(manifest, expectedBase) { return store.compareAndSet('active', expectedBase, manifest); }"),
    ("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n"),
    ("src/tui/theme.ts", "export const accent = '#FF9EC4'; export const raised = '#2B202A';"),
    ("README.md", "# nyan\n\nA coding agent harness.\n"),
]

QUERY = "Find the most relevant code snippet given the following query:\nwhere is the durable intent committed before the effect?"


def main():
    # 1. embed documents
    vecs = embed([f"// {p}\n{t}" for p, t in DOCS])
    check("embed documents", len(vecs) == len(DOCS) and len(vecs[0]) == DIM, f"n={len(vecs)} dim={len(vecs[0])}")

    coll = "nyan_smoke"
    h = qdrant_headers()
    try:
        call(f"{QDRANT}/collections/{coll}", method="DELETE", headers=h)
    except urllib.error.HTTPError:
        pass

    # 2. collection: cosine 1536 + payload indexes the retrieval contract needs
    call(f"{QDRANT}/collections/{coll}", {
        "vectors": {"size": DIM, "distance": "Cosine", "on_disk": False},
        "optimizers_config": {"default_segment_number": 2},
    }, method="PUT", headers=h)
    _, info = call(f"{QDRANT}/collections/{coll}", headers=h)
    check("collection created", info["result"]["config"]["params"]["vectors"]["size"] == DIM, f"dim={DIM}")

    for field, schema in [("worktreeId", "keyword"), ("scopeId", "keyword"),
                          ("generation", "keyword"), ("path", "keyword")]:
        st, _ = call(f"{QDRANT}/collections/{coll}/index?wait=true",
                     {"field_name": field, "field_schema": schema}, method="PUT", headers=h)
        check(f"payload index {field}", st == 200)

    # 3. upsert with the source-identity payload the contract relies on
    points = []
    for i, ((path, text), v) in enumerate(zip(DOCS, vecs)):
        points.append({
            "id": i + 1,
            "vector": v,
            "payload": {
                "worktreeId": WT, "scopeId": "scope-nyan-root", "generation": GEN,
                "path": path, "chunkId": f"{path}#{i}", "startLine": 1, "endLine": 3,
                "fileHash": f"sha256:stub-{i}", "text": text,
            },
        })
    st, _ = call(f"{QDRANT}/collections/{coll}/points?wait=true", {"points": points}, method="PUT", headers=h)
    check("upsert points", st == 200, f"n={len(points)}")

    # 4. query: task-prefixed embedding + generation filter
    qv = embed([QUERY])[0]
    _, res = call(f"{QDRANT}/collections/{coll}/points/query", {
        "query": qv, "limit": 5, "with_payload": True,
        "filter": {"must": [{"key": "generation", "match": {"value": GEN}},
                            {"key": "worktreeId", "match": {"value": WT}}]},
    }, headers=h)
    hits = res["result"]["points"]
    check("vector search", len(hits) == 5, f"top={hits[0]['payload']['path'] if hits else None} score={hits[0]['score']:.3f}" if hits else "")
    check("generation filter", all(x["payload"]["generation"] == GEN for x in hits))

    # 5. rerank the fused candidates (what the pack will do before admission)
    _, sc = call(f"{RERANK}/score", {"model": "qwen3-reranker-0.6b", "text_1": QUERY,
                                     "text_2": [x["payload"]["text"] for x in hits]})
    scores = [x["score"] for x in sc["data"]]
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    check("rerank", len(scores) == len(hits) and all(0.0 <= s <= 1.0 for s in scores),
          f"best={hits[order[0]]['payload']['path']} p={scores[order[0]]:.3f}")
    check("rerank picks the intent doc", "intent" in hits[order[0]]["payload"]["path"]
          or "harness" in hits[order[0]]["payload"]["path"], f"p={scores[order[0]]:.3f}")

    # 6. snapshot: the staged-generation/rollback path needs it to work
    st, snap = call(f"{QDRANT}/collections/{coll}/snapshots", method="POST", headers=h)
    name = snap.get("result", {}).get("name", "")
    check("snapshot", st == 200 and name.endswith(".snapshot"), name)

    # 7. cleanup
    st, _ = call(f"{QDRANT}/collections/{coll}", method="DELETE", headers=h)
    check("cleanup", st == 200)

    print(f"\nfailures: {len(fails)}" + (f" -> {fails}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
