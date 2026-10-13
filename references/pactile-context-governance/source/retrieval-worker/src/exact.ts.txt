import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Freshness, SearchHit, SearchRequest, SearchResult, SearchStatus, WorkspaceScope } from "./types.js";
import {
  abortIfNeeded,
  boundedInt,
  isAbortError,
  isIgnored,
  normalizeRelativePath,
  resolveSafeRealpath,
} from "./util.js";

interface ExactOptions {
  readonly root: string;
  readonly scope: () => WorkspaceScope;
  readonly freshness?: () => Freshness;
  readonly defaultTimeoutMs: number;
  readonly maxFileBytes?: number;
}

function statusForScope(options: ExactOptions, scope: WorkspaceScope): Freshness {
  return options.freshness?.() ?? scope.freshness;
}

function statusForHits(freshness: Freshness, hits: readonly SearchHit[], maxResults: number): SearchStatus {
  if (freshness === "stale") return "stale";
  return hits.length >= maxResults ? "limit_hit" : "complete";
}

interface SearchPathEntry {
  readonly relative: string;
  readonly directory: boolean;
}

async function canonicalSearchPathEntries(root: string, paths: readonly string[] | undefined): Promise<SearchPathEntry[] | undefined> {
  if (!paths?.length) return undefined;
  const entries: SearchPathEntry[] = [];
  for (const raw of paths) {
    const lexical = normalizeRelativePath(raw);
    if (!lexical) return [];
    const resolved = await resolveSafeRealpath(root, lexical);
    let directory = false;
    try { directory = (await fs.stat(resolved.absolute)).isDirectory(); } catch { /* rg/fallback will report no files */ }
    if (!entries.some((entry) => entry.relative === resolved.relative)) entries.push({ relative: resolved.relative, directory });
  }
  return entries
    .filter((entry, _index, all) => !all.some((parent) => parent.directory && parent.relative !== entry.relative && entry.relative.startsWith(`${parent.relative}/`)));
}

async function canonicalSearchPaths(root: string, paths: readonly string[] | undefined): Promise<string[] | undefined> {
  return (await canonicalSearchPathEntries(root, paths))?.map((entry) => entry.relative);
}

interface IgnoreRule {
  readonly base: string;
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".rgignore"] as const;

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index] ?? "";
    if (current === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") { index += 1; source += "(?:.*/)?"; } else source += ".*";
    } else if (current === "*") source += "[^/]*";
    else if (current === "?") source += "[^/]";
    else source += current.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function parseIgnoreRules(base: string, content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const negated = trimmed.startsWith("!");
    const withoutNegation = negated ? trimmed.slice(1) : trimmed;
    const directoryOnly = withoutNegation.endsWith("/");
    const pattern = withoutNegation.replace(/^\/+|\/+$/gu, "");
    if (!pattern) continue;
    rules.push({ base, pattern, negated, directoryOnly, regex: globRegex(pattern) });
  }
  return rules;
}

function ignoreRuleMatches(rule: IgnoreRule, relative: string, directory: boolean): boolean {
  const fromBase = normalizeRelativePath(path.posix.relative(rule.base || ".", relative));
  if (!fromBase) return false;
  const parts = fromBase.split("/");
  if (rule.directoryOnly) {
    const directories = directory ? [fromBase] : parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
    return directories.some((candidate) => rule.regex.test(candidate) || (!rule.pattern.includes("/") && candidate.split("/").some((part) => rule.regex.test(part))));
  }
  if (!rule.pattern.includes("/")) return parts.some((part) => rule.regex.test(part));
  return rule.regex.test(fromBase) || parts.some((_part, index) => rule.regex.test(parts.slice(index).join("/")));
}

function ignoredByRules(relative: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = isIgnored(relative);
  for (const rule of rules) {
    if (ignoreRuleMatches(rule, relative, directory)) ignored = !rule.negated;
  }
  return ignored;
}

function explicitHiddenScopes(paths: readonly string[] | undefined): readonly string[] {
  return (paths ?? []).map((item) => normalizeRelativePath(item)).filter((item) => item && item.split("/").some((part) => part.startsWith(".")));
}

