// Reports which provider SDK packages a process loads, for test/lazy-module-load.test.ts.
//
// Node reports every resolution through module.registerHooks(). Bun has no such hook, but a runtime plugin sees each
// file Bun loads, and a package counts as loaded when one of its files is. The plugin's filter names the packages
// instead of matching every file under node_modules: Bun rejects an onLoad that returns nothing for some files there.
export async function observeSdkLoads(names) {
	const loaded = [];
	if (process.versions.bun) {
		const separator = "[\\\\/]";
		const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split("/").join(separator));
		const filter = new RegExp(`node_modules${separator}(${alternatives.join("|")})${separator}`);
		Bun.plugin({
			name: "sdk-load-spy",
			setup(build) {
				build.onLoad({ filter }, (args) => {
					const path = args.path.replaceAll("\\", "/");
					const found = names.find((name) => path.includes(`/node_modules/${name}/`));
					if (found) loaded.push(found);
					return undefined;
				});
			},
		});
	} else {
		const { registerHooks } = await import("node:module");
		const wanted = new Set(names);
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (wanted.has(specifier)) loaded.push(specifier);
				return nextResolve(specifier, context);
			},
		});
	}
	return loaded;
}
