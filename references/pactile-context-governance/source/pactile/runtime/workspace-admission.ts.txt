/**
 * Pure repository-root provenance admission for Pactile Agent dispatch.
 *
 * This module is the fail-closed boundary that keeps a Task Kernel root, a
 * product repository root and a candidate worktree from being mistaken for one
 * another. Every fact is supplied explicitly by the caller: the module never
 * reads `process.cwd()`, an environment variable, a task directory, an
 * Electron current directory or the host filesystem, and it never starts a
 * process. No root is ever inferred from another root.
 *
 * The declaration side (`kernelRoot`, `repositoryRoot`, `managerProjectRoot`,
 * `managerCommonDir`, `expectedBaseSha`) is the Run's frozen provenance. A
 * dispatch with no candidate binding at all is refused with
 * `missing-workspace-binding`; the guard never treats "no binding" as consent. The
 * observation side (`candidateRoot`, `candidateCommonDir`, `candidateBaseSha`,
 * `writeSet`, `ownerRunId`) is what the host probed at the candidate worktree.
 * Admission succeeds only when every observed fact agrees with the declaration
 * and the write set is a non-empty set of relative project paths.
 *
 * Comparisons normalize Windows/POSIX separators, trailing slashes and case,
 * so `D:/Repo` and `d:\repo\` are the same identity on every host. The
 * admitted result keeps the caller's original spelling of each path so a host
 * can hand it to Git, Pi or a filesystem operation unchanged.
 */

import { fingerprintPactileContractV1 } from "../shared/validation.js";

export const REPOSITORY_WORKSPACE_ADMISSION_SCHEMA_VERSION = 1 as const;
export type RepositoryWorkspaceAdmissionSchemaVersion =
  typeof REPOSITORY_WORKSPACE_ADMISSION_SCHEMA_VERSION;

export const REPOSITORY_WORKSPACE_ADMISSION_REJECTION_REASONS = [
  "missing-workspace-binding",
  "kernel-root-mismatch",
  "repository-root-mismatch",
  "common-dir-mismatch",
  "base-sha-mismatch",
  "candidate-root-mismatch",
  "owner-run-mismatch",
  "empty-write-set",
  "unsafe-write-set",
] as const;
export type RepositoryWorkspaceAdmissionRejectionReason =
  (typeof REPOSITORY_WORKSPACE_ADMISSION_REJECTION_REASONS)[number];

/**
 * Candidate worktree facts observed by the host. This is the subset of the
 * admission request that an adapter can probe (Git common dir, commit SHA and
 * checkout path) plus the owning Run identity; the declaration side comes from
 * the Run's frozen provenance.
 */
export interface RepositoryWorkspaceCandidateBinding {
  /** Absolute worktree path of the candidate checkout; never the main root. */
  readonly candidateRoot: string;
  /** `git rev-parse --path-format=absolute --git-common-dir` at the candidate. */
  readonly candidateCommonDir: string;
  /** `git rev-parse HEAD` observed at the candidate checkout. */
  readonly candidateBaseSha: string;
  /**
   * Non-empty project-relative write set. A missing, empty or unsafe set must
   * fail closed before Pi is started; it is never widened to the whole tree.
   */
  readonly writeSet: readonly string[];
  /**
   * Run recorded as the owner of the candidate workspace. When both run ids
   * are supplied, a candidate already owned by another Run is rejected with
   * `owner-run-mismatch` instead of being silently reused.
   */
  readonly ownerRunId?: string | null;
  /** Run that is being dispatched into the candidate checkout. */
  readonly dispatchRunId?: string | null;
}

/** Every fact is explicit; no field is derived from another. */
export interface RepositoryWorkspaceAdmissionRequest
  extends RepositoryWorkspaceCandidateBinding {
  /** Task Kernel state root; distinct from the repository root. */
  readonly kernelRoot: string;
  /** Product repository root that owns the candidate checkout. */
  readonly repositoryRoot: string;
  /** Manager provenance project root; must equal `repositoryRoot`. */
  readonly managerProjectRoot: string;
  /** Manager provenance Git common dir; must equal the candidate common dir. */
  readonly managerCommonDir: string;
  /** Base SHA frozen by the Run; must equal the observed candidate SHA. */
  readonly expectedBaseSha: string;
}