/** The operand itself plus every ancestor the walk had to pass through to reach it. */
function operandChain(operand: SearchPathEntry): readonly SearchPathEntry[] {
  const parts = operand.relative.split("/");
  const chain: SearchPathEntry[] = [];
  for (let index = 1; index < parts.length; index += 1) chain.push({ relative: parts.slice(0, index).join("/"), directory: true });
  chain.push({ relative: operand.relative, directory: operand.directory });
  return chain;
}

/**
 * A rule that already matched the operand (or one of its ancestors) must not prune the subtree any
 * more: ripgrep exempts a command-line operand from the ignore files above it, so `ignored-dir/` in
 * .gitignore no longer hides anything once `ignored-dir` (or a path below it) is named explicitly.
 * Rules whose first match is STRICTLY below the operand still apply (nested ignore files, sibling
 * rules such as `*.log`, ...), which is what real ripgrep 15.1.0 does on the same fixture.
 */
function ruleShadowedByOperand(rule: IgnoreRule, chain: readonly SearchPathEntry[]): boolean {
  return chain.some((entry) => ignoreRuleMatches(rule, entry.relative, entry.directory));
}

async function walkFallbackFiles(
  root: string,
  signal?: AbortSignal,
  hiddenScopes: readonly string[] = [],
  operands: readonly SearchPathEntry[] = [],
): Promise<readonly string[]> {
  const output: string[] = [];
  const operandChains = new Map(operands.map((operand) => [operand.relative, operandChain(operand)]));
  const visit = async (directory: string, inherited: readonly IgnoreRule[]): Promise<void> => {
    abortIfNeeded(signal);
    const relativeDirectory = normalizeRelativePath(path.relative(root, directory));
    let rules = [...inherited];
    for (const name of IGNORE_FILE_NAMES) {
      try {
        const content = await fs.readFile(path.join(directory, name), "utf8");
        rules = [...rules, ...parseIgnoreRules(relativeDirectory, content)];
      } catch { /* missing or unreadable ignore file */ }
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      abortIfNeeded(signal);
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      const isDirectory = entry.isDirectory();
      const operand = operandChains.get(relative);
      const ancestorOfOperand = operands.some((candidate) => candidate.relative !== relative && candidate.relative.startsWith(`${relative}/`));
      // The explicit operand and the ancestors walked through to reach it are exempt from ignore
      // and hidden pruning; DEFAULT_IGNORES (`isIgnored`), the index directory and the budget/abort
      // limits remain hard limits for BOTH engines.
      const exemptFromRules = operand !== undefined || ancestorOfOperand;
      if (IGNORE_FILE_NAMES.includes(entry.name as (typeof IGNORE_FILE_NAMES)[number])) continue;
        // Match ripgrep's default traversal: hidden files and directories are
        // excluded. Walk through a hidden ancestor only when it leads to a
        // deeper explicitly selected path; selecting a hidden directory does
        // not implicitly enable hidden descendants beneath that directory.
      const explicitlySelectedHidden = hiddenScopes.some((scope) => relative === scope || scope.startsWith(`${relative}/`));
      if (entry.name.startsWith(".") && !explicitlySelectedHidden && !exemptFromRules) continue;
      if (exemptFromRules) {
        if (isIgnored(relative)) continue;
      } else {
        const enclosing = operands.length > 0
          ? [...operandChains.entries()].find(([operandPath]) => relative.startsWith(`${operandPath}/`))
          : undefined;
        const activeRules = enclosing ? rules.filter((rule) => !ruleShadowedByOperand(rule, enclosing[1])) : rules;
        if (ignoredByRules(relative, isDirectory, activeRules)) continue;
      }
      if (isDirectory) await visit(absolute, rules);
      else if (entry.isFile()) output.push(relative);
    }
  };
  await visit(root, []);
  return output;
}

