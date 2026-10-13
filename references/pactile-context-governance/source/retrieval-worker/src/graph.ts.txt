import path from "node:path";

import type { GraphEdge, SymbolHit } from "./types.js";
import { lineNumberAt, normalizeRelativePath } from "./util.js";

export interface ParsedFile {
  readonly path: string;
  readonly language: string;
  readonly symbols: readonly SymbolHit[];
  readonly imports: readonly string[];
  readonly importBindings: readonly ImportBinding[];
  readonly dependencies: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface ImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly specifier: string;
}

const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cs": "csharp", ".dart": "dart", ".ex": "elixir", ".exs": "elixir",
  ".go": "go", ".java": "java", ".js": "javascript", ".jsx": "javascript", ".kt": "kotlin", ".lua": "lua",
  ".mjs": "javascript", ".php": "php", ".py": "python", ".rb": "ruby", ".rs": "rust", ".scala": "scala",
  ".sol": "solidity", ".swift": "swift", ".ts": "typescript", ".tsx": "typescript", ".vue": "vue",
};

const CONTROL_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "with", "function", "def", "fn", "func", "class", "return",
  "throw", "new", "sizeof", "typeof", "require", "import",
]);

/**
 * D25 — decide whether `identifier (` starts a *declaration* rather than a CALL.
 *
 * The rule used to exclude only `.` / `?.` / `::` / CONTROL_CALLS as the previous token, so any
 * call in an expression context was eligible: `values.map((value) => helperOne(value)).reduce(…)
 * was read as a method declaration whose body began at the enclosing `.reduce` arrow, minting a
 * phantom `method:helperOne` in the caller's file that then shadowed the real imported callee.
 *
 * A declaration may follow a member/statement list (`{`, `}`, `;`), the end of a previous member or
 * parameter list (`)`, `]`, `>`), a member modifier, or the start of the file. Everything else is
 * expression context — most importantly `=>`, `=`, `(`, `,`, `:`, `?` and the operators below.
 */
const EXPRESSION_PRECEDERS = new Set([
  ".", "?.", "::", "=>", "=", "(", "[", ",", ":", "?", "+", "-", "*", "/", "%", "**", "&", "|", "^", "!", "~",
  "&&", "||", "??", "+=", "-=", "*=", "/=", "++", "--", "...",
]);

const EXPRESSION_KEYWORDS = new Set([
  "return", "throw", "typeof", "await", "void", "instanceof", "in", "of", "delete", "yield", "new", "case", "else", "do", "extends",
]);

function isDeclarationContext(tokens: readonly Token[], index: number): boolean {
  const previous = tokens[index - 1];
  if (!previous) return true;
  if (previous.kind === "punct") return !EXPRESSION_PRECEDERS.has(previous.value);
  if (previous.kind === "identifier") return !EXPRESSION_KEYWORDS.has(previous.value) && !CONTROL_CALLS.has(previous.value);
  return true;
}

function indentationOf(line: string): number {
  let count = 0;
  for (const character of line) {
    if (character === " ") count += 1;
    else if (character === "\t") count += 4;
    else break;
  }
  return count;
}

/**
 * D29 — a Python body is an indented block, not a brace block. `findBodyEnd()` only understands
 * `{` / `;` / `=>`, so every `def` collapsed to `endLine === startLine`, which also hid every call
 * inside a multi-line body from `buildCallEdgesFromSource()`. The block ends at the first following
 * line that is neither blank nor a comment and is not indented deeper than the `def`.
 * (A multi-line string literal containing a column-0 line ends the block early — the same
 * language-level limitation the rest of this deterministic parser already declares.)
 */
function pythonBlockEnd(text: string, startLine: number): number {
  const lines = text.split(/\r?\n/u);
  const baseIndent = indentationOf(lines[startLine - 1] ?? "");
  let end = startLine;
  for (let line = startLine + 1; line <= lines.length; line += 1) {
    const content = lines[line - 1] ?? "";
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (indentationOf(content) <= baseIndent) break;
    end = line;
  }
  return end;
}

type TokenKind = "identifier" | "string" | "number" | "punct";

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

