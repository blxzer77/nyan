# Agent Note: Remote hybrid code retrieval

Status: proposed

## Problem

Nyan's current retrieval roadmap describes a fixed EmbeddingGemma semantic branch and leaves index placement open. The owner instead wants an optional, self-hosted client/server code-retrieval capability:

- Nyan remains usable with deterministic local retrieval when no remote capability is configured.
- The client performs local Tree-sitter chunking, breadcrumb enrichment, scheduling, candidate fusion, source validation, and context-pack construction.
- Self-hosted services provide embedding, reranking, vector storage, and lexical retrieval.
- A missing remote index must not block a user request: the client returns core exact/structural results and starts an idempotent background bootstrap. Once a ready generation is published, later requests use the remote hybrid path.

The design must preserve the retrieval contracts in the Pactile reference material without making those reference assets Nyan implementation evidence.

## Proposal

### 1. Product boundary and optionality

The remote path is an optional enhancement. The deterministic core remains available without any remote service:

```text
core: exact + structural + local source inspection
optional: semantic + remote lexical + rerank
```

Provider availability is independent. Missing embedding, Qdrant, Tantivy, or rerank capability produces an explicit degraded/unavailable branch state and never an empty-result success. A provider is not called unless its complete retrieval configuration and readiness probe pass.

Retrieval configuration is one structured `retrieval` settings block. It contains service references, protocol/model profiles, timeouts, batching, index namespace, generation/chunker versions, and bootstrap/incremental-sync policy. It does not require scattered endpoint environment variables or default hosted URLs. Credentials are referenced through the existing credential mechanism rather than written into repository files or normal logs.

The owner's self-hosted network policy is authoritative for the configured internal endpoints. The client does not require per-request confirmation for the owner's configured services, but it still restricts requests to the configured service identities and does not follow arbitrary redirects or accept an unconfigured endpoint.

### 2. Client/server ownership

`@ny4n/retrieval` is a client-side capability package. It owns:

- local worktree scanning and source hashes;
- Tree-sitter chunking and breadcrumb enrichment;
- chunker/preprocessing versioning;
- embedding and rerank client adapters;
- index job admission, polling, cancellation, and retry policy;
- candidate retrieval and deterministic RRF fusion;
- current-source inspection and freshness/generation fences;
- bounded context-pack construction.

The self-hosted retrieval server owns the remote index backends and their durable jobs. It exposes a versioned protocol for the vector and lexical indexes; Nyan never mounts a remote Tantivy directory or manipulates remote index files.

The Tantivy service is a separately deployed server component, not a native Tantivy binding embedded in the Nyan Node/Bun process. It must expose strict BM25 lexical search, index status, chunk upsert/delete, staged generation operations, and a versioned analyzer/schema fingerprint.

Qdrant remains the vector backend. TEI provides the embedding and rerank inference endpoints. A server-side index coordinator or an equivalent manifest protocol is required to make Qdrant and Tantivy appear as one active index; two independent `ready` flags are insufficient.

### 3. Model and protocol profiles

The initial candidate profile is:

- embedding model: `jinaai/jina-code-embeddings-1.5b` through TEI `/embed`;
- client embedding batch limit: 32;
- requested embedding dimensions: 256;
- reranker: `BAAI/bge-reranker-v2-m3` through TEI `/rerank`;
- RRF candidate count: 50 from each branch and 50 after fusion;
- rerank candidate count: 50 in one request;
- minimum normalized rerank score: 0.2;
- final context candidate count: at most 5.

These are a candidate profile, not unverified domain constants. Readiness must verify the actual service metadata and response shape. The embedding generation records model id, requested/observed dimension, normalization, precision, task/prompt configuration, preprocessing, chunker version, source snapshot, scope, and index schema. The rerank adapter requests normalized scores (`raw_scores: false` or the service-equivalent), rejects non-finite/out-of-range values, and treats the threshold as a versioned profile parameter.

Client batch size is a client scheduling limit; it is not assumed to be a TEI request field or the server's internal batch size. A failed or malformed embedding batch is rejected as a batch, not partially accepted.

Readiness has a closed refusal matrix. A model id/revision, protocol, prompt/task profile, effective dimension, normalization mode, or analyzer/schema fingerprint mismatch makes that provider profile unsupported or stale and prevents it from serving candidates. A wrong vector count, wrong vector length, non-finite value, invalid rank index, or non-finite rerank score invalidates the complete response unit; it is never converted into a low score. A reranker profile is usable for the `0.2` threshold only when the response is explicitly normalized to `[0, 1]`; raw logits or an unknown score mode make the profile unsupported. A service-reported maximum batch below 32 is either recorded as a degraded effective profile and used with the smaller advertised limit, or rejected by policy; it is never silently treated as batch size 32.

### 4. Generation and active-index publication

Every remote index operation has a target generation derived from a canonical tuple containing, at minimum:

- model and model revision;
- observed/requested embedding dimension and normalization;
- precision and task/prompt profile;
- query/document preprocessing versions;
- Tree-sitter/chunker version;
- Tantivy analyzer and index schema version;
- source snapshot/tree hash;
- worktree and permission scope.

