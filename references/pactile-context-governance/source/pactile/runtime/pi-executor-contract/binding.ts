import { fingerprintPactileContractV1 } from "../../shared/validation.js";
import { ABSOLUTE_PATH_V1, HEX_SHA_V1 } from "./helpers.js";
import type {
  PiExecutorBindingFactsV1,
  PiExecutorBindingReasonV1,
  PiExecutorBindingRejectedV1,
  PiExecutorBindingResultV1,
  PiExecutorRepositoryIdentityV1,
  RepositoryWorkspaceAdmissionRequest,
  RepositoryWorkspaceAdmissionResult,
} from "./types.js";

function normalizePathV1(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function bindingRejectionV1(
  reason: PiExecutorBindingReasonV1,
  field: string,
  details: string | null = null,
): PiExecutorBindingRejectedV1 {
  return Object.freeze({ outcome: "rejected" as const, reason, field, details });
}

/**
 * Fail-closed repository/workspace binding check.
 *
 * Ordering is deliberate: a missing binding, a misdeclared kernel root and an
 * aliased candidate root are checked before Git identity, and Git identity is
 * checked before the write set, so the first reported reason is the most
 * authoritative structural fault.
 *
 * `observedWriteSet` is an optional post-hoc observation; when supplied it must
 * stay inside the frozen declared set or the binding is refused as
 * `write-set-overflow`.
 */
export function validatePiExecutorBindingV1(
  identity: PiExecutorRepositoryIdentityV1 | null | undefined,
  facts: PiExecutorBindingFactsV1 | null | undefined,
  observedWriteSet?: readonly string[] | null,
): PiExecutorBindingResultV1 {
  if (facts === null || facts === undefined || typeof facts !== "object") {
    return bindingRejectionV1("missing-workspace-binding", "candidateRoot");
  }
  if (identity === null || identity === undefined || typeof identity !== "object") {
    return bindingRejectionV1("missing-repository-root", "repositoryRoot");
  }

  const kernelRoot =
    typeof identity.kernelRoot === "string" ? identity.kernelRoot.trim() : "";
  const repositoryRoot =
    typeof identity.repositoryRoot === "string"
      ? identity.repositoryRoot.trim()
      : "";
  const managerProjectRoot =
    typeof identity.managerProjectRoot === "string"
      ? identity.managerProjectRoot.trim()
      : "";
  const managerCommonDir =
    typeof identity.managerCommonDir === "string"
      ? identity.managerCommonDir.trim()
      : "";
  const baseSha =
    typeof identity.baseSha === "string" ? identity.baseSha.trim() : "";
  const candidateRoot =
    typeof facts.candidateRoot === "string" ? facts.candidateRoot.trim() : "";

  if (repositoryRoot.length === 0) {
    return bindingRejectionV1("missing-repository-root", "repositoryRoot");
  }
  if (candidateRoot.length === 0) {
    return bindingRejectionV1("missing-workspace-binding", "candidateRoot");
  }
  if (kernelRoot.length === 0) {
    return bindingRejectionV1("kernel-root-mismatch", "kernelRoot");
  }

  const kernel = normalizePathV1(kernelRoot);
  const repository = normalizePathV1(repositoryRoot);
  const managerRoot = normalizePathV1(managerProjectRoot);
  const managerCommon = normalizePathV1(managerCommonDir);
  const candidate = normalizePathV1(candidateRoot);

  if (kernel === repository) {
    return bindingRejectionV1("kernel-root-mismatch", "kernelRoot");
  }
  // The documented misdeclaration: a Task Kernel root nested inside the
  // product repository would make the "candidate" ambiguous with the checkout.
  if (kernel.startsWith(`${repository}/`)) {
    return bindingRejectionV1("kernel-root-mismatch", "kernelRoot");
  }
  if (managerRoot !== repository) {
    return bindingRejectionV1("repository-root-mismatch", "managerProjectRoot");
  }
  if (
    candidate === repository ||
    candidate === kernel ||
    candidate.startsWith(`${repository}/`) ||
    repository.startsWith(`${candidate}/`)
  ) {
    return bindingRejectionV1("candidate-root-mismatch", "candidateRoot");
  }

  if (managerCommon.length === 0 || !managerCommon.endsWith("/.git")) {
    return bindingRejectionV1("common-dir-mismatch", "managerCommonDir");
  }
  const candidateCommon = normalizePathV1(
    typeof facts.candidateCommonDir === "string" ? facts.candidateCommonDir : "",
  );
  if (candidateCommon.length === 0 || candidateCommon !== managerCommon) {
    return bindingRejectionV1("common-dir-mismatch", "candidateCommonDir");
  }

  const candidateBaseSha =
    typeof facts.candidateBaseSha === "string"
      ? facts.candidateBaseSha.trim().toLowerCase()
      : "";
  if (!HEX_SHA_V1.test(baseSha) || candidateBaseSha !== baseSha.toLowerCase()) {
    return bindingRejectionV1("base-sha-mismatch", "candidateBaseSha");
  }

  if (!Array.isArray(facts.writeSet) || facts.writeSet.length === 0) {
    return bindingRejectionV1("empty-write-set", "writeSet");
  }
  const writeSetParts: string[] = [];
  for (const entry of facts.writeSet) {
    if (typeof entry !== "string") {
      return bindingRejectionV1("unsafe-write-set", "writeSet");
    }
    const path = entry.replaceAll("\\", "/");
    if (
      path.trim().length === 0 ||
      path.startsWith("/") ||
      ABSOLUTE_PATH_V1.test(path) ||
      path.split("/").includes("..") ||
      path.includes("\0")
    ) {
      return bindingRejectionV1("unsafe-write-set", "writeSet");
    }
    writeSetParts.push(path);
  }

  if (observedWriteSet !== undefined && observedWriteSet !== null) {
    if (!Array.isArray(observedWriteSet)) {
      return bindingRejectionV1("write-set-overflow", "observedWriteSet");
    }
    const allowed = new Set(writeSetParts);
    for (const entry of observedWriteSet) {
      if (typeof entry !== "string" || !allowed.has(entry.replaceAll("\\", "/"))) {
        return bindingRejectionV1("write-set-overflow", "observedWriteSet");
      }
    }
  }

  const ownerRunId =
    typeof facts.ownerRunId === "string" ? facts.ownerRunId.trim() : "";
  const dispatchRunId =
    typeof facts.dispatchRunId === "string" ? facts.dispatchRunId.trim() : "";
  if (
    ownerRunId.length === 0 ||
    dispatchRunId.length === 0 ||
    ownerRunId !== dispatchRunId
  ) {
    return bindingRejectionV1("owner-run-mismatch", "ownerRunId");
  }

  const frozenWriteSet = Object.freeze([...writeSetParts]);
  return Object.freeze({
    outcome: "admitted" as const,
    kernelRoot,
    repositoryRoot,
    candidateRoot,
    baseSha: baseSha.toLowerCase(),
    writeSet: frozenWriteSet,
    writeSetFingerprint: fingerprintPactileContractV1(
      [...frozenWriteSet].sort((left, right) => left.localeCompare(right)),
    ),
  });
}


/**
 * Fail-closed repository-root admission for one candidate worktree.
 *
 * The canonical product `repositoryRoot` is an identity fact used for
 * provenance and Git common-dir agreement; the admitted `candidateRoot` is the
 * isolated worktree a host may actually run in. The two are never interchangeable.
 */
export function admitRepositoryWorkspace(
  request: RepositoryWorkspaceAdmissionRequest,
): RepositoryWorkspaceAdmissionResult {
  return validatePiExecutorBindingV1(
    {
      kernelRoot: request.kernelRoot,
      repositoryRoot: request.repositoryRoot,
      managerProjectRoot: request.managerProjectRoot,
      managerCommonDir: request.managerCommonDir,
      baseSha: request.expectedBaseSha,
    },
    {
      candidateRoot: request.candidateRoot,
      candidateCommonDir: request.candidateCommonDir,
      candidateBaseSha: request.candidateBaseSha,
      writeSet: request.writeSet,
      ownerRunId: request.ownerRunId ?? null,
      dispatchRunId: request.dispatchRunId ?? null,
    },
    request.observedWriteSet ?? null,
  );
}

/** The explicit "no candidate was supplied" rejection. */
export function rejectMissingWorkspaceBinding(): PiExecutorBindingRejectedV1 {
  return Object.freeze({
    outcome: "rejected" as const,
    reason: "missing-workspace-binding" as const,
    field: "candidateRoot",
    details: null,
  });
}
