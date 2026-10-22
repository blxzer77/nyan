import { describe, expect, it } from "vitest";
import { type AdmissionMeasure, decideAdmission } from "../src/context/admission.ts";

type Row = { readonly name: string; readonly measure: AdmissionMeasure; readonly expected: string };

describe("decideAdmission", () => {
	const rows: readonly Row[] = [
		{
			name: "an under-budget context continues",
			measure: { estimated: 100, budget: 200, hasMaskable: false },
			expected: "continue",
		},
		{
			name: "a context exactly at its budget continues",
			measure: { estimated: 200, budget: 200, hasMaskable: true },
			expected: "continue",
		},
		{
			name: "an over-budget context with a maskable entry masks",
			measure: { estimated: 201, budget: 200, hasMaskable: true },
			expected: "mask",
		},
		{
			name: "an over-budget context with nothing to mask compacts",
			measure: { estimated: 201, budget: 200, hasMaskable: false },
			expected: "compact",
		},
		{
			name: "an empty context continues",
			measure: { estimated: 0, budget: 0, hasMaskable: true },
			expected: "continue",
		},
	];
	for (const row of rows) {
		it(row.name, () => {
			expect(decideAdmission(row.measure)).toBe(row.expected);
		});
	}

	const refused: readonly { readonly measure: AdmissionMeasure; readonly message: string }[] = [
		{
			measure: { estimated: Number.NaN, budget: 200, hasMaskable: true },
			message: "Estimated tokens must be finite and non-negative, got NaN",
		},
		{
			measure: { estimated: 100, budget: -1, hasMaskable: true },
			message: "Token budget must be finite and non-negative, got -1",
		},
		{
			measure: { estimated: Number.POSITIVE_INFINITY, budget: 200, hasMaskable: false },
			message: "Estimated tokens must be finite and non-negative, got Infinity",
		},
	];
	for (const row of refused) {
		it(`refuses the measurement ${JSON.stringify(row.measure)}`, () => {
			expect(() => decideAdmission(row.measure)).toThrow(new RangeError(row.message));
		});
	}
});
