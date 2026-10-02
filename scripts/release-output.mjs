import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function physicalPath(path) {
	const requested = resolve(path);
	let parent = requested;
	while (!existsSync(parent)) parent = dirname(parent);
	return resolve(realpathSync(parent), relative(parent, requested));
}

function contains(parent, child) {
	const path = relative(parent, child);
	return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}

/** Refuse to remove the checkout, any ancestor, or source directories through aliases. */
export function releaseOutputDirectory(requested, repoRoot, allowedRepositoryDirectory) {
	const output = physicalPath(requested);
	const repo = physicalPath(repoRoot);
	const allowed = allowedRepositoryDirectory && resolve(allowedRepositoryDirectory);
	if (contains(output, repo) || (contains(repo, output) && output !== allowed)) {
		throw new Error(`Output directory must be outside the repository and cannot contain it: ${output}`);
	}
	return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3) throw new Error("Usage: release-output.mjs <binary-output-directory>");
	console.log(releaseOutputDirectory(process.argv[2], process.cwd(), resolve("packages/coding-agent/binaries")));
}