function idFor(file: string, name: string, kind: string, line: number): string {
  return `${file}::${kind}:${name}:${line}`;
}

function addSymbol(output: SymbolHit[], file: string, name: string, kind: string, line: number, endLine: number): void {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 180) return;
  const id = idFor(file, trimmed, kind, line);
  if (output.some((symbol) => symbol.id === id)) return;
  output.push({ id, name: trimmed, kind, path: file, startLine: line, endLine: Math.max(line, endLine) });
}

function isIdentifierStart(value: string): boolean {
  return /[A-Za-z_$]/u.test(value);
}

function isIdentifierPart(value: string): boolean {
  return /[A-Za-z0-9_$]/u.test(value);
}

function readString(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    const current = text[index];
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

/** Native syntax-aware lexer: comments and string bodies are skipped while line/brace information is retained. */
function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  while (index < text.length) {
    const current = text[index] ?? "";
    if (/\s/u.test(current)) {
      if (current === "\n") line += 1;
      index += 1;
      continue;
    }
    if (current === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length) {
        if (text[index] === "\n") line += 1;
        if (text[index] === "*" && text[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (current === "#") {
      index += 1;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    const start = index;
    const startLine = line;
    if (current === "\"" || current === "'" || current === "`") {
      index = readString(text, index, current);
      const value = text.slice(start, index);
      line += (value.match(/\n/gu) ?? []).length;
      tokens.push({ kind: "string", value, line: startLine, start, end: index });
      continue;
    }
    if (isIdentifierStart(current)) {
      index += 1;
      while (index < text.length && isIdentifierPart(text[index] ?? "")) index += 1;
      tokens.push({ kind: "identifier", value: text.slice(start, index), line: startLine, start, end: index });
      continue;
    }
    if (/[0-9]/u.test(current)) {
      index += 1;
      while (index < text.length && /[A-Za-z0-9_.]/u.test(text[index] ?? "")) index += 1;
      tokens.push({ kind: "number", value: text.slice(start, index), line: startLine, start, end: index });
      continue;
    }
    const three = text.slice(index, index + 3);
    const multi = ["...", "===", "!=="].find((operator) => three.startsWith(operator))
      ?? ["->", "=>", "::", "?.", "&&", "||", "??", "++", "--", "<=", ">=", "==", "!=", "+=", "-=", "**"].find((operator) => text.startsWith(operator, index));
    if (multi) {
      index += multi.length;
      tokens.push({ kind: "punct", value: multi, line: startLine, start, end: index });
      continue;
    }
    index += 1;
    tokens.push({ kind: "punct", value: current, line: startLine, start, end: index });
  }
  return tokens;
}

function matchingBraces(tokens: readonly Token[]): Map<number, number> {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === "{") stack.push(index);
    if (value === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        pairs.set(open, index);
        pairs.set(index, open);
      }
    }
  }
  return pairs;
}

function findBodyEnd(tokens: readonly Token[], pairs: ReadonlyMap<number, number>, from: number, fallbackLine: number): number {
  for (let index = from; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === "{") {
      const close = pairs.get(index);
      return close === undefined ? tokens[index]?.line ?? fallbackLine : tokens[close]?.line ?? fallbackLine;
    }
    if (value === ";") return tokens[index]?.line ?? fallbackLine;
    if (value === "=>") {
      const body = index + 1;
      if (tokens[body]?.value === "{") {
        const close = pairs.get(body);
        return close === undefined ? tokens[body]?.line ?? fallbackLine : tokens[close]?.line ?? fallbackLine;
      }
      return tokens[body]?.line ?? fallbackLine;
    }
  }
  return fallbackLine;
}

function findBodyStart(tokens: readonly Token[], from: number): number | null {
  for (let index = from; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === "{") return index;
    if (value === "=>") return index;
    if (value === ";") return null;
  }
  return null;
}

function nextIdentifier(tokens: readonly Token[], start: number): number | null {
  for (let index = start; index < Math.min(tokens.length, start + 8); index += 1) {
    if (tokens[index]?.kind === "identifier") return index;
    if (["{", "}", ";", "="].includes(tokens[index]?.value ?? "")) break;
  }
  return null;
}