function parseRgOutput(
  output: string,
  query: string,
  caseSensitive: boolean,
  regex: boolean,
  maxResults: number,
  maxBytes: number,
  root: string,
): SearchHit[] {
  const hits: SearchHit[] = [];
  let expression: RegExp | null = null;
  if (regex) {
    try { expression = new RegExp(query, caseSensitive ? "u" : "iu"); } catch { /* fallback owns invalid-regex reporting */ }
  }
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const first = line.indexOf(":");
    const second = first < 0 ? -1 : line.indexOf(":", first + 1);
    if (first <= 0 || second <= first) continue;
    const relative = normalizeRelativePath(line.slice(0, first));
    if (isIgnored(relative)) continue;
    const lineNo = Number(line.slice(first + 1, second));
    const text = line.slice(second + 1);
    const haystack = caseSensitive ? text : text.toLocaleLowerCase();
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const match = expression?.exec(text);
    if (expression) expression.lastIndex = 0;
    const column = match ? match.index + 1 : Math.max(1, haystack.indexOf(needle) + 1);
    const hit: SearchHit = { path: normalizeRelativePath(path.relative(root, path.resolve(root, relative))), line: lineNo, column, text, source: "exact" };
    if (hits.length >= maxResults || Buffer.byteLength(JSON.stringify([...hits, hit]), "utf8") > maxBytes) break;
    hits.push(hit);
  }
  return hits;
}

/**
 * Terminate the rg child AND any process it launched.
 *
 * `child.kill()` only signals the DIRECT child. On hosts where the `rg` on PATH is a launcher — the
 * scoop shim at `shims/rg.exe` is a 136 KB wrapper around the 4.2 MB real binary, and `.cmd`/`.bat`
 * shims behave the same way — the wrapper dies immediately while the real ripgrep keeps scanning as
 * an orphaned grandchild. `taskkill /T` walks the tree; on non-Windows the plain signal is correct.
 *
 * ORDERING MATTERS: the plain `child.kill()` must NOT fire alongside `taskkill /T`. Killing the
 * direct child first destroys the parent/child link that `/T` needs in order to enumerate the tree,
 * which leaves the grandchild alive. The tree killer therefore owns the child outright, and the
 * fallback signal is used only when spawning it throws.
 */
function killChildTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (process.platform === "win32" && typeof pid === "number") {
    try {
      const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => { try { child.kill(); } catch { /* already exited */ } });
      killer.unref();
      return;
    } catch { /* fall through to the plain signal below */ }
  }
  try { child.kill(); } catch { /* already exited */ }
}

