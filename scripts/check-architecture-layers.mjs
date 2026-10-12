#!/usr/bin/env node

/**
 * Enforce Nyan's functional layers and stable-dependency direction.
 *
 * The policy lives in docs/architecture/layers.json so the owner of a layer can review the rule
 * and the executable check together. This script verifies the policy against the source:
 *
 *  1. Package layers: an import may only reach a layer listed in `mayDependOn`; same-layer edges
 *     must be listed in `internal`.
 *  2. Stability: every workspace edge must run toward an equally or more stable package, where
 *     instability I = Ce / (Ca + Ce) is measured from the actual source imports.
 *  3. Declared dependencies: a source import of a workspace package must be declared in the manifest.
 *  4. Public entries: a workspace import must resolve to a subpath in the target's `exports`, and
 *     `entryRules` narrow that further for specific consumers.
 *  5. Package cycles and static runtime file cycles (type-only and dynamic imports are excluded
 *     because they do not create an evaluation-order cycle).
 *  6. Module layers inside packages that declare `modules`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = resolve(ROOT, "packages");
const MAP_PATH = resolve(ROOT, "docs/architecture/layers.json");
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "target"]);
const EPSILON = 1e-9;

const failures = [];
const fail = (message) => failures.push(message);

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageDirs() {
	return readdirSync(PACKAGES_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(resolve(PACKAGES_DIR, entry.name, "package.json")))
		.map((entry) => entry.name)
		.sort();
}

function sourceFiles(dir) {
	if (!existsSync(dir)) return [];
	const result = [];
	const queue = [dir];
	while (queue.length > 0) {
		const current = queue.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			const path = resolve(current, entry.name);
			if (entry.isDirectory()) queue.push(path);
			else if (SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) result.push(path);
		}
	}
	return result.sort();
}

function lineOf(source, index) {
	let line = 1;
	for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
	return line;
}

/** True when every specifier in a named-import clause is `type`-prefixed (TypeScript elides the import). */
function isTypeOnlyClause(clause) {
	const trimmed = clause.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
	const parts = trimmed
		.slice(1, -1)
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	return parts.length > 0 && parts.every((part) => part.startsWith("type "));
}

