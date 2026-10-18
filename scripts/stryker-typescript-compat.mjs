import ts from "typescript";

// Stryker 10 still calls the TypeScript 6-era parser API, removed in TypeScript 7.
// Keep the compatibility shim local to the mutation command instead of pinning the
// repository's compiler to an older major version.
if (typeof ts.parseConfigFileTextToJson !== "function") {
	ts.parseConfigFileTextToJson = (_fileName, sourceText) => {
		try {
			return { config: JSON.parse(sourceText.replace(/^\uFEFF/, "")) };
		} catch (error) {
			return {
				config: undefined,
				error: {
					category: 1,
					code: 0,
					messageText: error instanceof Error ? error.message : String(error),
				},
			};
		}
	};
}