export interface RepositoryWorkspaceAdmissionAdmitted {
  readonly outcome: "admitted";
  readonly schemaVersion: RepositoryWorkspaceAdmissionSchemaVersion;
  readonly kernelRoot: string;
  readonly repositoryRoot: string;
  readonly managerProjectRoot: string;
  readonly managerCommonDir: string;
  readonly candidateRoot: string;
  readonly candidateCommonDir: string;
  readonly baseSha: string;
  readonly ownerRunId: string | null;
  readonly dispatchRunId: string | null;
  readonly writeSet: readonly string[];
  readonly fingerprint: string;
}

export interface RepositoryWorkspaceAdmissionRejected {
  readonly outcome: "rejected";
  readonly schemaVersion: RepositoryWorkspaceAdmissionSchemaVersion;
  readonly reason: RepositoryWorkspaceAdmissionRejectionReason;
  readonly field: string;
  readonly message: string;
  readonly details: Readonly<Record<string, string>> | null;
}

export type RepositoryWorkspaceAdmissionResult =
  | RepositoryWorkspaceAdmissionAdmitted
  | RepositoryWorkspaceAdmissionRejected;

const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const DRIVE_PATH_PATTERN = /^[a-z]:\//iu;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const UNSAFE_WRITE_PATH_PATTERN = /[<>:"|?*[\]]/u;
const TRAILING_SLASHES_PATTERN = /\/+$/u;

/** Deterministic identity key for one path; never touches the filesystem. */
function normalizePath(value: string): string {
  const slashed = value.trim().replaceAll("\\", "/").replace(TRAILING_SLASHES_PATTERN, "");
  return (slashed.length === 0 ? "/" : slashed).toLowerCase();
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isWithin(parent: string, child: string): boolean {
  const parentPath = normalizePath(parent);
  const childPath = normalizePath(child);
  if (parentPath === "/") return childPath.startsWith("/");
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

function hasDotSegments(value: string): boolean {  return value
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

/**
 * Read one absolute, separator-clean path. Relative spellings, dot segments,
 * control characters and empty values fail closed.
 */
function readExplicitPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || CONTROL_CHARACTER_PATTERN.test(trimmed)) return null;
  const slashed = trimmed.replaceAll("\\", "/");
  if (!slashed.startsWith("/") && !DRIVE_PATH_PATTERN.test(slashed)) return null;
  if (hasDotSegments(slashed)) return null;
  const withoutTrailingSeparator = trimmed.replace(/[\\/]+$/u, "");
  return withoutTrailingSeparator.length === 0 ? trimmed : withoutTrailingSeparator;
}

function readCommitSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return COMMIT_SHA_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

function isMissingBinding(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

interface OptionalIdentifier {
  readonly ok: boolean;
  readonly value: string | null;
}

function readOptionalIdentifier(value: unknown): OptionalIdentifier {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, value: null };
  const trimmed = value.trim();
  if (trimmed.length === 0 || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    return { ok: false, value: null };
  }
  return { ok: true, value: trimmed };
}

interface NormalizedWriteSet {
  readonly ok: true;
  readonly paths: readonly string[];
}

interface InvalidWriteSet {
  readonly ok: false;
  readonly field: string;
  readonly message: string;
}

/**
 * Normalize the write set to concrete, relative, forward-slash paths. Wildcards,
 * absolute paths, drive letters, dot segments, stream names and control
 * characters are refused instead of being widened or rewritten.
 */
function normalizeWriteSet(entries: readonly unknown[]): NormalizedWriteSet | InvalidWriteSet {
  const byKey = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    const field = `writeSet[${index}]`;
    if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry) {
      return {
        ok: false,
        field,
        message: `${field} must be a non-empty relative project path without surrounding whitespace`,
      };
    }
    const slashed = entry.replaceAll("\\", "/");
    if (slashed.startsWith("/") || DRIVE_PATH_PATTERN.test(slashed)) {
      return {
        ok: false,
        field,
        message: `${field} must stay relative to the repository root`,
      };
    }
    const withoutLeadingDot = slashed.startsWith("./") ? slashed.slice(2) : slashed;
    const withoutTrailingSlash = withoutLeadingDot.replace(TRAILING_SLASHES_PATTERN, "");
    const segments = withoutTrailingSlash.split("/");
    if (
      withoutTrailingSlash.length === 0 ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      return {
        ok: false,
        field,
        message: `${field} must not contain empty or dot segments`,
      };
    }
    if (
      CONTROL_CHARACTER_PATTERN.test(withoutTrailingSlash) ||
      UNSAFE_WRITE_PATH_PATTERN.test(withoutTrailingSlash)
    ) {
      return {
        ok: false,
        field,
        message: `${field} must not contain wildcard, stream or control characters`,
      };
    }
    const key = withoutTrailingSlash.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, withoutTrailingSlash);
  }
  const paths = [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, path]) => path);
  return { ok: true, paths };
}