function findClosing(tokens: readonly Token[], start: number, open: string, close: string): number | null {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.value === open) depth += 1;
    if (tokens[index]?.value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function collectSymbols(file: string, text: string): SymbolHit[] {
  const tokens = lex(text);
  const pairs = matchingBraces(tokens);
  const language = EXTENSION_LANGUAGE[path.extname(file).toLowerCase()] ?? "unknown";
  const symbols: SymbolHit[] = [];
  const declarationKeywords = new Map<string, string>([
    ["function", "function"], ["def", "function"], ["fn", "function"], ["func", "function"], ["class", "class"],
    ["interface", "interface"], ["enum", "enum"], ["struct", "struct"], ["trait", "trait"], ["record", "class"],
    ["namespace", "namespace"], ["module", "module"],
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const declaredKind = declarationKeywords.get(token.value);
    if (declaredKind) {
      if (declaredKind === "module" && tokens[index + 1]?.value === ".") continue;
      // D26 — `function (a: number) { ... }` is an anonymous function EXPRESSION: the first
      // identifier after the keyword is a parameter, not a declaration name. The enclosing
      // `const`/assignment owns the name (handled by the branch below), so the keyword declares
      // nothing. A `(` right after any declaration keyword can never be a legal name.
      if (tokens[index + 1]?.value === "(") continue;
      const nameIndex = nextIdentifier(tokens, index + 1);
      const name = nameIndex === null ? null : tokens[nameIndex];
      if (name && nameIndex !== null) {
        const endLine = declaredKind === "function" && language === "python"
          ? pythonBlockEnd(text, name.line)
          : findBodyEnd(tokens, pairs, nameIndex + 1, name.line);
        addSymbol(symbols, file, name.value, declaredKind, name.line, endLine);
      }
      continue;
    }
    if (["const", "let", "var"].includes(token.value)) {
      const name = tokens[index + 1];
      const equals = tokens[index + 2];
      let bodyStart = -1;
      if (name?.kind === "identifier" && equals?.value === "=") {
        for (let cursor = index + 3; cursor < tokens.length; cursor += 1) {
          const value = tokens[cursor]?.value;
          if (value === ";") break;
          if (value === "=>" || value === "function") {
            bodyStart = cursor;
            break;
          }
        }
      }
      if (name?.kind === "identifier" && bodyStart >= 0) {
        addSymbol(symbols, file, name.value, "function", name.line, findBodyEnd(tokens, pairs, bodyStart, name.line));
      }
    }
    if (token.kind === "identifier" && tokens[index + 1]?.value === "(") {
        const previous = tokens[index - 1]?.value ?? "";
        if (previous !== "." && previous !== "?." && previous !== "::" && !CONTROL_CALLS.has(token.value)
          && !["function", "def", "fn", "func"].includes(previous) && isDeclarationContext(tokens, index)) {
          const close = findClosing(tokens, index + 1, "(", ")");
        const bodyStart = close === null ? null : findBodyStart(tokens, close + 1);
        if (close !== null && bodyStart !== null) {
          addSymbol(symbols, file, token.value, "method", token.line, findBodyEnd(tokens, pairs, bodyStart, token.line));
        }
      }
    }
  }
  return symbols;
}

function stringValue(token: Token | undefined): string | null {
  if (!token || token.kind !== "string" || token.value.length < 2) return null;
  return token.value.slice(1, -1);
}

function isResolvableSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("/");
}

/**
 * D28 — Python writes module paths with dots, not slashes. `from .helper import x` used to be
 * forwarded verbatim as `.helper`, and `resolveImport()` joins a bare `.`-prefixed name as a POSIX
 * fragment, so the canonical Python spelling could never reach `py/helper.py` even though the file
 * was indexed. Normalize the Python spelling onto the shared POSIX-style specifier:
 *   `.helper`    -> `./helper`     (one leading dot = current package)
 *   `..helper`   -> `.././helper`  (two leading dots = parent package)
 *   `py.helper`  -> `py/helper`    (absolute dotted module path)
 * The invalid-Python JS-style control `./helper` keeps resolving unchanged.
 */
function normalizePythonSpecifier(raw: string): string {
  const leading = /^\.*/u.exec(raw)?.[0].length ?? 0;
  const dotted = raw.slice(leading).replaceAll(".", "/");
  if (!dotted) return leading > 0 ? "." : "";
  return leading === 0 ? dotted : `${"../".repeat(leading - 1)}./${dotted}`;
}

function namedBindings(tokens: readonly Token[], start: number, end: number, specifier: string): ImportBinding[] {
  const output: ImportBinding[] = [];
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (!token || token.kind !== "identifier" || ["type", "default"].includes(token.value)) continue;
    if (tokens[index - 1]?.value === "as") continue;
    const alias = tokens[index + 1]?.value === "as" && tokens[index + 2]?.kind === "identifier"
      ? tokens[index + 2]?.value
      : tokens[index + 1]?.value === ":" && tokens[index + 2]?.kind === "identifier"
        ? tokens[index + 2]?.value
        : token.value;
    output.push({ local: alias, imported: token.value, specifier });
    if (alias !== token.value) index += 2;
  }
  return output;
}

