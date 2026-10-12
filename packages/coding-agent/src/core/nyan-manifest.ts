import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface NyanManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the resources a package declares. The `nyan` field wins; a package that has none but declares a Pi `pi` field
 * is read the same way, so a package written for Pi loads without changes (see core/extensions/pi-compat.ts).
 */
export function readNyanManifest(packageJsonPath: string): NyanManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		const declared = isObject(pkg)
			? isObject(pkg.nyan)
				? pkg.nyan
				: isObject(pkg.pi)
					? pkg.pi
					: undefined
			: undefined;
		if (!declared) {
			return null;
		}

		const manifest: NyanManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = declared[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
