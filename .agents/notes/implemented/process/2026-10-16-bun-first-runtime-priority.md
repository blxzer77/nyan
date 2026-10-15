# Agent Note: Bun-first runtime priority

Status: implemented

## Problem

Nyan supports both Node and Bun, but treating Bun as a secondary compatibility target can let Node-specific APIs and runtime assumptions enter the product path before Bun behavior is verified. That is especially risky for the durable runtime, subprocesses, workers, HTTP, WebSocket, SQLite, and source loading.

## Decision

Bun is Nyan's primary runtime and the main operational target. New runtime-facing code is designed and verified Bun-first, while preserving Node compatibility. Runtime differences are handled through explicit adapters or portable APIs rather than scattered Node-only assumptions. CI and focused validation must include Bun for changes that touch runtime behavior; Bun failures are product failures, not optional-platform failures.

## Alternatives considered

**Node-first with Bun compatibility fixes later.** Rejected because it makes the primary product runtime follow a secondary implementation path and defers discovery of Bun-specific failures.

**Treat Node and Bun as equal but independent targets.** Rejected because it provides no tie-breaker when APIs, startup behavior, subprocesses, workers, or persistence semantics differ.

**Use Bun-only APIs throughout the product.** Rejected because Nyan still preserves a supported Node path and must keep the runtime boundary explicit.

## Consequences

Bun behavior drives runtime API choices, test selection, and acceptance criteria. New adapters and durable integrations must be checked under Bun before being considered complete, and Node-only APIs require a deliberate boundary. Some changes may need separate Bun and Node implementations behind one stable contract.

## Verification

The Bun CI and parity baseline remains active. The durable N1 pull request includes the existing Bun build/test jobs; its CI result is pending at the time this decision was recorded.