The remote server builds into a staged generation. The vector and Tantivy components receive the same `generationId`, source snapshot, scope, and sync operation id. A generation becomes queryable only after both components pass count/schema/generation validation and one manifest is published as the active generation.

The publication contract must provide:

- one authoritative active-manifest owner;
- compare-and-set against the expected base generation;
- staged, ready, abandoned, and published states;
- detection of partial publication;
- idempotent operation/job identifiers;
- rollback by leaving the prior active generation untouched;
- explicit retention and cleanup of abandoned generations.

A query reads one active manifest and sends the same generation filter to both remote branches. Candidates from another generation are rejected before fusion and again before context admission.

Every query and candidate carries the source identity tuple `worktreeId`, `scopeId`, `sourceSnapshotHash`, `fileHash`, `chunkId`, and line range. The client records the query-start source snapshot, and the server echoes the exact snapshot and generation in every result. Before a candidate enters the pack, the client re-reads the file and compares the current raw-file hash and range against the candidate. A changed file, deleted file, changed range, scope mismatch, or snapshot/generation mismatch rejects that candidate as stale or invalid; it cannot be repaired by accepting remote text. This is the consistency contract between the remote index snapshot and the local RetrievalPack.

The server-side index coordinator is the sole owner of the active-manifest store, index-job records, leases, and reconciliation. The client never infers readiness by probing Qdrant and Tantivy independently. The coordinator stages immutable Qdrant and Tantivy generations, validates both, and commits the active pointer with CAS against the expected base generation. Recovery is deterministic: a crash before the active-pointer commit leaves the old pointer active; a crash after the commit is reconciled by validating both referenced backends; an invalid post-commit pointer is marked blocked and repaired or rolled back without exposing a partial generation. Abandoned and superseded generation cleanup is owned by the coordinator's retention job and cannot remove the active generation or its manifest. The coordinator exposes the manifest and job state through the versioned client protocol, so this recovery guarantee remains valid across Nyan client restarts. Every manifest mutation and publish request carries a coordinator epoch and fencing token. Acquiring or renewing the single-writer lease advances the epoch when ownership changes; a request with an expired lease or older epoch/token is rejected before it can mutate a backend or the active pointer. Publish also requires the expected active generation and job id, so a late worker cannot publish after a newer job wins. The coordinator metadata store must durably preserve the epoch, active pointer, job lease, and CAS outcome; a high-availability implementation may use any durable single-writer or consensus mechanism, but deployment-level "there is only one process" is not sufficient as the protocol guarantee.

### 5. Bootstrap and incremental synchronization

When the client sees no active remote generation, it starts or joins an idempotent bootstrap job and immediately serves the request from core deterministic retrieval. While the job is building, core retrieval remains available. A restart resumes or observes the server job rather than silently starting duplicate work.

For source changes, the client computes file-level source hashes and sends an incremental sync against the current active generation. The sync handles additions, modifications, deletions, chunk-boundary changes, and old-chunk tombstones. It writes a staged result, validates both remote indexes, and publishes only after the manifest check succeeds.

The current active generation continues serving while an incremental generation is being built. A failed, cancelled, or unknown sync leaves the active generation unchanged and exposes a named degraded state. If the source changes again while a build is in progress, the finished generation is compared with the current source snapshot and a follow-up sync is scheduled; it is never silently presented as current.

Initial missing-index bootstrap is an explicit exception to the older "do not rebuild during query" rule. Stale-generation rebuilds remain independent background operations and are not implicitly launched as a full rebuild by an arbitrary query.

The coordinator uses the following durable job state machine:

```text
requested -> accepted -> building -> validating -> ready -> published
                         |             |             |
                         +----------> failed       abandoned
```

A job id is derived from the operation kind, worktree, scope, base generation, target source snapshot, and profile hash. The coordinator persists the job before accepting writes, grants one lease owner, records heartbeats/checkpoints, and makes retries idempotent by job id and chunk mutation key. A client restart calls `getJob(jobId)` before submitting another job. If the source snapshot changes during a build, the finished generation is either published as the exact snapshot it names and followed by a recorded delta job, or abandoned; it is never relabeled as current. An unknown client outcome is resolved by querying the coordinator, not by blindly replaying writes.

### 6. Query and context boundary

The query path is:

```text
embedding query -> Qdrant top 50
lexical query   -> Tantivy BM25 top 50
                    |
                 local RRF
                    |
              fused top 50
                    |
          one rerank request
                    |
     score threshold -> at most top 5
                    |
        local source inspect and re-read
                    |
            bounded context pack
```

RRF uses ranks, not incomparable dense/BM25/reranker scores. Deduplication uses a stable chunk locator including worktree, path, range, and generation. Tie-breaking is deterministic and recorded in the retrieval plan.

Remote text is never injected directly into the Agent context. Each selected candidate is re-read from the current local worktree and checked for path scope, source hash, line range, generation, and permissions. The final pack applies byte/token budgets and carries provenance plus degraded/coverage state. A retrieval candidate is advisory; it is not Evidence, a permission decision, or proof that no other match exists.

