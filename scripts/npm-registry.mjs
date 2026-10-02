/** Normalize one exact version from npm's scalar or single-result array JSON. */
export function parseRegistryVersion(output) {
	const parsed = JSON.parse(output);
	const version = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
	if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("Expected one valid npm registry version");
	}
	return version;
}