function requireBindings(tokens: readonly Token[], requireIndex: number, specifier: string): ImportBinding[] {
  let equals = requireIndex - 1;
  while (equals >= 0 && tokens[equals]?.value !== "=" && tokens[equals]?.value !== ";") equals -= 1;
  if (equals < 0 || tokens[equals]?.value !== "=") return [];
  const left = equals - 1;
  if (tokens[left]?.value === "}") {
    let open = left;
    let depth = 0;
    while (open >= 0) {
      if (tokens[open]?.value === "}") depth += 1;
      if (tokens[open]?.value === "{" && --depth === 0) break;
      open -= 1;
    }
    return open >= 0 ? namedBindings(tokens, open + 1, left, specifier) : [];
  }
  return tokens[left]?.kind === "identifier"
    ? [{ local: tokens[left].value, imported: tokens[left].value, specifier }]
    : [];
}

function collectImportData(text: string, language: string): { imports: string[]; importBindings: ImportBinding[] } {
  const tokens = lex(text);
  const imports = new Set<string>();
  const bindings: ImportBinding[] = [];
  const add = (specifier: string, extra: readonly ImportBinding[] = []): void => {
    if (!isResolvableSpecifier(specifier)) return;
    imports.add(specifier);
    bindings.push(...extra);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.value === "import") {
      if (tokens[index + 1]?.value === "(") {
        const specifier = stringValue(tokens[index + 2]);
        if (specifier) add(specifier);
        continue;
      }
      let from = -1;
      let specifier: string | null = null;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor]?.value === ";" || (tokens[cursor]?.line ?? token.line) > token.line && from < 0) break;
        if (tokens[cursor]?.value === "from") {
          from = cursor;
          specifier = stringValue(tokens[cursor + 1]);
          break;
        }
        if (!specifier) specifier = stringValue(tokens[cursor]);
      }
      if (specifier) add(specifier, from > index ? namedBindings(tokens, index + 1, from, specifier) : []);
      continue;
    }
    if (token.value === "require" && tokens[index + 1]?.value === "(") {
      const specifier = stringValue(tokens[index + 2]);
      if (specifier) add(specifier, requireBindings(tokens, index, specifier));
      continue;
    }
    if (language === "python" && token.value === "from") {
      let importIndex = -1;
      for (let cursor = index + 1; cursor < tokens.length && tokens[cursor]?.line === token.line; cursor += 1) {
        if (tokens[cursor]?.value === "import") { importIndex = cursor; break; }
      }
      if (importIndex > index) {
        const specifier = normalizePythonSpecifier(tokens.slice(index + 1, importIndex).map((item) => item.value).join(""));
        if (specifier) {
          add(specifier, namedBindings(tokens, importIndex + 1, tokens.findIndex((item, cursor) => cursor > importIndex && item.line !== token.line) < 0 ? tokens.length : tokens.findIndex((item, cursor) => cursor > importIndex && item.line !== token.line), specifier));
        }
      }
    }
    if (language === "python" && token.value === "import") {
      const end = tokens.findIndex((item, cursor) => cursor > index && item.line !== token.line);
      const stop = end < 0 ? tokens.length : end;
      const specifier = tokens.slice(index + 1, stop).map((item) => item.value).join("").split(",")[0]?.trim() ?? "";
      if (specifier) {
        const local = specifier.split(".").at(-1) ?? specifier;
        add(specifier, [{ local, imported: local, specifier }]);
      }
    }
  }
  return { imports: [...imports].sort(), importBindings: bindings.filter((binding, index, all) => all.findIndex((item) => item.local === binding.local && item.specifier === binding.specifier) === index) };
}

