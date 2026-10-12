// Apply the Pi-to-Nyan rename rules to a directory tree, so an upstream Pi tree can be merged with this fork
// without the rename showing up as conflicts. See .agents/notes/implemented/process/2026-10-12-rename-aware-upstream-sync.md.
//
//   git archive <pi-commit> | tar -x -C /tmp/pi-new
//   node .agents/skills/nyan-upstream-sync/normalize-upstream.mjs /tmp/pi-new --apply
//
// Without --apply it only prints what it would change. Run it on the old baseline and on the new target with the
// same rules, commit both as scratch refs, and merge with `git merge-tree --write-tree --merge-base=<old> HEAD <new>`.
// Rules that changed since the first sync (the fork's later renames) belong in this file, next to the manifest.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";

const ROOT = process.argv[2].replaceAll("\\", "/");
const APPLY = process.argv.includes("--apply");
const REPO = "https://github.com/blxzer77/nyan";

function walk(dir, rel = "") {
	const out = [];
	for (const e of readdirSync(`${dir}/${rel}`, { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...walk(dir, r));
		else if (e.isFile()) out.push(r);
	}
	return out;
}
const all = walk(ROOT);

const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".wasm", ".woff", ".woff2", ".ttf", ".zip", ".gz", ".node", ".jsonl", ".pdf", ".svg", ".o", ".a"]);
const SKIP_PATH = [
	/^\.agents\//,
	/^docs\/architecture\//,
	/^docs\/README\.md$/,
	/^AGENTS\.md$/,
	/^README\.md$/,
	/^CONTRIBUTING\.md$/,
	/^SECURITY\.md$/,
	/(^|\/)CHANGELOG\.md$/,
	/(^|\/)LICENSE[^/]*$/,
];
const eligible = (f) => !SKIP_EXT.has(extname(f).toLowerCase()) && !SKIP_PATH.some((re) => re.test(f));

// path-component rule shared by file renames and text: a delimited `pi` component becomes `nyan`
const WORD_RULES = [
	[/(?<![A-Za-z0-9])PI(?![A-Za-z0-9])/g, "NYAN"],
	[/(?<![A-Za-z0-9])Pi(?![A-Za-z0-9])/g, "Nyan"],
	[/(?<![A-Za-z0-9])pi(?![A-Za-z0-9])/g, "nyan"],
	[/(?<![A-Z])Pi(?=[A-Z])/g, "Nyan"],
	[/(?<![A-Za-z0-9])pi(?=[A-Z])/g, "nyan"],
];

function transform(text, file) {
	const counts = {};
	const bump = (k, n) => {
		if (n) counts[k] = (counts[k] ?? 0) + n;
	};
	const sub = (re, to, key) => {
		let n = 0;
		text = text.replace(re, (...m) => {
			n += 1;
			return typeof to === "function" ? to(...m) : to.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
		});
		bump(key, n);
	};
	const lockfile = /(^|\/)package-lock\.json$/.test(file);
	const lines = lockfile ? text.split("\n") : null;
	const apply = (t) => {
		text = t;
		// 0. repository URLs that point at this repository's files
		sub(/git\+https:\/\/github\.com\/earendil-works\/pi\.git/g, `git+${REPO}.git`, "repo-url");
		sub(/https:\/\/github\.com\/earendil-works\/pi(\.git)?(?![\w./-])/g, `${REPO}$1`, "repo-url");
		sub(/(https:\/\/github\.com\/)earendil-works\/pi(\/(?:blob|tree|raw|actions|releases\/latest|releases\/download)[^\s"'`)\]>]*)/g, "$1blxzer77/nyan$2", "repo-url");
		sub(/raw\.githubusercontent\.com\/earendil-works\/pi\//g, "raw.githubusercontent.com/blxzer77/nyan/", "repo-url");
		// 1. package names
		sub(/@earendil-works\/pi-agent-core/g, "@nyan/agent-core", "package");
		sub(/@earendil-works\/pi-([a-z][a-z0-9-]*)/g, "@nyan/$1", "package");
		sub(/@earendil-works\/chord/g, "@nyan/chord", "package");
		// 2. upstream provenance and Pi-operated hosts stay as they are
		const protectedSpans = [];
		const protect = (re, key) => {
			let n = 0;
			text = text.replace(re, (m) => {
				protectedSpans.push(m);
				n += 1;
				return `\u0000${protectedSpans.length - 1}\u0000`;
			});
			bump(`protected:${key}`, n);
		};
		protect(/Math\.PI\b/g, "Math.PI");
		protect(/[^\s"'`()<>[\]]*(?:earendil-works|badlogic|mariozechner)\/pi[^\s"'`()<>[\]]*/g, "upstream-url");
		protect(/[A-Za-z0-9.-]*\bpi\.dev[^\s"'`()<>[\]]*/g, "pi.dev");
		// 3. product identity words
		for (const [re, to] of WORD_RULES) sub(re, to, "word");
		text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => protectedSpans[Number(i)]);
		return text.replaceAll("@nyan", "@ny4n");
	};
	if (lines) {
		const out = lines.map((line) => (line.includes('"integrity"') ? line : apply(line)));
		return { text: out.join("\n"), counts };
	}
	return { text: apply(text), counts };
}

const totals = {};
const changed = [];
for (const file of all.filter(eligible)) {
	let size;
	try {
		size = statSync(`${ROOT}/${file}`).size;
	} catch {
		continue;
	}
	if (size > 6_000_000) continue;
	const original = readFileSync(`${ROOT}/${file}`);
	if (original.includes(0)) continue;
	const text = original.toString("utf8");
	const { text: next, counts } = transform(text, file);
	for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + v;
	if (next !== text) changed.push({ file, next });
}

// path renames (directory and file components)
const renames = [];
const renameComponent = (component) => {
	let c = component;
	for (const [re, to] of WORD_RULES) c = c.replace(re, to);
	return c;
};
for (const file of all) {
	if (/^\.agents\/upstream\//.test(file)) continue;
	const parts = file.split("/");
	const next = parts.map(renameComponent).join("/");
	if (next !== file) renames.push([file, next]);
}

console.log(`eligible files: ${all.filter(eligible).length}; files with text changes: ${changed.length}`);
console.log("rule counts:", JSON.stringify(totals));
console.log(`path renames: ${renames.length}`);
for (const [a, b] of renames) console.log(`  ${a}\n    -> ${b}`);

if (!APPLY) process.exit(0);
for (const { file, next } of changed) writeFileSync(`${ROOT}/${file}`, next);
for (const [from, to] of renames) {
	mkdirSync(dirname(`${ROOT}/${to}`), { recursive: true });
	if (existsSync(`${ROOT}/${to}`)) throw new Error(`rename target exists: ${to}`);
	renameSync(`${ROOT}/${from}`, `${ROOT}/${to}`);
}
console.log("applied");
