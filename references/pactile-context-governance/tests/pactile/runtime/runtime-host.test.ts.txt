import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStoreUnsupportedError } from "../../../src/core/index.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-runtime-host-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const unsupportedDriver = (): unknown => ({ DatabaseSync: undefined });

describe("Pactile RuntimeStore host bootstrap", () => {
  it("requires an explicit repository root and never falls back to CWD", async () => {
    await expect(
      openPactileRuntimeHost({ repositoryRoot: "   " }),
    ).rejects.toMatchObject({
      code: "runtime_store_invalid_path",
      operation: "open-host",
    });
  });

  it("fails closed before creating .pactile when node:sqlite is unsupported", async () => {
    const root = fixture();
    await expect(
      openPactileRuntimeHost({ repositoryRoot: root, driver: unsupportedDriver }),
    ).rejects.toBeInstanceOf(RuntimeStoreUnsupportedError);
    expect(fs.existsSync(path.join(root, ".pactile"))).toBe(false);
  });

  it("opens the canonical store, exposes diagnostics and closes idempotently", async () => {
    const root = fixture();
    let host: PactileRuntimeHost | undefined;
    try {
      host = await openPactileRuntimeHost({ repositoryRoot: root });
    } catch (error) {
      // Node 18/unsupported CI remains an explicit unsupported result; it is
      // not a silent test skip or a memory-store substitute.
      expect(error).toBeInstanceOf(RuntimeStoreUnsupportedError);
      return;
    }
    expect(host.repositoryRoot).toBe(path.resolve(root));
    expect(host.databasePath).toBe(
      path.join(root, ".pactile", "runtime", "runtime-store.sqlite"),
    );
    expect(host.capability.supported).toBe(true);
    expect(host.diagnostics.databasePath).toBe(host.databasePath);
    expect(host.productKernelDiagnostics.databasePath).toBe(
      path.join(root, ".pactile", "runtime", "product-kernel-store.sqlite"),
    );
    expect(host.productKernelDiagnostics.snapshotRevision).toBe(0);
    expect(host.artifacts.storageRoot).toBe(
      path.join(root, ".pactile", "runtime", "memory-artifacts"),
    );
    const legacyScope = await host.memory.preflight({
      scope: "run",
      scopeKey: "workspace-1/project-1/run-1",
      basisRevision: 1,
      disclose: true,
    });
    expect(legacyScope.ok).toBe(false);
    if (legacyScope.ok) throw new Error("expected canonical scope enforcement");
    expect(legacyScope.code).toBe("memory_invalid_input");
    await host.close();
    await host.close();
    await expect(host.store.diagnostics()).rejects.toBeTruthy();
    await expect(host.productKernel.diagnostics()).rejects.toBeTruthy();
  });
});
