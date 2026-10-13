/**
 * Canonical scope identity for durable Agent memory.
 *
 * Existing v1 requests accept a caller supplied `scopeKey` for compatibility.
 * New hosts should use this contract to derive that key instead of joining
 * identifiers by hand.  The encoded key is self describing, deterministic and
 * contains the workspace/project dimensions required to prevent cross-scope
 * reads.  No host path or filesystem operation is involved.
 */

import {
  PACTILE_LOGICAL_ID_PATTERN,
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  isPlainRecordV1,
} from "../../shared/validation.js";
import {
  ARTIFACT_SCOPE_KEY_MAX_LENGTH_V1,
  isArtifactScopeV1,
  type ArtifactScopeV1,
} from "./artifact-store.js";

export const MEMORY_SCOPE_DESCRIPTOR_SCHEMA_VERSION_V1 = 1 as const;
export const MEMORY_SCOPE_KEY_PREFIX_V1 = "scope-v1:" as const;

export type MemoryScopeDescriptorSchemaVersionV1 =
  typeof MEMORY_SCOPE_DESCRIPTOR_SCHEMA_VERSION_V1;

export interface MemoryScopeDescriptorV1 {
  readonly schemaVersion: MemoryScopeDescriptorSchemaVersionV1;
  readonly scope: ArtifactScopeV1;
  readonly workspaceId: string;
  readonly projectId: string;
  /** Required for `run`; optional for a run associated with no WorkItem. */
  readonly runId?: string;
  /** Required for `workItem`; forbidden for `project`. */
  readonly workItemId?: string;
}

export type MemoryScopeDescriptorInputV1 = Omit<
  MemoryScopeDescriptorV1,
  "schemaVersion"
> & { readonly schemaVersion?: MemoryScopeDescriptorSchemaVersionV1 };

export type MemoryScopeDescriptorIssueCodeV1 =
  | "invalid_descriptor"
  | "invalid_schema_version"
  | "invalid_scope"
  | "invalid_workspace_id"
  | "invalid_project_id"
  | "invalid_run_id"
  | "invalid_work_item_id"
  | "run_id_required"
  | "work_item_id_required"
  | "run_id_forbidden"
  | "work_item_id_forbidden"
  | "scope_key_too_long";

export interface MemoryScopeDescriptorIssueV1 {
  readonly code: MemoryScopeDescriptorIssueCodeV1;
  readonly message: string;
}

export type MemoryScopeDescriptorValidationV1 =
  | { readonly ok: true; readonly descriptor: MemoryScopeDescriptorV1 }
  | { readonly ok: false; readonly issue: MemoryScopeDescriptorIssueV1 };

export type MemoryScopeKeyDecodeV1 =
  | {
      readonly ok: true;
      readonly descriptor: MemoryScopeDescriptorV1;
      readonly scopeKey: string;
    }
  | { readonly ok: false; readonly issue: MemoryScopeDescriptorIssueV1 };

function issue(
  code: MemoryScopeDescriptorIssueCodeV1,
  message: string,
): MemoryScopeDescriptorValidationV1 {
  return Object.freeze({ ok: false as const, issue: Object.freeze({ code, message }) });
}

function id(value: unknown): value is string {
  return typeof value === "string" && PACTILE_LOGICAL_ID_PATTERN.test(value);
}

function descriptorBody(
  input: MemoryScopeDescriptorInputV1,
): MemoryScopeDescriptorV1 {
  return {
    schemaVersion: MEMORY_SCOPE_DESCRIPTOR_SCHEMA_VERSION_V1,
    scope: input.scope,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
  };
}

