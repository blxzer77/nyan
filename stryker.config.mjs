export default {
	testRunner: "vitest",
	coverageAnalysis: "perTest",
	mutate: ["packages/protocol/src/cbor/**/*.ts"],
	vitest: {
		related: false,
		dir: "packages/protocol",
		configFile: "packages/protocol/vitest.config.ts",
	},
	reporters: ["clear-text", "json"],
	jsonReporter: {
		fileName: ".artifacts/stryker/protocol.json",
	},
	inPlace: false,
	disableTypeChecks: false,
	tempDirName: ".artifacts/stryker/tmp",
	concurrency: 2,
	timeoutMS: 10000,
	incremental: true,
	incrementalFile: ".artifacts/stryker/protocol-incremental.json",
	thresholds: {
		high: 80,
		low: 60,
		break: 70,
	},
};
