#!/usr/bin/env python3
"""End-to-end smoke test across the three retrieval services.

Proves the pieces work together before any @ny4n/retrieval code exists:
embed documents -> upsert into a Qdrant collection with generation/path payload
-> embed a query with the nl2code task prefix -> filtered vector search -> rerank
the candidates -> snapshot the collection -> delete it.

Usage: QDRANT_URL=http://<host>:6333 QDRANT_KEY_FILE=~/retrieval/keys/qdrant-api-key ./smoke-e2e.py

QDRANT_URL has no default: this script creates, writes, snapshots, and deletes a
collection, so it must be told which server to do that on rather than reaching a
deployment the caller did not name. EMBED_URL and RERANK_URL default to the
loopback services on this workstation.
"""
import json
import os
import sys
import urllib.error
import urllib.request

EMBED = os.environ.get("EMBED_URL", "http://127.0.0.1:8090")
RERANK = os.environ.get("RERANK_URL", "http://127.0.0.1:8091")
QDRANT = os.environ.get("QDRANT_URL", "")
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
    return ok


def call(url, payload=None, method=None, headers=None, raw=False):
    """Return the status and the decoded body.

    An HTTP error is an answer, not an exception: the check that needed it reports
    FAIL with the service's own reason, and the remaining checks still run.
    """
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read()
            return r.status, (body if raw else json.loads(body or b"null"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        if raw:
            return error.code, body
        try:
            return error.code, json.loads(body or b"null")
        except ValueError:
            return error.code, body


def reason(payload):
    """The server's own explanation, for a check that failed on its status."""
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return text[:300]


def qdrant_headers():
    with open(QDRANT_KEY) as f:
        return {"api-key": f.read().strip()}


def embed(items):
    status, d = call(f"{EMBED}/v1/embeddings", {"model": MODEL, "input": items})
    if status != 200:
        raise RuntimeError(f"POST {EMBED}/v1/embeddings -> {status}: {reason(d)}")
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
    if QDRANT == "":
        print("FAIL  configuration QDRANT_URL is not set", file=sys.stderr)
        return 2
    try:
        h = qdrant_headers()
    except OSError as error:
        print(f"FAIL  configuration cannot read QDRANT_KEY_FILE {QDRANT_KEY}: {error}", file=sys.stderr)
        return 2

    # 1. embed documents
    try:
        vecs = embed([f"// {p}\n{t}" for p, t in DOCS])
    except RuntimeError as error:
        print(f"FAIL  embed documents {error}", file=sys.stderr)
        return 1
    if not vecs:
        check("embed documents", False, "the service returned no vectors")
        return 1
    check("embed documents", len(vecs) == len(DOCS) and len(vecs[0]) == DIM, f"n={len(vecs)} dim={len(vecs[0])}")

    coll = "nyan_smoke"
    call(f"{QDRANT}/collections/{coll}", method="DELETE", headers=h)

    # 2. collection: cosine 1536 + payload indexes the retrieval contract needs
    status, created = call(f"{QDRANT}/collections/{coll}", {
        "vectors": {"size": DIM, "distance": "Cosine", "on_disk": False},
        "optimizers_config": {"default_segment_number": 2},
    }, method="PUT", headers=h)
    if not check("collection created", status == 200, f"status={status} {reason(created)}" if status != 200 else f"dim={DIM}"):
        print(f"\nfailures: {len(fails)} -> {fails}")
        return 1

    for field, schema in [("worktreeId", "keyword"), ("scopeId", "keyword"),
                          ("generation", "keyword"), ("path", "keyword")]:
        status, body = call(f"{QDRANT}/collections/{coll}/index?wait=true",
                            {"field_name": field, "field_schema": schema}, method="PUT", headers=h)
        check(f"payload index {field}", status == 200, "" if status == 200 else f"status={status} {reason(body)}")

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
    status, body = call(f"{QDRANT}/collections/{coll}/points?wait=true", {"points": points}, method="PUT", headers=h)
    check("upsert points", status == 200, f"n={len(points)}" if status == 200 else f"status={status} {reason(body)}")

    # 4. query: task-prefixed embedding + generation filter
    try:
        qv = embed([QUERY])[0]
    except RuntimeError as error:
        print(f"FAIL  embed query {error}", file=sys.stderr)
        return 1
    status, res = call(f"{QDRANT}/collections/{coll}/points/query", {
        "query": qv, "limit": 5, "with_payload": True,
        "filter": {"must": [{"key": "generation", "match": {"value": GEN}},
                            {"key": "worktreeId", "match": {"value": WT}}]},
    }, headers=h)
    hits = res["result"]["points"] if status == 200 else []
    check("vector search", len(hits) == 5,
          f"top={hits[0]['payload']['path']} score={hits[0]['score']:.3f}" if hits
          else (f"status={status} {reason(res)}" if status != 200 else "no hits"))
    check("generation filter", all(x["payload"]["generation"] == GEN for x in hits) and len(hits) == 5)

    # 5. rerank the fused candidates (what the pack will do before admission)
    status, sc = call(f"{RERANK}/score", {"model": "qwen3-reranker-0.6b", "text_1": QUERY,
                                          "text_2": [x["payload"]["text"] for x in hits]})
    scores = [x["score"] for x in sc["data"]] if status == 200 else []
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    if not order:
        check("rerank", False, f"status={status} {reason(sc)}" if status != 200 else "no scores")
    else:
        check("rerank", len(scores) == len(hits) and all(0.0 <= s <= 1.0 for s in scores),
              f"best={hits[order[0]]['payload']['path']} p={scores[order[0]]:.3f}")
        check("rerank picks the intent doc", "intent" in hits[order[0]]["payload"]["path"]
              or "harness" in hits[order[0]]["payload"]["path"], f"p={scores[order[0]]:.3f}")

    # 6. snapshot: the staged-generation/rollback path needs it to work
    status, snap = call(f"{QDRANT}/collections/{coll}/snapshots", method="POST", headers=h)
    name = snap.get("result", {}).get("name", "") if isinstance(snap, dict) else ""
    check("snapshot", status == 200 and name.endswith(".snapshot"), name or f"status={status} {reason(snap)}")

    # 7. cleanup
    status, body = call(f"{QDRANT}/collections/{coll}", method="DELETE", headers=h)
    check("cleanup", status == 200, "" if status == 200 else f"status={status} {reason(body)}")

    print(f"\nfailures: {len(fails)}" + (f" -> {fails}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
