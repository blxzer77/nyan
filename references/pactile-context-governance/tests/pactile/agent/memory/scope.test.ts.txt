import { describe, expect, it } from "vitest";

import {
  decodeMemoryScopeKeyV1,
  isCanonicalMemoryScopeKeyV1,
  memoryScopeDescriptorHashV1,
  memoryScopeKeyV1,
  validateMemoryScopeDescriptorV1,
} from "../../../../src/pactile/agent/memory/scope.js";

describe("canonical memory scope", () => {
  const run = {
    scope: "run" as const,
    workspaceId: "workspace-1",
    projectId: "project-1",
    workItemId: "work-item-1",
    runId: "run-1",
  };

  it("round-trips a deterministic scope-v1 key", () => {
    const first = memoryScopeKeyV1(run);
    const second = memoryScopeKeyV1({
      runId: "run-1",
      workItemId: "work-item-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      scope: "run",
    });
    expect(first).toBe(second);
    expect(first).toContain('"projectId":"project-1"');
    expect(first).toContain('"workspaceId":"workspace-1"');
    expect(isCanonicalMemoryScopeKeyV1(first)).toBe(true);
    const decoded = decodeMemoryScopeKeyV1(first);
    expect(decoded).toMatchObject({ ok: true, scopeKey: first });
    if (!decoded.ok) throw new Error(decoded.issue.message);
    expect(decoded.descriptor).toEqual({
      schemaVersion: 1,
      scope: "run",
      workspaceId: "workspace-1",
      projectId: "project-1",
      runId: "run-1",
      workItemId: "work-item-1",
    });
    expect(memoryScopeDescriptorHashV1(run)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("requires and forbids identifiers according to the scope", () => {
    expect(validateMemoryScopeDescriptorV1({
      scope: "run",
      workspaceId: "workspace-1",
      projectId: "project-1",
    })).toMatchObject({ ok: false, issue: { code: "run_id_required" } });
    expect(validateMemoryScopeDescriptorV1({
      scope: "project",
      workspaceId: "workspace-1",
      projectId: "project-1",
      runId: "run-1",
    })).toMatchObject({ ok: false, issue: { code: "run_id_forbidden" } });
    expect(validateMemoryScopeDescriptorV1({
      scope: "workItem",
      workspaceId: "workspace-1",
      projectId: "project-1",
      runId: "run-1",
      workItemId: "work-item-1",
    })).toMatchObject({ ok: false, issue: { code: "run_id_forbidden" } });
  });

  it("rejects non-canonical or malformed keys before host lookup", () => {
    const key = memoryScopeKeyV1(run);
    expect(decodeMemoryScopeKeyV1(key.replace("project-1", "Project-1"))).toMatchObject({
      ok: false,
      issue: { code: "invalid_project_id" },
    });
    expect(decodeMemoryScopeKeyV1(`${key} `)).toMatchObject({ ok: false });
    expect(decodeMemoryScopeKeyV1("scope-v1:{not-json}")).toMatchObject({ ok: false });
    expect(isCanonicalMemoryScopeKeyV1("workspace-1/project-1/run-1")).toBe(false);
  });
});
