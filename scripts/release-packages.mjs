import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

/**
 * Workspace packages this fork does not publish even though their manifests are not
 * marked private. The fork publishes only the `shuvpi` CLI closure.
 */
const UNPUBLISHED_PACKAGE_DIRECTORIES = new Set([
	"packages/durable",
	"packages/mom",
	"packages/pods",
	"packages/server",
	"packages/web-ui",
]);

/** Publish order for the CLI closure; discovered packages not listed here follow alphabetically. */
const PUBLISH_ORDER = [
	"packages/chord",
	"packages/telemetry",
	"packages/ai",
	"packages/tui",
	"packages/agent",
	"packages/protocol",
	"packages/client",
	"packages/session-backends/sqlite-node",
	"packages/coding-agent",
];

function publishRank(directory) {
	const index = PUBLISH_ORDER.indexOf(directory);
	return index === -1 ? PUBLISH_ORDER.length : index;
}

export function getPublicWorkspacePackages() {
	return findPackageDirectories()
		.filter((directory) => !UNPUBLISHED_PACKAGE_DIRECTORIES.has(directory))
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.sort((a, b) => publishRank(a.directory) - publishRank(b.directory) || a.directory.localeCompare(b.directory))
		.map(({ directory, name, version }) => ({ directory, name, version }));
}
