import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace packages this fork publishes to npm, in dependency order.
 *
 * The fork publishes only the `shuvpi` CLI closure. Fork-owned workspaces that are
 * not part of that closure (`mom`, `pods`, `web-ui`, `codex-runtime`, `server`) stay
 * unpublished even though their manifests are not marked private.
 */
const PUBLISHED_PACKAGE_DIRECTORIES = [
	"packages/telemetry",
	"packages/ai",
	"packages/tui",
	"packages/agent",
	"packages/protocol",
	"packages/client",
	"packages/session-backends/sqlite-node",
	"packages/coding-agent",
];

export function getPublicWorkspacePackages() {
	return PUBLISHED_PACKAGE_DIRECTORIES.map((directory) => {
		const { name, version, private: isPrivate } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		if (isPrivate === true) {
			throw new Error(`${directory} is marked private but listed as a published package.`);
		}
		return { directory, name, version };
	});
}