const STATIC_IMPORT = /^[ \t]*(import|export)\s+(type\s+)?([^;'"]*?)\bfrom\s*["']([^"'\n]+)["']/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*["']([^"'\n]+)["']/gm;
const DYNAMIC_IMPORT = /(?<![\w.$])(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

function extractImports(source) {
	const imports = [];
	for (const match of source.matchAll(STATIC_IMPORT)) {
		const typeOnly = Boolean(match[2]) || isTypeOnlyClause(match[3]);
		imports.push({ specifier: match[4], kind: "static", typeOnly, index: match.index });
	}
	for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
		imports.push({ specifier: match[1], kind: "static", typeOnly: false, index: match.index });
	}
	for (const match of source.matchAll(DYNAMIC_IMPORT)) {
		const lineStart = source.lastIndexOf("\n", match.index) + 1;
		const prefix = source.slice(lineStart, match.index).trimStart();
		if (prefix.startsWith("//") || prefix.startsWith("*")) continue;
		imports.push({ specifier: match[1], kind: "dynamic", typeOnly: false, index: match.index });
	}
	return imports;
}

function exportMatcher(manifest) {
	const keys = manifest.exports && typeof manifest.exports === "object" ? Object.keys(manifest.exports) : [];
	if (keys.length === 0) return (subpath) => subpath === ".";
	return (subpath) => keys.some((key) => key === subpath || (key.endsWith("/*") && subpath.startsWith(key.slice(0, -1))));
}

function strongComponents(nodes, edges) {
	let index = 0;
	const indexOf = new Map();
	const lowOf = new Map();
	const onStack = new Set();
	const stack = [];
	const components = [];
	function visit(node) {
		indexOf.set(node, index);
		lowOf.set(node, index);
		index += 1;
		stack.push(node);
		onStack.add(node);
		for (const next of edges.get(node) ?? []) {
			if (!indexOf.has(next)) {
				visit(next);
				lowOf.set(node, Math.min(lowOf.get(node), lowOf.get(next)));
			} else if (onStack.has(next)) {
				lowOf.set(node, Math.min(lowOf.get(node), indexOf.get(next)));
			}
		}
		if (lowOf.get(node) === indexOf.get(node)) {
			const component = [];
			let member;
			do {
				member = stack.pop();
				onStack.delete(member);
				component.push(member);
			} while (member !== node);
			if (component.length > 1) components.push(component.sort());
		}
	}
	for (const node of nodes) if (!indexOf.has(node)) visit(node);
	return components;
}

const map = readJson(MAP_PATH);
if (map.version !== 2) {
	console.error(`Unsupported architecture map version: ${map.version}`);
	process.exit(1);
}

const dirs = packageDirs();
const manifests = new Map(dirs.map((dir) => [dir, readJson(resolve(PACKAGES_DIR, dir, "package.json"))]));
const dirByName = new Map(dirs.map((dir) => [manifests.get(dir).name, dir]));

// --- validate the policy itself -------------------------------------------------------------
const layerOfPackage = new Map();
const layerById = new Map();
for (const layer of map.layers ?? []) {
	if (typeof layer.id !== "string" || layerById.has(layer.id)) {
		fail(`Invalid or duplicate layer id: ${JSON.stringify(layer.id)}`);
		continue;
	}
	layerById.set(layer.id, layer);
	for (const dir of layer.packages ?? []) {
		if (layerOfPackage.has(dir)) fail(`Package ${dir} appears in more than one layer.`);
		layerOfPackage.set(dir, layer.id);
	}
}
for (const layer of layerById.values()) {
	for (const target of layer.mayDependOn ?? []) {
		if (!layerById.has(target)) fail(`Layer ${layer.id} lists unknown layer ${target} in mayDependOn.`);
		if (target === layer.id) fail(`Layer ${layer.id} must not list itself in mayDependOn; use internal edges.`);
	}
	for (const [from, to] of layer.internal ?? []) {
		if (!(layer.packages ?? []).includes(from) || !(layer.packages ?? []).includes(to)) {
			fail(`Layer ${layer.id} internal edge ${from} -> ${to} names a package outside the layer.`);
		}
	}
}
for (const rule of map.entryRules ?? []) {
	if (!dirs.includes(rule.from)) fail(`entryRules names unknown package directory ${JSON.stringify(rule.from)}.`);
	if (!dirByName.has(rule.package)) fail(`entryRules names unknown workspace package ${JSON.stringify(rule.package)}.`);
	for (const allowed of rule.allow ?? []) {
		if (allowed !== rule.package && !allowed.startsWith(`${rule.package}/`)) {
			fail(`entryRules allow entry ${JSON.stringify(allowed)} is outside ${rule.package}.`);
		}
	}
}
const layerEdges = new Map([...layerById.keys()].map((id) => [id, layerById.get(id).mayDependOn ?? []]));
for (const cycle of strongComponents([...layerById.keys()], layerEdges)) {
	fail(`Layer policy has a cycle: ${cycle.join(", ")}`);
}
const unlayered = dirs.filter((dir) => !layerOfPackage.has(dir));
const stale = [...layerOfPackage.keys()].filter((dir) => !dirs.includes(dir));
if (unlayered.length > 0) fail(`Packages without a layer: ${unlayered.join(", ")}`);
if (stale.length > 0) fail(`Layer map names missing packages: ${stale.join(", ")}`);

// --- collect package-level and file-level imports -------------------------------------------
const packageEdges = new Map(dirs.map((dir) => [dir, new Map()]));
const fileGraphs = new Map();
const fileImports = new Map();

for (const dir of dirs) {
	const srcDir = resolve(PACKAGES_DIR, dir, "src");
	const files = sourceFiles(srcDir);
	const fileSet = new Set(files);
	const imports = [];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const entry of extractImports(source)) {
			imports.push({ ...entry, file, line: lineOf(source, entry.index) });
		}
	}
	fileImports.set(dir, { files, fileSet, imports, srcDir });

	for (const entry of imports) {
		const name = [...dirByName.keys()].find(
			(candidate) => entry.specifier === candidate || entry.specifier.startsWith(`${candidate}/`),
		);
		if (!name) continue;
		const target = dirByName.get(name);
		if (target === dir) continue;
		const record = packageEdges.get(dir).get(target) ?? { count: 0, specs: new Set(), sites: [] };
		record.count += 1;
		record.specs.add(entry.specifier);
		record.sites.push(`${relative(ROOT, entry.file)}:${entry.line}`);
		packageEdges.get(dir).set(target, record);
	}
}

// --- 1. package layers ----------------------------------------------------------------------
for (const [from, targets] of packageEdges) {
	const fromLayer = layerById.get(layerOfPackage.get(from));
	if (!fromLayer) continue;
	for (const [to, record] of targets) {
		const toLayerId = layerOfPackage.get(to);
		if (!toLayerId) continue;
		if (toLayerId === fromLayer.id) {
			const allowed = (fromLayer.internal ?? []).some(([a, b]) => a === from && b === to);
			if (!allowed) fail(`Same-layer dependency ${from} -> ${to} (${fromLayer.id}) is not listed in internal. ${record.sites[0]}`);
		} else if (!(fromLayer.mayDependOn ?? []).includes(toLayerId)) {
			fail(`Layer ${fromLayer.id} may not depend on ${toLayerId}: ${from} -> ${to}. ${record.sites[0]}`);
		}
	}
}

// --- 2. stability ---------------------------------------------------------------------------
const instability = new Map();
for (const dir of dirs) {
	const efferent = packageEdges.get(dir).size;
	let afferent = 0;
	for (const other of dirs) if (packageEdges.get(other).has(dir)) afferent += 1;
	instability.set(dir, { afferent, efferent, value: afferent + efferent === 0 ? 0 : efferent / (afferent + efferent) });
}
for (const [from, targets] of packageEdges) {
	for (const [to, record] of targets) {
		const source = instability.get(from);
		const target = instability.get(to);
		if (target.value > source.value + EPSILON) {
			fail(
				`Dependency points toward instability: ${from} (I=${source.value.toFixed(2)}) -> ${to} (I=${target.value.toFixed(2)}). ${record.sites[0]}`,
			);
		}
	}
}

// --- 3. declared dependencies ---------------------------------------------------------------
for (const [from, targets] of packageEdges) {
	const manifest = manifests.get(from);
	const declared = new Set(
		["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((field) =>
			Object.keys(manifest[field] ?? {}),
		),
	);
	for (const [to, record] of targets) {
		const name = manifests.get(to).name;
		if (!declared.has(name)) fail(`${manifest.name} imports ${name} but does not declare it. ${record.sites[0]}`);
	}
}

// --- 4. public entries ----------------------------------------------------------------------
for (const [from, targets] of packageEdges) {
	for (const [to, record] of targets) {
		const targetManifest = manifests.get(to);
		const exported = exportMatcher(targetManifest);
		for (const specifier of record.specs) {
			const subpath = specifier === targetManifest.name ? "." : `.${specifier.slice(targetManifest.name.length)}`;
			if (!exported(subpath)) fail(`${specifier} is not a public entry of ${targetManifest.name} (imported by ${from}). ${record.sites[0]}`);
		}
	}
}
for (const rule of map.entryRules ?? []) {
	for (const entry of fileImports.get(rule.from)?.imports ?? []) {
		if (entry.specifier !== rule.package && !entry.specifier.startsWith(`${rule.package}/`)) continue;
		const allowed = (rule.allow ?? []).some((prefix) => entry.specifier === prefix || entry.specifier.startsWith(`${prefix}/`));
		if (!allowed) {
			fail(
				`Forbidden import in ${rule.from}: ${entry.specifier} (${relative(ROOT, entry.file)}:${entry.line}). Use one of: ${(rule.allow ?? []).join(", ")}. ${rule.reason ?? ""}`,
			);
		}
	}
}

// --- 5a. package cycles ---------------------------------------------------------------------
const packageGraph = new Map(dirs.map((dir) => [dir, [...packageEdges.get(dir).keys()]]));
for (const cycle of strongComponents(dirs, packageGraph)) fail(`Package dependency cycle: ${cycle.join(", ")}`);

// --- 6 + 5b. module layers and file cycles --------------------------------------------------
function resolveRelative(fromFile, specifier, fileSet) {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [base, base.replace(/\.(c|m)?js$/, ".ts"), `${base}.ts`, resolve(base, "index.ts")];
	return candidates.find((candidate) => fileSet.has(candidate));
}

const knownCycles = (map.cycles?.known ?? []).map((entry) => ({
	package: entry.package,
	files: [...entry.files].sort(),
	matched: false,
}));

for (const dir of dirs) {
	const { files, fileSet, imports, srcDir } = fileImports.get(dir);
	const moduleConfig = map.modules?.[dir];
	const rel = (file) => relative(srcDir, file).split(sep).join("/");

	let classify;
	const moduleById = new Map();
	if (moduleConfig) {
		const entries = [];
		for (const layer of moduleConfig.layers ?? []) {
			moduleById.set(layer.id, layer);
			for (const path of layer.paths ?? []) entries.push({ path, id: layer.id });
		}
		// A path is a directory prefix (trailing /), an exact file, or `prefix*suffix` where * stays within one
		// segment. The most specific (longest) match wins, so a glob can carve a leaf out of a directory.
		const matcherFor = (path) => {
			const star = path.indexOf("*");
			if (star >= 0) {
				const prefix = path.slice(0, star);
				const suffix = path.slice(star + 1);
				return (name) =>
					name.length >= prefix.length + suffix.length &&
					name.startsWith(prefix) &&
					name.endsWith(suffix) &&
					!name.slice(prefix.length, name.length - suffix.length).includes("/");
			}
			return path.endsWith("/") ? (name) => name.startsWith(path) : (name) => name === path;
		};
		const matchers = entries.map((entry) => ({ ...entry, matches: matcherFor(entry.path) }));
		classify = (file) => {
			const name = rel(file);
			let best;
			for (const entry of matchers) {
				if (entry.matches(name) && (!best || entry.path.length > best.path.length)) best = entry;
			}
			return best?.id;
		};
		for (const file of files) {
			if (!classify(file)) fail(`${dir}: ${rel(file)} is not assigned to a module layer in layers.json.`);
		}
		// A path that matches no file is a leftover of a deleted module; it would silently classify a new file.
		for (const entry of matchers) {
			if (!files.some((file) => entry.matches(rel(file)))) {
				fail(`${dir}: module path ${entry.path} (layer ${entry.id}) matches no source file; remove it from layers.json.`);
			}
		}
		for (const layer of moduleById.values()) {
			for (const target of layer.mayDependOn ?? []) {
				if (target !== "*" && !moduleById.has(target)) fail(`${dir}: module layer ${layer.id} lists unknown layer ${target}.`);
			}
		}
	}

	const exceptions = new Set((moduleConfig?.exceptions ?? []).map((entry) => `${entry.from}->${entry.to}`));
	const usedExceptions = new Set();
	const staticGraph = new Map(files.map((file) => [file, new Set()]));

	for (const entry of imports) {
		if (!entry.specifier.startsWith(".")) continue;
		const target = resolveRelative(entry.file, entry.specifier, fileSet);
		if (!target || target === entry.file) continue;
		const edgeKey = `${rel(entry.file)}->${rel(target)}`;
		const excepted = exceptions.has(edgeKey);
		if (excepted) usedExceptions.add(edgeKey);

		if (entry.kind === "static" && !entry.typeOnly && !excepted) staticGraph.get(entry.file).add(target);

		if (!classify || excepted) continue;
		const fromId = classify(entry.file);
		const toId = classify(target);
		if (!fromId || !toId || fromId === toId) continue;
		const fromLayer = moduleById.get(fromId);
		const allowed = (fromLayer.mayDependOn ?? []).includes("*") || (fromLayer.mayDependOn ?? []).includes(toId);
		if (!allowed) {
			fail(
				`${dir}: module layer ${fromId} may not depend on ${toId}: ${rel(entry.file)}:${entry.line} -> ${rel(target)}`,
			);
		}
	}
	for (const key of exceptions) if (!usedExceptions.has(key)) fail(`${dir}: stale architecture exception ${key}.`);

	for (const cycle of strongComponents(files, staticGraph)) {
		const names = cycle.map(rel).sort();
		const known = knownCycles.find(
			(entry) => entry.package === dir && entry.files.length === names.length && entry.files.every((file, i) => file === names[i]),
		);
		if (known) known.matched = true;
		else fail(`${dir}: static runtime import cycle: ${names.join(" <-> ")}`);
	}
}
for (const entry of knownCycles) {
	if (!entry.matched) fail(`${entry.package}: known cycle no longer exists, remove it from layers.json: ${entry.files.join(", ")}`);
}

// --- report ---------------------------------------------------------------------------------
if (failures.length > 0) {
	for (const message of failures) console.error(`- ${message}`);
	console.error(`\n${failures.length} architecture violation(s).`);
	process.exit(1);
}

console.log(`Architecture is valid for ${dirs.length} packages in ${layerById.size} layers.`);
for (const layer of layerById.values()) {
	console.log(`  ${layer.id.padEnd(16)} ${(layer.packages ?? []).join(", ")}`);
}
console.log("  dependency edges (I = instability):");
for (const [from, targets] of packageEdges) {
	if (targets.size === 0) continue;
	const label = (dir) => `${dir}[${instability.get(dir).value.toFixed(2)}]`;
	console.log(`    ${label(from)} -> ${[...targets.keys()].map(label).join(", ")}`);
}