The retrieval package returns a provider-neutral `RetrievalPack`; it does not create or append an Agent context entry. Durable owns the recoverable retrieval task, Context Operation admission, conversion from a validated pack into a bounded `ContextUnit`, and persistence/recovery of that unit. Coding-agent owns product configuration, tool exposure, and presentation. Retrieval does not write Agent state directly. A pack with `index_unavailable`, `provider_unavailable`, `generation_mismatch`, stale source, or permission failures remains visible as coverage/degraded metadata; durable decides whether a validated subset can be admitted under its context budget.

Provider degradation is explicit and compositional:

| Observation | Remote path | Core path |
| --- | --- | --- |
| no active generation / bootstrap running | do not query remote indexes; mark index unavailable/building | return exact/structural immediately |
| embedding or Qdrant unavailable | semantic branch unavailable | lexical branch may continue; otherwise core |
| Tantivy unavailable | lexical branch unavailable | semantic branch may continue; otherwise core |
| reranker unavailable or invalid | use validated RRF order for a bounded fallback, marked degraded | core remains available |
| active generation stale or source fence fails | reject affected candidates; do not inject remote text | return core/current-source results |
| all remote branches unavailable | no remote context pack | return core results, never an empty-success claim |

### 7. Package and layer boundary

The proposed Nyan package is `@ny4n/retrieval`. Before implementation, it must be registered in `docs/architecture/layers.json`; the preferred placement is the capabilities layer with no dependency on coding-agent, durable, agent-core, or model provider catalogs. Provider-neutral contracts, client adapters, and deterministic fusion stay below the product composition root. The package exports retrieval contracts and a `RetrievalPack`, not durable ContextUnit types. Durable may depend on the capabilities package and owns the adapter from pack to ContextUnit; coding-agent composes settings, tools, and presentation above that boundary. Architecture and entry-graph checks must reject imports from retrieval into durable, coding-agent, or agent-core.

The separately deployed Tantivy/index-coordinator server is a service dependency, not a workspace package unless its source is intentionally brought into this repository under a separate architectural decision.

## Alternatives considered

- **Fixed local EmbeddingGemma branch:** Rejected. It conflicts with the owner's self-hosted optional-provider requirement and would make an unavailable external capability look like a product prerequisite.
- **Embedding and Tantivy implemented inside Nyan:** Rejected. It breaks the C/S boundary, complicates Bun/Node native deployment, and makes remote index ownership unclear.
- **Direct independent writes to Qdrant and Tantivy:** Rejected. Without one manifest protocol, the two branches can serve different generations.
- **Meilisearch as the BM25 backend:** Rejected for this proposal because the owner explicitly selected a self-built strict Tantivy/BM25 service. A lexical backend can be reconsidered only as a separate decision.
- **Blocking the first request until the full index is built:** Rejected. It makes first-use latency unbounded and turns an optional enhancement into a core-path failure.
- **Implicit full rebuild on every stale query:** Rejected. Rebuilds need their own budget, cancellation, idempotency, and recovery owner.

## Consequences

This proposal keeps the normal Nyan path usable without GPU or index services and makes the optional path replaceable. It requires a real versioned protocol between Nyan and a self-hosted index coordinator, a shared active-manifest contract, a durable server-side job store/lease, and readiness fixtures for the TEI endpoints. Incremental synchronization is more complex than rebuilding a local directory, but it avoids blocking requests and preserves the last known-good generation during failure. The remote coordinator is a required service contract for production-grade consistency; direct independent client writes to Qdrant and Tantivy are not an accepted implementation shortcut.

The roadmap now replaces its fixed EmbeddingGemma wording, expands Decision #4 to cover unified retrieval configuration and readiness, and records Decision #14 as the remote dual-index coordinator contract. R8/R9/R11/R13/R14/R20/G6/N6 now include bootstrap, incremental sync, generation fencing, provider degradation, source validation, and context admission gates. This note remains proposed because the implementation and live server behavior are not yet verified.

## Verification

- Read `ROADMAP.md` in full and identified conflicts in R8, R9, N6, the Retrieval section of Decided architecture, and Decisions #4 and #14.
- Read the retrieval service, semantic generation/index, and retrieval-worker reference documents.
- Checked the current workspace: `packages/retrieval/` does not exist; no implementation was added by this note.
- A first read-only Astra review on 2026-10-16 identified unresolved areas: dual-index publication, incremental recovery, TEI profile verification, bootstrap ownership, and package/context layering.
- This proposal revision closed those design choices by assigning manifest/job/reconciliation ownership to the server-side index coordinator, defining the job state machine and refusal/degradation matrix, making `RetrievalPack` the only retrieval-to-runtime boundary, and adding coordinator epoch/fencing plus source-snapshot/file-hash identity checks.
- A second Astra review identified coordinator fencing and source-snapshot consistency as the remaining details; both were added. The final read-only Astra review found no remaining architecture blocker and approved the roadmap update.
- On 2026-10-16, the relevant R8/R9/R11/R13/R14/R20/G6/N6 and Decision #4/#14 roadmap entries were updated. No code, service, live provider, or index build has been performed.