async function searchWithRg(
  options: ExactOptions,
  request: Required<Pick<SearchRequest, "query" | "regex" | "caseSensitive">> & SearchRequest,
): Promise<SearchResult | null> {
  const scope = options.scope();
  const maxResults = boundedInt(request.maxResults, 50, 1, 500);
  const maxBytes = boundedInt(request.maxBytes, 128 * 1024, 256, 2 * 1024 * 1024);
  const timeoutMs = boundedInt(request.timeoutMs, options.defaultTimeoutMs, 20, 300_000);
  const searchPaths = await canonicalSearchPaths(options.root, request.paths);
  const args = [
    "--no-heading",
    "--line-number",
    "--color",
    "never",
    "--max-count",
    String(maxResults),
    "--sort",
    "path",
    "--with-filename",
    ...(options.maxFileBytes !== undefined ? ["--max-filesize", String(options.maxFileBytes)] : []),
    ...(request.caseSensitive ? [] : ["--ignore-case"]),
    ...(request.regex ? [] : ["--fixed-strings"]),
    "--glob", "!.git/**",
    "--glob", "!.pactile/retrieval/**",
    "--glob", "!node_modules/**",
    "--glob", "!dist/**",
    "--glob", "!build/**",
    "--glob", "!coverage/**",
    "--glob", "!.venv/**",
    "--glob", "!__pycache__/**",
    "--glob", "!*.min.js",
    "--glob", "!*.map",
    "--",
    request.query,
    ...(searchPaths?.length ? searchPaths : ["."]),
  ];
  return await new Promise<SearchResult | null>((resolve) => {
    let stdout = "";
    let settled = false;
    let killedResult: SearchResult | null = null;
    let killGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const started = performance.now();
    const child = spawn("rg", args, { cwd: options.root, windowsHide: true });
    const finish = (result: SearchResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolve(result);
    };
    const finishAfterKill = (result: SearchResult): void => {
      killedResult = result;
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(result);
        return;
      }
      killChildTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      killGraceTimer = setTimeout(() => finish(result), 1_000);
    };
    const timer = setTimeout(() => {
      finishAfterKill({
        status: "timeout",
        hits: parseRgOutput(stdout, request.query, request.caseSensitive, request.regex, maxResults, maxBytes, options.root),
        scannedFiles: 0,
        bytes: Buffer.byteLength(stdout, "utf8"),
        elapsedMs: performance.now() - started,
        generation: scope.generation,
        freshness: statusForScope(options, scope),
        reason: "rg deadline exceeded",
      });
    }, timeoutMs);
    request.signal?.addEventListener("abort", () => {
      finishAfterKill({
        status: "timeout",
        hits: parseRgOutput(stdout, request.query, request.caseSensitive, request.regex, maxResults, maxBytes, options.root),
        scannedFiles: 0,
        bytes: Buffer.byteLength(stdout, "utf8"),
        elapsedMs: performance.now() - started,
        generation: scope.generation,
        freshness: statusForScope(options, scope),
        reason: "cancelled",
      });
    }, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(stdout, "utf8") < maxBytes) stdout += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (killedResult) return;
      if (error.code === "ENOENT") finish(null);
      else finish({ status: "unavailable", hits: [], scannedFiles: 0, bytes: 0, elapsedMs: performance.now() - started, generation: scope.generation, freshness: statusForScope(options, scope), reason: error.message });
    });
    child.on("close", (code) => {
      if (killedResult) {
        const result = killedResult;
        killedResult = null;
        finish(result);
        return;
      }
      if (code === 2) {
        // ripgrep can print valid matches before reporting a filesystem error
        // (for example a dangling symlink). Preserve those matches and let
        // exactSearch merge them with the local fallback. The fallback still
        // owns invalid-regex classification.
        const hits = parseRgOutput(stdout, request.query, request.caseSensitive, request.regex, maxResults, maxBytes, options.root);
        finish({
          status: "degraded",
          hits,
          scannedFiles: 0,
          bytes: Buffer.byteLength(stdout, "utf8"),
          elapsedMs: performance.now() - started,
          generation: scope.generation,
          freshness: statusForScope(options, scope),
          reason: "rg exited 2; fallback required",
        });
        return;
      }
      const hits = parseRgOutput(stdout, request.query, request.caseSensitive, request.regex, maxResults, maxBytes, options.root);
      if (code !== 0 && code !== 1) {
        finish({ status: "degraded", hits, scannedFiles: 0, bytes: Buffer.byteLength(stdout, "utf8"), elapsedMs: performance.now() - started, generation: scope.generation, freshness: statusForScope(options, scope), reason: `rg exited ${code ?? "unknown"}; fallback required` });
        return;
      }
      if (code === 1 && hits.length > 0) {
        finish({ status: "degraded", hits, scannedFiles: 0, bytes: Buffer.byteLength(stdout, "utf8"), elapsedMs: performance.now() - started, generation: scope.generation, freshness: statusForScope(options, scope), reason: "rg exited 1 with output; fallback required" });
        return;
      }
      if (code === 0 && hits.length === 0 && stdout.trim().length === 0) {
        finish({ status: "degraded", hits, scannedFiles: 0, bytes: 0, elapsedMs: performance.now() - started, generation: scope.generation, freshness: statusForScope(options, scope), reason: "rg exited 0 with empty output; fallback required" });
        return;
      }
      finish({
        status: statusForHits(statusForScope(options, scope), hits, maxResults),
        hits,
        scannedFiles: 0,
        bytes: Buffer.byteLength(stdout, "utf8"),
        elapsedMs: performance.now() - started,
        generation: scope.generation,
        freshness: statusForScope(options, scope),
      });
    });
  });
}

