import { describe, expect, it } from "vitest";

import {
  DEFAULT_GOVERNED_PROJECT_ID_V1,
  defaultGovernedWorkspaceIdV1,
  resolveGovernedRunScopeV1,
  runHasLedgerV1,
} from "../../../src/pactile/runtime/governed-run-session.js";
import type { RuntimeStoreRun } from "../../../src/pactile/runtime/store-port.js";

const ROOT = process.platform === "win32" ? "C:\\work\\repo-a" : "/work/repo-a";
const OTHER_ROOT = process.platform === "win32" ? "C:\\work\\repo-b" : "/work/repo-b";

function run(input: unknown, metadata: Record<string, unknown> = {}): RuntimeStoreRun {
  return {
    schemaVersion: 1,
    runId: "run-1",
    status: "completed",
    revision: 1,
    input,
    output: null,
    error: null,
    metadata,
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
  } as unknown as RuntimeStoreRun;
}

const LEDGER = { __pactileRunLedgerV1: { revision: 1 } };

describe("governed run memory scope", () => {
  it("names a new run's workspace from the repository root, stably, and its project by a fixed id", () => {
    const first = resolveGovernedRunScopeV1({ repositoryRoot: ROOT, existingRun: null });
    expect(first).toEqual({
      ok: true,
      workspaceId: defaultGovernedWorkspaceIdV1(ROOT),
      projectId: DEFAULT_GOVERNED_PROJECT_ID_V1,
      source: "default",
    });
    expect(defaultGovernedWorkspaceIdV1(ROOT)).toMatch(/^workspace-[0-9a-f]{16}$/u);
    expect(defaultGovernedWorkspaceIdV1(ROOT)).toBe(defaultGovernedWorkspaceIdV1(ROOT));
    expect(defaultGovernedWorkspaceIdV1(ROOT)).not.toBe(defaultGovernedWorkspaceIdV1(OTHER_ROOT));
    if (process.platform === "win32") {
      expect(defaultGovernedWorkspaceIdV1("C:\\Work\\Repo-A")).toBe(defaultGovernedWorkspaceIdV1(ROOT));
    }
  });

  it("uses what the caller names and defaults only the other half", () => {
    expect(
      resolveGovernedRunScopeV1({ repositoryRoot: ROOT, explicitWorkspaceId: "workspace-x", existingRun: null }),
    ).toEqual({ ok: true, workspaceId: "workspace-x", projectId: "agent-project", source: "explicit" });
    expect(
      resolveGovernedRunScopeV1({ repositoryRoot: ROOT, explicitProjectId: "project-y", existingRun: null }),
    ).toEqual({
      ok: true,
      workspaceId: defaultGovernedWorkspaceIdV1(ROOT),
      projectId: "project-y",
      source: "explicit",
    });
  });

  it("keeps the scope a run started with and refuses a different one", () => {
    const existing = run({ workspaceId: "workspace-first", projectId: "project-first" }, LEDGER);
    expect(resolveGovernedRunScopeV1({ repositoryRoot: ROOT, existingRun: existing })).toEqual({
      ok: true,
      workspaceId: "workspace-first",
      projectId: "project-first",
      source: "stored",
    });
    // Repeating the same ids is fine.
    expect(
      resolveGovernedRunScopeV1({
        repositoryRoot: ROOT,
        explicitWorkspaceId: "workspace-first",
        explicitProjectId: "project-first",
        existingRun: existing,
      }),
    ).toMatchObject({ ok: true, source: "stored" });
    for (const change of [{ explicitWorkspaceId: "workspace-other" }, { explicitProjectId: "project-other" }]) {
      expect(resolveGovernedRunScopeV1({ repositoryRoot: ROOT, existingRun: existing, ...change })).toEqual({
        ok: false,
        message: expect.stringContaining("cannot change them"),
      });
    }
  });

  it("does not guess a scope for a governed run that never recorded one", () => {
    const old = run({ promptHash: "x" }, LEDGER);
    expect(resolveGovernedRunScopeV1({ repositoryRoot: ROOT, existingRun: old })).toEqual({
      ok: false,
      message: expect.stringContaining("did not record its memory scope"),
    });
    expect(
      resolveGovernedRunScopeV1({ repositoryRoot: ROOT, explicitWorkspaceId: "workspace-x", existingRun: old }),
    ).toMatchObject({ ok: false });
    expect(
      resolveGovernedRunScopeV1({
        repositoryRoot: ROOT,
        explicitWorkspaceId: "workspace-x",
        explicitProjectId: "project-y",
        existingRun: old,
      }),
    ).toEqual({ ok: true, workspaceId: "workspace-x", projectId: "project-y", source: "explicit" });
  });

  it("treats an ungoverned earlier run as new, and ignores stored ids that are not logical ids", () => {
    expect(resolveGovernedRunScopeV1({ repositoryRoot: ROOT, existingRun: run({ promptHash: "x" }) })).toMatchObject({
      ok: true,
      source: "default",
    });
    expect(
      resolveGovernedRunScopeV1({
        repositoryRoot: ROOT,
        existingRun: run({ workspaceId: "Not A Logical Id", projectId: "project-first" }),
      }),
    ).toMatchObject({ ok: true, source: "default" });
  });

  it("tells a governed run from an ungoverned one by its RunLedger", () => {
    expect(runHasLedgerV1(null)).toBe(false);
    expect(runHasLedgerV1(run({}))).toBe(false);
    expect(runHasLedgerV1(run({}, LEDGER))).toBe(true);
  });
});