function rejected(
  reason: RepositoryWorkspaceAdmissionRejectionReason,
  field: string,
  message: string,
  details: Readonly<Record<string, string>> | null = null,
): RepositoryWorkspaceAdmissionRejected {
  return Object.freeze({
    outcome: "rejected" as const,
    schemaVersion: REPOSITORY_WORKSPACE_ADMISSION_SCHEMA_VERSION,
    reason,
    field,
    message,
    details,
  });
}

/**
 * Fail-closed rejection for a dispatch that carries no candidate workspace
 * binding at all. Kept in Core so the pure admission function and the CLI
 * runner return the exact same shape; `details` stays `null` (secret-safe).
 */
export function rejectMissingWorkspaceBinding(): RepositoryWorkspaceAdmissionRejected {
  return rejected(
    "missing-workspace-binding",
    "candidateRoot",
    "dispatch requires an explicit candidate workspace binding; provenance alone is not consent",
  );
}

/**
 * Deterministic, fail-closed admission of one explicit workspace binding.
 *
 * The check order is fixed and explainable: a missing binding first, then
 * structural root facts, then the git common directory, the frozen base SHA,
 * the candidate checkout, the owning Run and finally the write set. The first
 * disagreement is reported as a structured rejection; nothing is mutated and
 * nothing is spawned.
 *
 * A caller that supplies no candidate binding at all — a missing request, a
 * missing `candidateRoot`, or a candidate binding object with no
 * `candidateRoot` — is refused with `missing-workspace-binding` rather than
 * being silently admitted from provenance alone. `details` stays `null` for
 * this reason so the rejection is secret-safe and stable.
 */
