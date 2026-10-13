import { PACTILE_CONTRACT_SCHEMA_VERSION } from "../../shared/validation.js";
import type { RunTerminalStatus } from "../../agent/lifecycle-bridge.js";

export interface PiExecutorIdempotencyInputV1 {
  readonly workItemId: string;
  readonly blockId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly piSessionId: string;
  readonly piOperationId: string;
  readonly epoch: number;
  readonly semanticFingerprint: string;
  readonly writeSet: readonly string[];
  readonly baseSha: string;
}

export const PI_EXECUTOR_BINDING_OUTCOMES_V1 = ["admitted", "rejected"] as const;
export type PiExecutorBindingOutcomeV1 =
  (typeof PI_EXECUTOR_BINDING_OUTCOMES_V1)[number];

export const PI_EXECUTOR_BINDING_REASONS_V1 = [
  "missing-workspace-binding",
  "missing-repository-root",
  "kernel-root-mismatch",
  "repository-root-mismatch",
  "candidate-root-mismatch",
  "common-dir-mismatch",
  "base-sha-mismatch",
  "owner-run-mismatch",
  "empty-write-set",
  "unsafe-write-set",
  "write-set-overflow",
] as const;
export type PiExecutorBindingReasonV1 =
  (typeof PI_EXECUTOR_BINDING_REASONS_V1)[number];

export interface PiExecutorRepositoryIdentityV1 {
  readonly kernelRoot: string;
  readonly repositoryRoot: string;
  readonly managerProjectRoot: string;
  readonly managerCommonDir: string;
  readonly baseSha: string;
}

export interface PiExecutorBindingFactsV1 {
  readonly candidateRoot: string;
  readonly candidateCommonDir: string;
  readonly candidateBaseSha: string;
  readonly writeSet: readonly string[];
  readonly ownerRunId: string | null;
  readonly dispatchRunId: string | null;
}

export interface PiExecutorBindingAdmittedV1 {
  readonly outcome: "admitted";
  readonly kernelRoot: string;
  /** Canonical product repository identity; never Pi's working directory. */
  readonly repositoryRoot: string;
  /** The isolated candidate worktree the Pi host is bound to (Pi's cwd). */
  readonly candidateRoot: string;
  readonly baseSha: string;
  readonly writeSet: readonly string[];
  readonly writeSetFingerprint: string;
}

export interface PiExecutorBindingRejectedV1 {
  readonly outcome: "rejected";
  readonly reason: PiExecutorBindingReasonV1;
  readonly field: string;
  readonly details: string | null;
}

export type PiExecutorBindingResultV1 =
  | PiExecutorBindingAdmittedV1
  | PiExecutorBindingRejectedV1;

export interface RepositoryWorkspaceCandidateBinding {
  readonly candidateRoot: string;
  readonly candidateCommonDir: string;
  readonly candidateBaseSha: string;
  readonly writeSet: readonly string[];
  readonly ownerRunId?: string | null;
  readonly dispatchRunId?: string | null;
}

export interface RepositoryWorkspaceAdmissionRequest {
  readonly kernelRoot: string;
  readonly repositoryRoot: string;
  readonly managerProjectRoot: string;
  readonly managerCommonDir: string;
  readonly expectedBaseSha: string;
  readonly candidateRoot: string;
  readonly candidateCommonDir: string;
  readonly candidateBaseSha: string;
  readonly writeSet: readonly string[];
  readonly ownerRunId?: string | null;
  readonly dispatchRunId?: string | null;
  readonly observedWriteSet?: readonly string[] | null;
}

export type RepositoryWorkspaceAdmissionResult = PiExecutorBindingResultV1;
export type RepositoryWorkspaceAdmissionAdmitted = PiExecutorBindingAdmittedV1;
export type RepositoryWorkspaceAdmissionRejected = PiExecutorBindingRejectedV1;
export type RepositoryWorkspaceAdmissionRejectionReason =
  PiExecutorBindingReasonV1;

export const PI_EXECUTOR_ATTEMPT_DISPOSITIONS_V1 = [
  "fresh",
  "replay",
  "resume",
  "restart",
  "reject",
] as const;
export type PiExecutorAttemptDispositionV1 =
  (typeof PI_EXECUTOR_ATTEMPT_DISPOSITIONS_V1)[number];

export interface PiExecutorAttemptFactsV1 {
  readonly requestId: string;
  readonly requestHash: string;
  readonly semanticFingerprint: string;
  readonly effectsKnown: boolean;
}

export interface PiExecutorAttemptPriorV1 extends PiExecutorAttemptFactsV1 {
  readonly settled: boolean;
}

export interface PiExecutorAttemptPlanV1 {
  readonly disposition: PiExecutorAttemptDispositionV1;
  readonly reason: PiExecutorReasonCodeV1;
  /** A replayed request must be answered from the recorded Run Result. */
  readonly reusePriorResult: boolean;
}

export const PI_EXECUTOR_HOST_KINDS_V1 = ["native", "controller"] as const;
export type PiExecutorHostKindV1 = (typeof PI_EXECUTOR_HOST_KINDS_V1)[number];

/**
 * Pi host receipt vocabulary, mirrored from the RPC transport so this contract
 * stays free of any CLI/Node import.
 */
export const PI_EXECUTOR_PI_STATUSES_V1 = [
  "settled",
  "handled",
  "failed",
  "timed_out",
  "process_exited",
] as const;
export type PiExecutorPiStatusV1 = (typeof PI_EXECUTOR_PI_STATUSES_V1)[number];

