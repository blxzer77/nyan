import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORES = [
  ".git",
  ".pactile/retrieval",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "__pycache__",
  "*.min.js",
  "*.map",
] as const;

export const SUPPORTED_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".dart",
  ".ex",
  ".exs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".lua",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sol",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]) as ReadonlySet<string>;

export function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized === "." ? "" : normalized;
}

export function isIgnored(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/");
  return DEFAULT_IGNORES.some((pattern) => {
    if (pattern.includes("*")) {
      const suffix = pattern.replace("*", "");
      return normalized.endsWith(suffix);
    }
    return normalized === pattern
      || normalized.startsWith(`${pattern}/`)
      || parts.includes(pattern);
  });
}

export function isSupportedFile(relativePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

export async function walkFiles(
  root: string,
  signal?: AbortSignal,
  supportedOnly = true,
): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (isIgnored(relative)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && (!supportedOnly || isSupportedFile(relative))) {
        output.push(relative);
      }
    }
  };
  await visit(root);
  return output;
}

export function resolveSafe(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, normalized);
  const relative = path.relative(absoluteRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  return absolute;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathWithMissingTail(target: string): Promise<string> {
  let current = target;
  const tail: string[] = [];
  while (true) {
    try {
      const actual = await fs.realpath(current);
      return path.join(actual, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Resolve a workspace-relative path and reject symlink targets outside the workspace. */
export async function resolveSafeRealpath(root: string, relativePath: string): Promise<{ absolute: string; relative: string }> {
  const lexical = resolveSafe(root, relativePath);
  const realRoot = await fs.realpath(path.resolve(root));
  const realTarget = await realpathWithMissingTail(lexical);
  if (!isWithin(realRoot, realTarget)) throw new Error("PATH_OUTSIDE_WORKSPACE");
  return { absolute: realTarget, relative: normalizeRelativePath(path.relative(realRoot, realTarget)) };
}

export async function sha256File(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function snapshotHash(parts: readonly string[]): string {
  return sha256Text(parts.join("\n"));
}

export function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

export function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
