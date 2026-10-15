#!/usr/bin/env node

/**
 * Keep the N0 extension-surface classification complete, honest, and reviewed.
 *
 * The migration from the current extension API to durable's hook surface is only safe if every
 * member of the old surface has exactly one recorded destination and one recorded decision, and
 * only if the recorded destination is defensible. The classification lives in
 * .agents/notes/proposed/architecture/extension-surface.json so it can be reviewed as data next to
 * the note that explains it. This script derives the surface from the source and verifies the data:
 *
 *  1. Every `on(...)` subscription in `ExtensionAPI` has exactly one JSON entry, with the right
 *     line, and no JSON entry names a subscription the source no longer declares. The count of
 *     `on` declarations must also match the count of `handler:` occurrences, so a declaration the
 *     parser cannot see (a second one on the same line, or one with a comment between the name and
 *     the parenthesis) fails instead of being skipped.
 *  2. Every other `ExtensionAPI` method has exactly one JSON entry, same rule.
 *  3. Every file under the durable prototype directory, at any depth, has a recorded decision.
 *  4. Every enum value, `hook:` destination, and `durable-capability` id is declared, every
 *     destination that names a durable capability records one, and every declared capability is
 *     used.
 *  5. Every evidence string points at a file that exists, at a line that exists, and (for the
 *     `types.ts` declaration of an event or API member) at a line that names it.
 *  6. `--write` regenerates the tables in the note between the GENERATED markers, and refuses a
 *     note whose markers are missing, duplicated, or out of order.
 *
 * The JSON is the reviewed artifact. This script never invents a classification: a new event or
 * method fails the check until a person records where it belongs.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES_PATH = resolve(ROOT, "packages/coding-agent/src/core/extensions/types.ts");
const PROTOTYPE_DIR = resolve(ROOT, "packages/coding-agent/src/experimental/durable");
const NOTES_DIR = resolve(ROOT, ".agents/notes/proposed/architecture");
const DATA_PATH = join(NOTES_DIR, "extension-surface.json");
const NOTE_PATH = join(NOTES_DIR, "2026-10-15-durable-migration-inventory.md");
const WRITE = process.argv.includes("--write");

const failures = [];
const fail = (message) => failures.push(message);

// --- derive the surface from source ---------------------------------------------------------

const source = readFileSync(TYPES_PATH, "utf8");
const lines = source.split("\n");
const interfaceStart = lines.findIndex((line) => line.startsWith("export interface ExtensionAPI"));
if (interfaceStart < 0) {
	fail(`${TYPES_PATH}: could not find "export interface ExtensionAPI"`);
	report();
}

/**
 * The last line of the `ExtensionAPI` body: the first line after the declaration that closes at
 * column zero. Counting braces is not reliable, because the body's doc comments contain braces
 * inside prose and examples.
 */
function interfaceEndLine() {
	for (let i = interfaceStart + 1; i < lines.length; i++) {
		if (lines[i] === "}") return i;
	}
	fail(`${TYPES_PATH}: the ExtensionAPI body has no closing brace at column zero`);
	return lines.length - 1;
}

const interfaceEnd = interfaceEndLine();
const body = lines.slice(interfaceStart, interfaceEnd + 1).join("\n");
const declarator = /on\(\s*(?:event:\s*)?"([a-z_]+)"\s*,\s*handler:/g;

/** Event names and the line each `on(...)` declaration starts on. */
function deriveEvents() {
	const found = new Map();
	for (let i = interfaceStart; i <= interfaceEnd; i++) {
		if (!/^\s*on\(/.test(lines[i])) continue;
		const buffer = [];
		for (let j = i; j <= interfaceEnd; j++) {
			buffer.push(lines[j]);
			if (/\)\s*:\s*\(\)\s*=>\s*void;/.test(lines[j])) break;
		}
		const text = buffer.map((line) => line.trim()).join(" ");
		const matches = [...text.matchAll(declarator)];
		if (matches.length === 0) {
			fail(`${TYPES_PATH}:${i + 1}: could not parse an on(...) declaration`);
			continue;
		}
		if (matches.length > 1) {
			fail(`${TYPES_PATH}:${i + 1}: ${matches.length} subscriptions share one declaration line: ` +
				matches.map((m) => `"${m[1]}"`).join(", "));
		}
		for (const match of matches) {
			if (found.has(match[1])) {
				fail(`${TYPES_PATH}:${i + 1}: duplicate subscription for "${match[1]}"`);
			}
			found.set(match[1], i + 1);
		}
	}
	return found;
}

/** Non-event `ExtensionAPI` method names, with every declared line. */
function deriveApi() {
	const found = new Map();
	const re = /^\t([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/;
	for (let i = interfaceStart; i <= interfaceEnd; i++) {
		const match = re.exec(lines[i]);
		if (!match) continue;
		const name = match[1];
		if (name === "on") continue;
		const entry = found.get(name);
		if (entry === undefined) found.set(name, [i + 1]);
		else entry.push(i + 1);
	}
	return found;
}

function prototypeFiles(dir, prefix = "") {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...prototypeFiles(join(dir, entry.name), rel));
		else if (/\.(ts|tsx|md|json)$/.test(entry.name)) out.push(rel);
	}
	return out;
}

// --- load and validate the classification ---------------------------------------------------

const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));
const enums = data.enums;
const hookNames = new Set(data.durableHooks);
const capabilityIds = new Set(Object.keys(data.capabilities ?? {}));
const usedCapabilities = new Set();