async function fallbackSearch(options: ExactOptions, request: SearchRequest): Promise<SearchResult> {
  const started = performance.now();
  const scope = options.scope();
  const maxResults = boundedInt(request.maxResults, 50, 1, 500);
  const maxBytes = boundedInt(request.maxBytes, 128 * 1024, 256, 2 * 1024 * 1024);
  const timeoutMs = boundedInt(request.timeoutMs, options.defaultTimeoutMs, 20, 300_000);
  const deadline = started + timeoutMs;
  const hits: SearchHit[] = [];
  let bytes = 0;
  let scannedFiles = 0;
  let pattern: RegExp | null = null;
  if (request.regex) {
    try {
      pattern = new RegExp(request.query, request.caseSensitive ? "gu" : "giu");
    } catch {
      return { status: "parse_failed", hits: [], scannedFiles: 0, bytes: 0, elapsedMs: performance.now() - started, generation: scope.generation, freshness: statusForScope(options, scope), reason: "invalid regular expression" };
    }
  }
  const needle = request.caseSensitive ? request.query : request.query.toLocaleLowerCase();
  const searchPathEntries = await canonicalSearchPathEntries(options.root, request.paths);
  const files = await walkFallbackFiles(options.root, request.signal, explicitHiddenScopes(request.paths), searchPathEntries ?? []);
  const candidates = searchPathEntries?.length
    ? files.filter((file) => searchPathEntries.some((scopePath) => file === scopePath.relative || file.startsWith(`${scopePath.relative}/`)))
    : files;
  for (const relative of candidates) {
    abortIfNeeded(request.signal);
    if (performance.now() > deadline) return { status: "timeout", hits, scannedFiles, bytes, elapsedMs: performance.now() - started, generation: scope.generation, freshness: statusForScope(options, scope), reason: "fallback deadline exceeded" };
    let text: string;
    try {
      const resolved = await resolveSafeRealpath(options.root, relative);
      const filePath = resolved.absolute;
      const stat = await fs.stat(filePath);
      if (options.maxFileBytes !== undefined && stat.size > options.maxFileBytes) continue;
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    scannedFiles += 1;
    bytes += Buffer.byteLength(text, "utf8");
    const lines = text.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (hits.length >= maxResults || Buffer.byteLength(JSON.stringify(hits), "utf8") >= maxBytes) return;
      if (pattern) pattern.lastIndex = 0;
      const match = pattern ? pattern.exec(line) : (request.caseSensitive ? line.indexOf(needle) : line.toLocaleLowerCase().indexOf(needle));
      if (match === null || match === -1) return;
      const column = typeof match === "number" ? match + 1 : (match.index ?? 0) + 1;
      const hit: SearchHit = { path: relative, line: index + 1, column, text: line, source: "fallback" };
      if (Buffer.byteLength(JSON.stringify([...hits, hit]), "utf8") <= maxBytes) hits.push(hit);
    });
    if (hits.length >= maxResults || Buffer.byteLength(JSON.stringify(hits), "utf8") >= maxBytes) break;
  }
  const freshness = statusForScope(options, scope);
  return { status: statusForHits(freshness, hits, maxResults), hits, scannedFiles, bytes, elapsedMs: performance.now() - started, generation: scope.generation, freshness };
}

export async function exactSearch(options: ExactOptions, request: SearchRequest): Promise<SearchResult> {
  abortIfNeeded(request.signal);
  if (!request.query.trim()) return { status: "complete", hits: [], scannedFiles: 0, bytes: 0, elapsedMs: 0, generation: options.scope().generation, freshness: statusForScope(options, options.scope()), reason: "empty query" };
  try {
    const result = await searchWithRg(options, { ...request, regex: request.regex ?? false, caseSensitive: request.caseSensitive ?? false });
    if (result) {
      if (result.status !== "degraded" || !result.reason?.includes("fallback required")) return result;
      const fallback = await fallbackSearch(options, request);
      if (fallback.status === "parse_failed") return fallback;
      const merged = new Map<string, SearchHit>();
      for (const hit of [...result.hits, ...fallback.hits]) merged.set(`${hit.path}:${hit.line}:${hit.text}`, hit);
      const maxResults = boundedInt(request.maxResults, 50, 1, 500);
      const maxBytes = boundedInt(request.maxBytes, 128 * 1024, 256, 2 * 1024 * 1024);
      const hits: SearchHit[] = [];
      for (const hit of [...merged.values()].sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column || left.source.localeCompare(right.source))) {
        if (hits.length >= maxResults || Buffer.byteLength(JSON.stringify([...hits, hit]), "utf8") > maxBytes) break;
        hits.push(hit);
      }
      return { ...fallback, hits, reason: `${result.reason}; merged rg output with fallback` };
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  return await fallbackSearch(options, request);
}
