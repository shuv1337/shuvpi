import { readFileSync } from "node:fs";

export interface ShuvpiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readShuvpiManifest(packageJsonPath: string): ShuvpiManifest | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isObject(pkg) || !isObject(pkg.shuvpi)) {
			return null;
		}

		const manifest: ShuvpiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.shuvpi[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