function checkEnum(label, value, allowed) {
	if (!allowed.includes(value)) {
		fail(`${label}: "${value}" is not one of ${allowed.join(", ")}`);
		return false;
	}
	return true;
}

/** An evidence string must name a real file, at a real line, whose text names the subject. */
function checkEvidence(label, entry, subject) {
	const evidence = entry.evidence;
	if (!Array.isArray(evidence) || evidence.length === 0) {
		fail(`${label}: no evidence; every entry needs at least one file[:line]`);
		return;
	}
	for (const item of evidence) {
		if (typeof item !== "string") {
			fail(`${label}: evidence is not a string: ${JSON.stringify(item)}`);
			continue;
		}
		const match = /^(.*?)(?::(\d+))?$/.exec(item);
		const path = resolve(ROOT, match[1]);
		if (!existsSync(path) || !statSync(path).isFile()) {
			fail(`${label}: evidence file does not exist: ${match[1]}`);
			continue;
		}
		if (match[2] === undefined) continue;
		const lineNumber = Number(match[2]);
		const fileLines = readFileSync(path, "utf8").split("\n");
		if (lineNumber < 1 || lineNumber > fileLines.length) {
			fail(`${label}: evidence line ${item} is outside the file (${fileLines.length} lines)`);
			continue;
		}
		// Only the extension surface is checked by name; other evidence may point at prose.
		if (subject !== undefined && path === TYPES_PATH && !fileLines[lineNumber - 1].includes(subject)) {
			fail(`${label}: evidence ${item} does not mention "${subject}"`);
		}
	}
}

function checkDestination(label, destination, entry) {
	if (!checkEnum(label, destination, enums.destination)) return;
	if (destination.startsWith("hook:")) {
		const hook = destination.slice("hook:".length);
		if (!hookNames.has(hook)) fail(`${label}: "${destination}" names a hook durable does not declare`);
	}
	// A `durable-capability` destination must name the capability it needs. A hook destination may
	// also record one, for a hook that exists but has to be extended.
	const capability = entry.capability;
	if (destination === "durable-capability" && (typeof capability !== "string" || capability.length === 0)) {
		fail(`${label}: a durable-capability destination must record its capability id`);
		return;
	}
	if (capability === undefined) return;
	if (typeof capability !== "string" || !capabilityIds.has(capability)) {
		fail(`${label}: capability "${capability}" is not declared in capabilities`);
		return;
	}
	usedCapabilities.add(capability);
}

const eventsByName = new Map();
for (const entry of data.events) {
	const label = `events.${entry.event}`;
	if (eventsByName.has(entry.event)) fail(`${label}: duplicate entry`);
	eventsByName.set(entry.event, entry);
	checkEnum(`${label}.kind`, entry.kind, enums.kind);
	checkEnum(`${label}.timing`, entry.timing, enums.timing);
	checkEnum(`${label}.rerunnable`, entry.rerunnable, enums.rerunnable);
	checkEnum(`${label}.decision`, entry.decision, enums.decision);
	checkDestination(`${label}.destination`, entry.destination, entry);
	checkEvidence(label, entry, entry.event);
}

