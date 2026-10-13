import { describe, expect, it } from "vitest";

import { decideContextSurgeryV1, type DurableExternalizationV1 } from "../../../../src/core/pactile/context-memory/index.js";

const durable: DurableExternalizationV1 = {
  status: "durable",
  path: "C:/Users/test/.pactile/memory/run-1.md",
  fingerprint: "sha256:memory-1",
  disclosed: true,
  whenToRead: "Read before choosing a previously discussed strategy.",
};

describe("context memory surgery policy", () => {
  it("uses mask first and preserves a recovery path without externalization", () => {
    const decision = decideContextSurgeryV1({ contextTokens: 12_000, contextWindow: 24_000, reserveTokens: 8_000, maskableToolResultTokens: 1_000 });
    expect(decision.action).toBe("mask");
    expect(decision.reason).toBe("mask_first");
    expect(decision.maskThreshold).toBe(12_000);
    expect(decision.compressionThreshold).toBe(16_000);
  });

  it("allows compact only after durable externalization and disclosure", () => {
    const decision = decideContextSurgeryV1({ contextTokens: 16_001, contextWindow: 24_000, reserveTokens: 8_000, maskableToolResultTokens: 0, externalization: durable });
    expect(decision.action).toBe("compact");
    expect(decision.assurance).toBe("assurance_exact");
    expect(decision.disclosure?.path).toBe(durable.path);
  });

  it("blocks compression when the durable copy or disclosure is unknown", () => {
    const base = { contextTokens: 16_001, contextWindow: 24_000, reserveTokens: 8_000, maskableToolResultTokens: 0 } as const;
    expect(decideContextSurgeryV1(base).reason).toBe("externalization_missing");
    expect(decideContextSurgeryV1({ ...base, externalization: { ...durable, status: "pending" } }).reason).toBe("externalization_not_durable");
    expect(decideContextSurgeryV1({ ...base, externalization: { ...durable, disclosed: false } }).reason).toBe("disclosure_missing");
  });

  it("caps mask threshold and retains the explicitly unverified percentage", () => {
    const decision = decideContextSurgeryV1({ contextTokens: 100_000, contextWindow: 1_000_000, reserveTokens: 16_384, maskableToolResultTokens: 0, externalization: durable });
    expect(decision.maskThreshold).toBe(100_000);
    expect(decision.clearAtLeastPercent).toBe(0.05);
    expect(decision.keep).toBe(3);
    expect(decision.action).toBe("continue");
  });

  it("rejects malformed thresholds and invalid disclosure", () => {
    expect(() => decideContextSurgeryV1({ contextTokens: 1, contextWindow: 1_000, reserveTokens: 1_000, maskableToolResultTokens: 0 })).toThrow(/reserveTokens/);
    const invalid = decideContextSurgeryV1({ contextTokens: 950, contextWindow: 1_000, reserveTokens: 100, maskableToolResultTokens: 0, externalization: { ...durable, fingerprint: null } });
    expect(invalid.action).toBe("blocked");
    expect(invalid.reason).toBe("disclosure_invalid");
  });
});