/** Validate scope identity and its scope-specific required/forbidden IDs. */
export function validateMemoryScopeDescriptorV1(
  input: unknown,
): MemoryScopeDescriptorValidationV1 {
  if (!isPlainRecordV1(input)) {
    return issue("invalid_descriptor", "memory scope descriptor must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!["schemaVersion", "scope", "workspaceId", "projectId", "runId", "workItemId"].includes(key)) {
      return issue("invalid_descriptor", `memory scope descriptor has an unsupported field: ${key}`);
    }
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    return issue("invalid_schema_version", "memory scope descriptor schemaVersion must be 1");
  }
  if (!isArtifactScopeV1(input.scope)) {
    return issue("invalid_scope", "memory scope descriptor scope is invalid");
  }
  if (!id(input.workspaceId)) {
    return issue("invalid_workspace_id", "workspaceId must be a lowercase logical id");
  }
  if (!id(input.projectId)) {
    return issue("invalid_project_id", "projectId must be a lowercase logical id");
  }
  if (input.runId !== undefined && !id(input.runId)) {
    return issue("invalid_run_id", "runId must be a lowercase logical id");
  }
  if (input.workItemId !== undefined && !id(input.workItemId)) {
    return issue("invalid_work_item_id", "workItemId must be a lowercase logical id");
  }
  if (input.scope === "run" && input.runId === undefined) {
    return issue("run_id_required", "run scope requires runId");
  }
  if (input.scope === "workItem" && input.workItemId === undefined) {
    return issue("work_item_id_required", "workItem scope requires workItemId");
  }
  if (input.scope !== "run" && input.runId !== undefined) {
    return issue("run_id_forbidden", "runId is only valid for run scope");
  }
  if (input.scope === "project" && input.workItemId !== undefined) {
    return issue("work_item_id_forbidden", "workItemId is forbidden for project scope");
  }
  // Every field has been checked above; this narrows the generic record
  // returned by `isPlainRecordV1` to the validated input shape.
  const descriptor = Object.freeze(
    descriptorBody(input as unknown as MemoryScopeDescriptorInputV1),
  ) as unknown as MemoryScopeDescriptorV1;
  return Object.freeze({ ok: true as const, descriptor });
}

/** Build the only canonical scope key format introduced by this contract. */
export function memoryScopeKeyV1(
  input: MemoryScopeDescriptorInputV1,
): string {
  const validated = validateMemoryScopeDescriptorV1(input);
  if (!validated.ok) throw new TypeError(validated.issue.message);
  const key = `${MEMORY_SCOPE_KEY_PREFIX_V1}${canonicalizePactileJsonV1(validated.descriptor)}`;
  if (key.length > ARTIFACT_SCOPE_KEY_MAX_LENGTH_V1) {
    throw new TypeError("memory scope key exceeds the maximum supported length");
  }
  return key;
}

/** Decode only canonical, versioned keys; arbitrary legacy keys are rejected. */
export function decodeMemoryScopeKeyV1(value: unknown): MemoryScopeKeyDecodeV1 {
  if (typeof value !== "string" || !value.startsWith(MEMORY_SCOPE_KEY_PREFIX_V1)) {
    return Object.freeze({
      ok: false as const,
      issue: Object.freeze({
        code: "invalid_descriptor" as const,
        message: "scopeKey is not a canonical scope-v1 key",
      }),
    });
  }
  const encoded = value.slice(MEMORY_SCOPE_KEY_PREFIX_V1.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    return Object.freeze({
      ok: false as const,
      issue: Object.freeze({
        code: "invalid_descriptor" as const,
        message: "scope-v1 key payload is not valid JSON",
      }),
    });
  }
  const validated = validateMemoryScopeDescriptorV1(parsed);
  if (!validated.ok) return validated;
  if (canonicalizePactileJsonV1(validated.descriptor) !== encoded) {
    return Object.freeze({
      ok: false as const,
      issue: Object.freeze({
        code: "invalid_descriptor" as const,
        message: "scope-v1 key is not canonical",
      }),
    });
  }
  return Object.freeze({ ok: true as const, descriptor: validated.descriptor, scopeKey: value });
}

export function isCanonicalMemoryScopeKeyV1(value: unknown): value is string {
  return decodeMemoryScopeKeyV1(value).ok;
}

export function memoryScopeDescriptorHashV1(
  input: MemoryScopeDescriptorInputV1,
): string {
  const validated = validateMemoryScopeDescriptorV1(input);
  if (!validated.ok) throw new TypeError(validated.issue.message);
  return fingerprintPactileContractV1({
    domain: "memory-scope-descriptor-v1",
    descriptor: validated.descriptor,
  });
}