const apiByName = new Map();
for (const entry of data.api) {
	const label = `api.${entry.api}`;
	if (apiByName.has(entry.api)) fail(`${label}: duplicate entry`);
	apiByName.set(entry.api, entry);
	checkEnum(`${label}.decision`, entry.decision, enums.decision);
	checkDestination(`${label}.destination`, entry.destination, entry);
	checkEvidence(label, entry, entry.api);
}

const protoByName = new Map();
for (const entry of data.prototypeFiles) {
	const label = `prototypeFiles.${entry.file}`;
	if (protoByName.has(entry.file)) fail(`${label}: duplicate entry`);
	protoByName.set(entry.file, entry);
	checkEnum(`${label}.decision`, entry.decision, ["promote", "rework", "discard"]);
	checkEvidence(label, entry);
}

for (const entry of data.extraSurface ?? []) {
	const label = `extraSurface.${entry.area}`;
	checkEnum(`${label}.decision`, entry.decision, enums.decision);
	checkEvidence(label, entry);
}

for (const id of capabilityIds) {
	if (!usedCapabilities.has(id)) fail(`capabilities.${id}: declared but no entry requires it`);
}

// --- compare with the source ----------------------------------------------------------------

const sourceEvents = deriveEvents();
for (const [name, line] of sourceEvents) {
	if (!eventsByName.has(name)) {
		fail(`${TYPES_PATH}:${line}: "${name}" is not classified in extension-surface.json`);
	}
}
for (const [name, entry] of eventsByName) {
	if (!sourceEvents.has(name)) {
		fail(`extension-surface.json: "${name}" is recorded at line ${entry.line} but the source no longer declares it`);
	} else if (entry.line !== sourceEvents.get(name)) {
		fail(`extension-surface.json: "${name}" is recorded at line ${entry.line} but the source declares it at ${sourceEvents.get(name)}`);
	}
}

// A subscription the parser cannot see would leave the handler counts out of step. Only the two
// subscription handler types are counted: a bare `handler:` also appears in the `registerShortcut`
// options object.
const handlerCount =
	(body.match(/handler:\s*ExtensionHandler</g) ?? []).length +
	(body.match(/handler:\s*ProjectTrustHandler/g) ?? []).length;
if (handlerCount !== sourceEvents.size) {
	fail(`${TYPES_PATH}: ${handlerCount} subscription handler(s) but ${sourceEvents.size} subscription(s) parsed; ` +
		"a declaration may be hidden behind a comment or share a line");
}

const sourceApi = deriveApi();
for (const [name, lineList] of sourceApi) {
	if (!apiByName.has(name)) {
		fail(`${TYPES_PATH}:${lineList[0]}: ExtensionAPI.${name} is not classified in extension-surface.json`);
	}
}
for (const [name, entry] of apiByName) {
	if (!sourceApi.has(name)) {
		fail(`extension-surface.json: ExtensionAPI.${name} is recorded at line ${entry.line} but the source no longer declares it`);
	} else if (!sourceApi.get(name).includes(entry.line)) {
		fail(`extension-surface.json: ExtensionAPI.${name} is recorded at line ${entry.line} but the source declares it at ${sourceApi.get(name).join(", ")}`);
	}
}

const sourceProto = prototypeFiles(PROTOTYPE_DIR);
for (const file of sourceProto) {
	if (!protoByName.has(file)) {
		fail(`experimental/durable/${file}: no recorded promote/rework/discard decision`);
	}
}
for (const file of protoByName.keys()) {
	if (!sourceProto.includes(file)) fail(`extension-surface.json: prototype file "${file}" no longer exists`);
}

// --- regenerate the note tables -------------------------------------------------------------

function table(header, rows) {
	const out = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
	for (const row of rows) out.push(`| ${row.join(" | ")} |`);
	return out.join("\n");
}

function consumersOf(entry) {
	const c = entry.consumers ?? {};
	const parts = [];
	for (const [bucket, label] of [["builtin", "built-in"], ["core", "core"], ["example", "example"], ["test", "test"]]) {
		if ((c[bucket] ?? []).length > 0) parts.push(`${label} ${c[bucket].length}`);
	}
	return parts.length === 0 ? "none" : parts.join(", ");
}

