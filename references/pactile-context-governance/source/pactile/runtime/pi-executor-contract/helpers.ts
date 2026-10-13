
export const HEX_SHA_V1 = /^[0-9a-f]{40,128}$/i;
export const ABSOLUTE_PATH_V1 = /^[A-Za-z]:/;

export function requireTextV1(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Normalize a declared write set that may legitimately be empty in evidence:
 * a rejected binding must still produce a Run Result. Absolute paths, drive
 * spellings, traversal and control characters are refused so a write set can
 * never smuggle host-filesystem authority into the contract.
 */
export function freezeWriteSetV1(
  value: readonly string[],
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const normalized: string[] = [];
  value.forEach((entry, index) => {
    const path = entry.replaceAll("\\", "/");
    const unsafe = [
      path.trim().length === 0,
      path.startsWith("/"),
      ABSOLUTE_PATH_V1.test(path),
      path.split("/").includes(".."),
      path.includes("\0"),
    ].some(Boolean);
    if (unsafe) {
      throw new TypeError(
        `${label}[${index}] must be a project-relative POSIX path without traversal`,
      );
    }
    normalized.push(path);
  });
  return Object.freeze(normalized);
}

/** A frozen, non-empty write set is required for dispatch authority. */
export function requireWriteSetV1(
  value: readonly string[],
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  return freezeWriteSetV1(value, label);
}

/* -------------------------------------------------------------------------- */
/* Evidence-only write-set normalization                                        */
/* -------------------------------------------------------------------------- */

/**
 * Evidence-only write-set normalization for refused attempts.
 *
 * A rejected binding must still produce a bounded Run Result, so unsafe
 * entries (absolute, drive-qualified, traversal, control characters) are
 * dropped instead of echoed; the rejection reason already records why the
 * attempt stopped. This never grants write authority and never repairs an
 * unsafe write set into an admissible one.
 */
export function piExecutorEvidenceWriteSetV1(
  value: readonly string[] | null | undefined,
): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const safe: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const path = entry.replaceAll("\\", "/");
    if (
      path.trim().length === 0 ||
      path.startsWith("/") ||
      ABSOLUTE_PATH_V1.test(path) ||
      path.split("/").includes("..") ||
      path.includes("\0")
    ) {
      continue;
    }
    safe.push(path);
  }
  return Object.freeze(safe);
}