export const PI_EXECUTOR_RUN_OUTCOMES_V1 = [
  "result_submitted",
  "waiting",
  "rejected",
  "failed",
  "cancelled",
  "timed_out",
  "provider_error",
  "unknown_effects",
] as const;
export type PiExecutorRunOutcomeV1 =
  (typeof PI_EXECUTOR_RUN_OUTCOMES_V1)[number];

export const PI_EXECUTOR_REASON_CODES_V1 = [
  "none",
  "host-unbound",
  "host-not-native",
  "missing-native-receipt",
  "missing-terminal-fact",
  "effects-unknown",
  "evidence-missing",
  "gate-missing",
  "run-cancelled",
  "run-timed-out",
  "provider-error",
  "admission-rejected",
  "binding-rejected",
  "request-conflict",
  "already-settled",
  "semantic-changed",
] as const;
export type PiExecutorReasonCodeV1 =
  (typeof PI_EXECUTOR_REASON_CODES_V1)[number];

export interface PiExecutorTerminalFactV1 {
  readonly status: RunTerminalStatus;
  readonly receiptId: string;
  readonly effectsKnown: boolean;
  readonly resultHash: string | null;
}

export interface PiExecutorOutcomeFactsV1 {
  readonly admissionAccepted: boolean;
  readonly bindingAdmitted: boolean;
  readonly hostAttempted: boolean;
  readonly hostBound: boolean;
  /** An exception escaped the host call; the attempt cannot claim success. */
  readonly hostFailed: boolean;
  readonly hostKind: PiExecutorHostKindV1 | null;
  readonly cancelRequested: boolean;
  readonly piStatus: PiExecutorPiStatusV1 | null;
  readonly terminal: PiExecutorTerminalFactV1 | null;
  readonly evidenceAccepted: boolean;
  readonly gateAccepted: boolean;
}

export interface PiExecutorOutcomeDecisionV1 {
  readonly outcome: PiExecutorRunOutcomeV1;
  readonly reason: PiExecutorReasonCodeV1;
  readonly retryable: boolean;
  /** True only for a native Pi host receipt that Pactile may treat as terminal. */
  readonly nativeReceiptAuthoritative: boolean;
  /** Always false: a Run Result never closes a WorkItem. */
  readonly workItemCompleted: false;
}

export interface PiExecutorRunResultV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly resultId: string;
  readonly workItemId: string;
  readonly blockId: string;
  /** `null` when no Run was dispatched (rejection or replay-less failure). */
  readonly runId: string | null;
  readonly requestId: string;
  readonly requestHash: string;
  readonly piSessionId: string;
  readonly piOperationId: string;
  readonly epoch: number;
  readonly semanticFingerprint: string;
  /** Product repository identity; never Pi's working directory. */
  readonly repositoryRoot: string;
  /** Candidate worktree actually bound to the Pi host; `null` if unbound. */
  readonly hostWorkspaceRoot: string | null;
  readonly baseSha: string;
  readonly writeSet: readonly string[];
  readonly observedWriteSet: readonly string[];
  readonly bindingOutcome: PiExecutorBindingOutcomeV1 | null;
  readonly bindingReason: PiExecutorBindingReasonV1 | null;
  readonly hostKind: PiExecutorHostKindV1 | null;
  readonly hostBound: boolean;
  readonly piStatus: PiExecutorPiStatusV1 | null;
  readonly outcome: PiExecutorRunOutcomeV1;
  readonly reason: PiExecutorReasonCodeV1;
  readonly retryable: boolean;
  readonly nativeReceiptAuthoritative: boolean;
  readonly terminalStatus: RunTerminalStatus | null;
  readonly terminalReceiptId: string | null;
  readonly terminalEffectsKnown: boolean | null;
  readonly evidenceAccepted: boolean;
  readonly gateAccepted: boolean;
  /** The Pactile AgentRun settlement receipt exists; unrelated to WorkItem close. */
  readonly settled: boolean;
  /** Always false; the Kernel alone owns WorkItem/Block close decisions. */
  readonly workItemCompleted: false;
  readonly idempotencyKey: string;
  readonly attemptDisposition: PiExecutorAttemptDispositionV1;
  /** Prior Run Result this attempt supersedes, when it is a restart/resume. */
  readonly supersedesResultId: string | null;
  readonly envelopeFingerprints: readonly string[];
  readonly envelopeErrorCount: number;
  readonly createdAt: string;
}

export interface PiExecutorRunResultInputV1 {
  readonly resultId: string;
  readonly workItemId: string;
  readonly blockId: string;
  readonly runId: string | null;
  readonly requestId: string;
  readonly requestHash: string;
  readonly piSessionId: string;
  readonly piOperationId: string;
  readonly epoch: number;
  readonly semanticFingerprint: string;
  readonly repositoryRoot: string;
  readonly hostWorkspaceRoot: string | null;
  readonly baseSha: string;
  readonly writeSet: readonly string[];
  readonly observedWriteSet: readonly string[];
  readonly bindingOutcome: PiExecutorBindingOutcomeV1 | null;
  readonly bindingReason: PiExecutorBindingReasonV1 | null;
  readonly hostKind: PiExecutorHostKindV1 | null;
  readonly hostBound: boolean;
  readonly piStatus: PiExecutorPiStatusV1 | null;
  readonly decision: PiExecutorOutcomeDecisionV1;
  readonly terminal: PiExecutorTerminalFactV1 | null;
  readonly evidenceAccepted: boolean;
  readonly gateAccepted: boolean;
  readonly settled: boolean;
  readonly idempotencyKey: string;
  readonly attemptDisposition: PiExecutorAttemptDispositionV1;
  readonly supersedesResultId: string | null;
  readonly envelopeFingerprints: readonly string[];
  readonly envelopeErrorCount: number;
  readonly createdAt?: string;
}
