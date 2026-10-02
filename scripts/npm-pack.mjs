/** Normalize exactly one result from npm's array or package-keyed JSON output. */
export function parsePackResult(output) {
	const parsed = JSON.parse(output);
	if (!parsed || typeof parsed !== "object") throw new Error("Invalid npm pack result");
	const results = Array.isArray(parsed) ? parsed : Object.values(parsed);
	if (results.length !== 1) throw new Error(`Expected one npm pack result, received ${results.length}`);
	const packed = results[0];
	if (!packed || typeof packed !== "object" || typeof packed.filename !== "string" || !/^[^/\\]+\.tgz$/.test(packed.filename) || !Array.isArray(packed.files)) {
		throw new Error("Invalid npm pack metadata");
	}
	return packed;
}
