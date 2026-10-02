import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function getPublicWorkspacePackages() {
	return findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}

/** Production workspace closure, in dependency-first publication/build order. */
export function getReleasePackages({ packagesRoot = "packages", entrypoints = [join(packagesRoot, "coding-agent")] } = {}) {
	const workspaces = findPackageDirectories(packagesRoot).map((directory) => ({
		directory,
		...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
	}));
	const byName = new Map();
	for (const pkg of workspaces) {
		if (byName.has(pkg.name)) throw new Error(`Duplicate workspace package: ${pkg.name}`);
		byName.set(pkg.name, pkg);
	}
	const selected = [];
	const visited = new Set();
	const visiting = new Set();
	const visit = (pkg) => {
		if (visited.has(pkg.name)) return;
		if (visiting.has(pkg.name)) throw new Error(`Workspace dependency cycle at ${pkg.name}`);
		if (pkg.private === true) throw new Error(`Release dependency is private: ${pkg.name}`);
		visiting.add(pkg.name);
		const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
		for (const name of Object.keys(dependencies).sort()) {
			const dependency = byName.get(name);
			if (dependency) visit(dependency);
			else if (String(dependencies[name]).startsWith("workspace:")) throw new Error(`Missing workspace dependency ${name} in ${pkg.name}`);
		}
		visiting.delete(pkg.name);
		visited.add(pkg.name);
		selected.push({ directory: pkg.directory, name: pkg.name, version: pkg.version });
	};
	for (const entrypoint of entrypoints) {
		const pkg = workspaces.find((workspace) => resolve(workspace.directory) === resolve(entrypoint));
		if (!pkg) throw new Error(`Release entrypoint is not a workspace: ${entrypoint}`);
		visit(pkg);
	}
	return selected;
}