export function admitRepositoryWorkspace(
  request: RepositoryWorkspaceAdmissionRequest,
): RepositoryWorkspaceAdmissionResult {
  // Runtime-defensive: a caller can hand over an incomplete object even though
  // the type declares every field, and that must reject instead of throwing.
  // A missing binding is a first-class fail-closed rejection, not an implicit
  // provenance-only admission.
  const raw = request as Partial<RepositoryWorkspaceAdmissionRequest> | null;
  if (raw === null || raw === undefined || isMissingBinding(raw.candidateRoot)) {
    return rejectMissingWorkspaceBinding();
  }

  const kernelRoot = readExplicitPath(raw?.kernelRoot);
  const repositoryRoot = readExplicitPath(raw?.repositoryRoot);
  if (kernelRoot === null) {
    return rejected(
      "kernel-root-mismatch",
      "kernelRoot",
      "kernelRoot must be an explicit absolute Task Kernel root",
      { kernelRoot: typeof raw?.kernelRoot === "string" ? raw.kernelRoot : "" },
    );
  }
  if (repositoryRoot === null) {
    return rejected(
      "repository-root-mismatch",
      "repositoryRoot",
      "repositoryRoot must be an explicit absolute product repository root",
      { repositoryRoot: typeof raw?.repositoryRoot === "string" ? raw.repositoryRoot : "" },
    );
  }
  // The Task Kernel root and the product repository root are peers, not
  // nested: equality was already refused above, and a kernel root living
  // inside the product repository root means one of the two facts was
  // misdeclared. The reverse nesting (a product root beneath the kernel root)
  // is a legitimate harness layout, so it stays admissible. The comparison is
  // generic path containment over normalized identities; no host path is
  // hardcoded here.
  if (isWithin(repositoryRoot, kernelRoot)) {
    return rejected(
      "kernel-root-mismatch",
      "kernelRoot",
      "the Task Kernel root must never be the product repository root or sit inside it",
      { kernelRoot, repositoryRoot },
    );
  }

  const managerProjectRoot = readExplicitPath(raw?.managerProjectRoot);
  if (managerProjectRoot === null || !samePath(managerProjectRoot, repositoryRoot)) {
    return rejected(
      "repository-root-mismatch",
      "managerProjectRoot",
      "manager provenance must point at the declared product repository root",
      {
        repositoryRoot,
        managerProjectRoot: typeof raw?.managerProjectRoot === "string" ? raw.managerProjectRoot : "",
      },
    );
  }

  const managerCommonDir = readExplicitPath(raw?.managerCommonDir);
  const candidateCommonDir = readExplicitPath(raw?.candidateCommonDir);
  const managerCommonDirKey = managerCommonDir === null ? null : normalizePath(managerCommonDir);
  if (
    managerCommonDir === null ||
    candidateCommonDir === null ||
    !samePath(managerCommonDir, candidateCommonDir) ||
    !isWithin(repositoryRoot, managerCommonDir) ||
    managerCommonDirKey?.endsWith("/.git") !== true
  ) {
    return rejected(
      "common-dir-mismatch",
      "managerCommonDir",
      "manager and candidate must share one Git common directory inside the product repository",
      {
        repositoryRoot,
        managerCommonDir: typeof raw?.managerCommonDir === "string" ? raw.managerCommonDir : "",
        candidateCommonDir: typeof raw?.candidateCommonDir === "string" ? raw.candidateCommonDir : "",
      },
    );
  }

  const expectedBaseSha = readCommitSha(raw?.expectedBaseSha);
  const candidateBaseSha = readCommitSha(raw?.candidateBaseSha);
  if (expectedBaseSha === null || candidateBaseSha === null || expectedBaseSha !== candidateBaseSha) {
    return rejected(
      "base-sha-mismatch",
      "candidateBaseSha",
      "the candidate checkout must sit on the Run's frozen base SHA",
      {
        expectedBaseSha: expectedBaseSha ?? "",
        candidateBaseSha: candidateBaseSha ?? "",
      },
    );
  }

  const candidateRoot = readExplicitPath(raw?.candidateRoot);
  if (
    candidateRoot === null ||
    samePath(candidateRoot, kernelRoot) ||
    samePath(candidateRoot, repositoryRoot) ||
    samePath(candidateRoot, managerCommonDir) ||
    isWithin(managerCommonDir, candidateRoot)
  ) {
    return rejected(
      "candidate-root-mismatch",
      "candidateRoot",
      "candidateRoot must be an explicit candidate worktree outside the main checkout and the Git common directory",
      {
        kernelRoot,
        repositoryRoot,
        candidateRoot: typeof raw?.candidateRoot === "string" ? raw.candidateRoot : "",
      },
    );
  }

  const ownerRunId = readOptionalIdentifier(raw?.ownerRunId);
  const dispatchRunId = readOptionalIdentifier(raw?.dispatchRunId);
  if (
    !ownerRunId.ok ||
    !dispatchRunId.ok ||
    (ownerRunId.value !== null &&
      dispatchRunId.value !== null &&
      ownerRunId.value !== dispatchRunId.value)
  ) {
    return rejected(
      "owner-run-mismatch",
      "ownerRunId",
      "a candidate workspace owned by another Run must not be reused",
      {
        ownerRunId: ownerRunId.value ?? (typeof raw?.ownerRunId === "string" ? raw.ownerRunId : ""),
        dispatchRunId:
          dispatchRunId.value ?? (typeof raw?.dispatchRunId === "string" ? raw.dispatchRunId : ""),
      },
    );
  }

  const requestedWriteSet = raw?.writeSet;
  if (!Array.isArray(requestedWriteSet) || requestedWriteSet.length === 0) {
    return rejected(
      "empty-write-set",
      "writeSet",
      "the candidate binding must declare a non-empty write set",
      { candidateRoot },
    );
  }
  const writeSet = normalizeWriteSet(requestedWriteSet);
  if (!writeSet.ok) {
    return rejected("unsafe-write-set", writeSet.field, writeSet.message, { candidateRoot });
  }

  const fingerprint = fingerprintPactileContractV1({
    schemaVersion: REPOSITORY_WORKSPACE_ADMISSION_SCHEMA_VERSION,
    domain: "repository-workspace-admission-v1",
    kernelRoot: normalizePath(kernelRoot),
    repositoryRoot: normalizePath(repositoryRoot),
    managerProjectRoot: normalizePath(managerProjectRoot),
    managerCommonDir: normalizePath(managerCommonDir),
    candidateRoot: normalizePath(candidateRoot),
    candidateCommonDir: normalizePath(candidateCommonDir),
    baseSha: expectedBaseSha,
    ownerRunId: ownerRunId.value,
    dispatchRunId: dispatchRunId.value,
    writeSet: writeSet.paths,
  });

  return Object.freeze({
    outcome: "admitted" as const,
    schemaVersion: REPOSITORY_WORKSPACE_ADMISSION_SCHEMA_VERSION,
    kernelRoot,
    repositoryRoot,
    managerProjectRoot,
    managerCommonDir,
    candidateRoot,
    candidateCommonDir,
    baseSha: expectedBaseSha,
    ownerRunId: ownerRunId.value,
    dispatchRunId: dispatchRunId.value,
    writeSet: Object.freeze([...writeSet.paths]),
    fingerprint,
  });
}