function eventsTable() {
	const rows = [...eventsByName.values()]
		.sort((a, b) => a.line - b.line)
		.map((e) => [
			`\`${e.event}\``,
			e.destination === "durable-capability" ? `capability: \`${e.capability}\`` : `\`${e.destination}\``,
			e.decision,
			consumersOf(e),
			e.nyanSemantics,
			e.openQuestion === null ? "" : e.openQuestion,
		]);
	return table(["Event", "Destination", "Decision", "Consumers", "Nyan semantics", "Open question"], rows);
}

function apiTable() {
	const rows = [...apiByName.values()]
		.sort((a, b) => a.line - b.line)
		.map((e) => [`\`${e.api}\``, e.category, `\`${e.destination}\``, e.decision, e.nyanSemantics]);
	return table(["API", "Category", "Destination", "Decision", "Nyan semantics"], rows);
}

function prototypeTable() {
	const rows = [...protoByName.values()]
		.sort((a, b) => a.file.localeCompare(b.file))
		.map((e) => [`\`${e.file}\``, e.decision, `${e.lines}`, e.purpose]);
	return table(["File", "Decision", "Lines", "Purpose"], rows);
}

function extraSurfaceTable() {
	const rows = [...(data.extraSurface ?? [])].map((e) => [`${e.area}`, e.decision, e.summary]);
	return table(["Area", "Decision", "What moves"], rows);
}

function capabilityTable() {
	const rows = Object.entries(data.capabilities ?? {}).map(([id, summary]) => [`\`${id}\``, summary]);
	return table(["Capability", "What durable must add"], rows);
}

const GENERATED = [
	["events", eventsTable()],
	["api", apiTable()],
	["prototype", prototypeTable()],
	["extra-surface", extraSurfaceTable()],
	["capabilities", capabilityTable()],
];

if (WRITE && failures.length === 0) {
	let note = readFileSync(NOTE_PATH, "utf8");
	let changed = 0;
	for (const [id, body] of GENERATED) {
		const begin = `<!-- BEGIN GENERATED: ${id} -->`;
		const end = `<!-- END GENERATED: ${id} -->`;
		const begins = note.split(begin).length - 1;
		const ends = note.split(end).length - 1;
		if (begins !== 1 || ends !== 1) {
			fail(`${NOTE_PATH}: marker "${id}" appears ${begins} time(s) at begin and ${ends} time(s) at end; expected exactly once each`);
			continue;
		}
		const from = note.indexOf(begin);
		const to = note.indexOf(end);
		if (to < from) {
			fail(`${NOTE_PATH}: the end marker for "${id}" precedes its begin marker`);
			continue;
		}
		const next = note.slice(0, from) + `${begin}\n\n${body}\n\n${end}` + note.slice(to + end.length);
		if (next !== note) changed++;
		note = next;
	}
	if (failures.length === 0 && changed > 0) {
		writeFileSync(NOTE_PATH, note);
		console.log(`Regenerated ${changed} table(s) in ${NOTE_PATH}.`);
	} else if (failures.length === 0) {
		console.log("Note tables already match extension-surface.json.");
	}
}

report();

function report() {
	if (failures.length > 0) {
		for (const message of failures) console.error(`- ${message}`);
		console.error(`\n${failures.length} extension-surface violation(s).`);
		process.exit(1);
	}
	const count = (key) => {
		const map = new Map();
		for (const entry of data.events) map.set(entry[key], (map.get(entry[key]) ?? 0) + 1);
		return [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1));
	};
	console.log(`Extension surface is classified: ${data.events.length} events, ${data.api.length} API members, ` +
		`${data.prototypeFiles.length} prototype files, ${(data.extraSurface ?? []).length} extra areas.`);
	for (const [value, n] of count("destination")) console.log(`  ${String(n).padStart(2)}  ${value}`);
	const open = data.events.filter((entry) => entry.openQuestion !== null);
	console.log(`  ${open.length} open question(s) recorded`);
	const unmapped = data.events.filter((entry) => {
		const c = entry.consumers ?? {};
		return ["builtin", "core", "example", "test"].every((b) => (c[b] ?? []).length === 0);
	});
	if (unmapped.length > 0) {
		console.log(`  ${unmapped.length} event(s) with no extension consumer: ${unmapped.map((e) => e.event).join(", ")}`);
		console.log("    (they may still have internal consumers such as the TUI and --mode json)");
	}
}