function collectDependencies(text: string): string[] {
  const dependencies = new Set<string>();
  const tokens = lex(text);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!["extends", "implements", "derives"].includes(tokens[index]?.value ?? "")) continue;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token?.kind === "identifier") dependencies.add(token.value);
      if (["{", ";"].includes(token?.value ?? "")) break;
    }
  }
  return [...dependencies].sort();
}

function hasUnbalancedBraces(text: string): boolean {
  let depth = 0;
  for (const token of lex(text)) {
    if (token.value === "{") depth += 1;
    if (token.value === "}") {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

export function parseFile(relativePath: string, text: string): ParsedFile {
  const normalized = normalizeRelativePath(relativePath);
  const language = EXTENSION_LANGUAGE[path.extname(normalized).toLowerCase()] ?? "unknown";
  const symbols = collectSymbols(normalized, text);
  const importData = collectImportData(text, language);
  const diagnostics: string[] = [];
  if (language === "unknown") diagnostics.push("unsupported-language");
  if (text.includes("<<<<<<<") || text.includes("\u0000") || hasUnbalancedBraces(text)) diagnostics.push("parse-failed");
  return { path: normalized, language, symbols, imports: importData.imports, importBindings: importData.importBindings, dependencies: collectDependencies(text), diagnostics };
}

export interface GraphBuildInput {
  readonly files: readonly ParsedFile[];
}

export interface GraphBuildOutput {
  readonly symbols: readonly SymbolHit[];
  readonly imports: readonly { path: string; specifier: string }[];
  readonly edges: readonly GraphEdge[];
  readonly diagnostics: readonly string[];
}

function resolveImport(fromPath: string, specifier: string, knownFiles: ReadonlySet<string>): string | null {
  const clean = specifier.replace(/\.(?:js|jsx|mjs|ts|tsx)$/u, "");
  const base = clean.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), clean)) : clean;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.py`, `${base}.rs`, `${base}/index.ts`, `${base}/index.js`, `${base}/__init__.py`];
  return candidates.map(normalizeRelativePath).find((candidate) => knownFiles.has(candidate)) ?? null;
}

function moduleSymbol(file: ParsedFile): SymbolHit {
  return { id: `${file.path}::module`, name: path.posix.basename(file.path), kind: "module", path: file.path, startLine: 1, endLine: 1 };
}

function resolveDependency(file: ParsedFile, dependency: string, allSymbols: readonly SymbolHit[], knownFiles: ReadonlySet<string>): SymbolHit | undefined {
  const sameFile = allSymbols.find((symbol) => symbol.path === file.path && symbol.name === dependency && symbol.kind !== "module");
  if (sameFile) return sameFile;
  const binding = file.importBindings.find((item) => item.local === dependency);
  if (!binding) return undefined;
  const importedPath = resolveImport(file.path, binding.specifier, knownFiles);
  if (!importedPath) return undefined;
  return allSymbols.find((symbol) => symbol.path === importedPath && symbol.name === binding.imported && symbol.kind !== "module");
}

export function buildGraph(input: GraphBuildInput): GraphBuildOutput {
  const symbols = input.files.flatMap((file) => file.symbols);
  const moduleSymbols = input.files.map(moduleSymbol);
  const allSymbols = [...moduleSymbols, ...symbols];
  const knownFiles = new Set(input.files.map((file) => file.path));
  const imports: { path: string; specifier: string }[] = [];
  const edges: GraphEdge[] = [];
  for (const file of input.files) {
    for (const specifier of file.imports) {
      imports.push({ path: file.path, specifier });
      const target = resolveImport(file.path, specifier, knownFiles);
      if (target) edges.push({ sourceId: `${file.path}::module`, targetId: `${target}::module`, kind: "import" });
    }
    for (const dependency of file.dependencies) {
      const target = resolveDependency(file, dependency, allSymbols, knownFiles);
      if (target) edges.push({ sourceId: `${file.path}::module`, targetId: target.id, kind: "dependency" });
    }
  }
  return { symbols: allSymbols, imports, edges, diagnostics: input.files.flatMap((file) => file.diagnostics) };
}

function chooseCallTarget(name: string, line: number, parsed: ParsedFile, allSymbols: readonly SymbolHit[], knownFiles: ReadonlySet<string>): SymbolHit | undefined {
  const candidates = allSymbols.filter((candidate) => candidate.name === name);
  const sameFile = candidates
    .filter((candidate) => candidate.path === parsed.path && candidate.kind !== "module")
    .sort((left, right) => Math.abs(left.startLine - line) - Math.abs(right.startLine - line))[0];
  if (sameFile) return sameFile;
  const binding = parsed.importBindings.find((item) => item.local === name);
  if (!binding) return undefined;
  const importedPath = resolveImport(parsed.path, binding.specifier, knownFiles);
  if (!importedPath) return undefined;
  // D27 — `candidates` is keyed by the LOCAL call name, which for `import { helper as renamed }`
  // never matches the DECLARED name. Look the imported name up across the imported file instead.
  return allSymbols.find((candidate) => candidate.path === importedPath && candidate.name === binding.imported && candidate.kind !== "module");
}

function parameterNames(tokens: readonly Token[], source: SymbolHit): ReadonlySet<string> {
  const sourceIndex = tokens.findIndex((token) => token.value === source.name && token.line === source.startLine);
  if (sourceIndex < 0) return new Set();
  const open = tokens.findIndex((token, index) => index > sourceIndex && token.value === "(");
  if (open < 0) return new Set();
  const close = findClosing(tokens, open, "(", ")");
  if (close === null) return new Set();
  const output = new Set<string>();
  let segmentStart = open + 1;
  let depth = 0;
  const finish = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      const token = tokens[index];
      if (token?.kind === "identifier") {
        output.add(token.value);
        break;
      }
    }
  };
  for (let index = open + 1; index <= close; index += 1) {
    const value = tokens[index]?.value;
    if (["(", "[", "{"].includes(value ?? "")) depth += 1;
    if ([")", "]", "}"].includes(value ?? "")) depth -= 1;
    if ((value === "," && depth === 0) || index === close) {
      finish(segmentStart, index);
      segmentStart = index + 1;
    }
  }
  return output;
}

export function buildCallEdgesFromSource(parsed: ParsedFile, text: string, allSymbols: readonly SymbolHit[], knownFiles: ReadonlySet<string>): GraphEdge[] {
  const output: GraphEdge[] = [];
  const tokens = lex(text);
  for (const source of parsed.symbols) {
    if (["class", "interface", "module", "namespace", "enum", "struct", "trait"].includes(source.kind)) continue;
    const bodyTokens = tokens.filter((token) => token.line >= source.startLine && token.line <= source.endLine);
    const parameters = parameterNames(tokens, source);
    const seen = new Set<string>();
    for (let index = 0; index < bodyTokens.length - 1; index += 1) {
      const token = bodyTokens[index];
      if (token?.kind !== "identifier" || bodyTokens[index + 1]?.value !== "(" || CONTROL_CALLS.has(token.value)) continue;
      if (parameters.has(token.value)) continue;
      const target = chooseCallTarget(token.value, token.line, parsed, allSymbols, knownFiles);
      if (target && target.id !== source.id && !seen.has(target.id)) {
        seen.add(target.id);
        output.push({ sourceId: source.id, targetId: target.id, kind: "call" });
      }
    }
  }
  return output;
}

export function lineForText(text: string, offset: number): number {
  return lineNumberAt(text, offset);
}
