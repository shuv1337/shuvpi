#!/usr/bin/env node
/** Lockstep Shuvpi release. Invocation commits, tags and pushes; it never publishes locally. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRegistryVersion } from "./npm-registry.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages, getReleasePackages } from "./release-packages.mjs";
import { assertReleaseTarget, RELEASE_REPOSITORY } from "./release-target.mjs";

const args = process.argv.slice(2);
const target = args.shift();
const initial = args.includes("--initial");
const branchIndex = args.indexOf("--branch");
const branch = branchIndex === -1 ? "main" : args[branchIndex + 1];
const remaining = args.filter((_arg, index) => branchIndex === -1 || (index !== branchIndex && index !== branchIndex + 1));
const validTarget = target === "patch" || target === "minor" || /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target ?? "");
if (!validTarget || remaining.some((arg) => arg !== "--initial") || remaining.filter((arg) => arg === "--initial").length > 1 ||
	(initial ? target !== "1.0.0" || branch !== "release/1.0" : branch !== "main")) {
	throw new Error("Usage: release.mjs <patch|minor|x.y.z> (main), or release.mjs 1.0.0 --initial --branch release/1.0");
}

function command(command, values, { capture = false, allowFailure = false } = {}) {
	console.log(`$ ${[command, ...values].join(" ")}`);
	const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
	const result = spawnSync(executable, values, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
	if (result.status !== 0 && !allowFailure) throw new Error(`Command failed: ${command} ${values.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	return result;
}
const output = (executable, values) => command(executable, values, { capture: true }).stdout.trim();
const packages = getReleasePackages();
const currentVersion = assertReleaseTarget(packages, { tag: `v${packages[0]?.version}`, repository: RELEASE_REPOSITORY });
const parts = currentVersion.split(".").map(Number);
const version = target === "patch" ? `${parts[0]}.${parts[1]}.${parts[2] + 1}` : target === "minor" ? `${parts[0]}.${parts[1] + 1}.0` : target;
const versionParts = version.split(".").map(Number);
const greater = versionParts[0] > parts[0] || (versionParts[0] === parts[0] && (versionParts[1] > parts[1] || (versionParts[1] === parts[1] && versionParts[2] > parts[2])));
if (initial ? currentVersion !== "1.0.0" : !greater || versionParts[0] !== parts[0]) throw new Error(`Invalid release transition: ${currentVersion} -> ${version}`);
const allPackages = getPublicWorkspacePackages();
if (allPackages.some((pkg) => pkg.version !== currentVersion)) throw new Error("All public workspace versions must remain lockstep");
const tag = `v${version}`;
const notesFile = `release-notes/${version}.md`;
const manifestFile = `release-notes/${version}.manifest.json`;
if (initial && (!existsSync(notesFile) || !readFileSync(notesFile, "utf8").trim())) throw new Error(`Initial release requires reviewed notes in ${notesFile}; existing upstream changelogs will not be rewritten`);

if (output("git", ["branch", "--show-current"]) !== branch) throw new Error(`Release must run on ${branch}`);
const origins = output("git", ["remote", "get-url", "--push", "--all", "origin"]).split("\n");
const allowedOrigins = new Set([`git@github.com:${RELEASE_REPOSITORY}.git`, `https://github.com/${RELEASE_REPOSITORY}.git`, `https://github.com/${RELEASE_REPOSITORY}`, `ssh://git@github.com/${RELEASE_REPOSITORY}.git`]);
if (!origins.length || origins.some((origin) => !allowedOrigins.has(origin))) throw new Error(`origin push destination must be ${RELEASE_REPOSITORY}`);
if (output("git", ["status", "--porcelain"])) throw new Error("Commit or remove local changes before releasing");
const localTag = command("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { capture: true, allowFailure: true });
if (localTag.status !== 1) throw new Error(`Local tag ${tag} exists or could not be checked; no tags will be overwritten`);
const remoteTag = command("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], { capture: true, allowFailure: true });
if (remoteTag.status !== 2) throw new Error(`Remote tag ${tag} exists or its absence could not be verified`);

const allowedNew = new Set((process.env.SHUVPI_RELEASE_ALLOW_NEW_PACKAGES ?? "").split(",").map((name) => name.trim()).filter(Boolean));
for (const name of allowedNew) if (!packages.some((pkg) => pkg.name === name)) throw new Error(`New-package allowlist contains an unselected package: ${name}`);
for (const pkg of packages) {
	const result = command("npm", ["view", `${pkg.name}@${version}`, "version", "--json"], { capture: true, allowFailure: true });
	if (result.status === 0 || !/E404|404 Not Found/.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) throw new Error(`Release version ${pkg.name}@${version} already exists or its absence could not be verified`);
	const registered = command("npm", ["view", pkg.name, "version", "--json"], { capture: true, allowFailure: true });
	if (registered.status === 0) {
		parseRegistryVersion(registered.stdout);
		continue;
	}
	if (registered.status !== 0 && /E404|404 Not Found/.test(`${registered.stdout ?? ""}\n${registered.stderr ?? ""}`) && allowedNew.has(pkg.name)) continue;
	throw new Error(`Package registration unavailable for ${pkg.name}; explicitly allow intentionally new packages with SHUVPI_RELEASE_ALLOW_NEW_PACKAGES`);
}

// Everything above is read-only. Initial 1.0 keeps the upstream version and released history.
if (!initial) command("npm", ["version", version, "--workspaces", "--no-git-tag-version", "--no-workspaces-update", "--ignore-scripts"]);
command("node", ["scripts/sync-versions.js"]);
const workspaceVersions = new Map(getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
	if (!path.startsWith("packages/") || pkg.link === true) continue;
	for (const [name, expected] of workspaceVersions) if (path.endsWith(`/node_modules/${name}`) && pkg.version !== expected) delete lock.packages[path];
}
writeFileSync("package-lock.json", `${JSON.stringify(lock, null, "\t")}\n`);
command("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
command("npm", ["ci", "--ignore-scripts"]);
if (getPublicWorkspacePackages().some((pkg) => pkg.version !== version)) throw new Error(`Version update did not produce lockstep ${version}`);

const changelogs = findPackageDirectories().map((directory) => join(directory, "CHANGELOG.md")).filter((path) => existsSync(path));
if (initial) {
	mkdirSync(dirname(manifestFile), { recursive: true });
	writeFileSync(manifestFile, `${JSON.stringify({ version, repository: RELEASE_REPOSITORY, branch, sourceCommit: output("git", ["rev-parse", "HEAD"]), packages: getReleasePackages().map(({ name, version }) => ({ name, version })), notes: notesFile }, null, 2)}\n`);
} else {
	const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf8");
		if (content.includes(`## [${version}]`)) throw new Error(`Released changelog section already exists in ${changelog}`);
		if (content.includes("## [Unreleased]")) writeFileSync(changelog, content.replace("## [Unreleased]", `## [${version}] - ${date}`));
	}
}
command("npm", ["run", "generate:models"]);
command("npm", ["run", "check:model-data"]);
command("npm", ["run", "shrinkwrap:coding-agent"]);
command("npm", ["run", "install-lock:coding-agent"]);
command("npm", ["run", "check"]);
command("node", ["scripts/build-release-packages.mjs", "--offline-model-data"]);
command("./test.sh", []);
command("npm", ["run", "check:package-install"]);

const allowedPaths = new Set(["package-lock.json", manifestFile, ...changelogs, ...findPackageDirectories().map((directory) => join(directory, "package.json")), "packages/coding-agent/npm-shrinkwrap.json", "packages/coding-agent/install-lock/package-lock.json", "packages/ai/src/models.generated.ts"]);
function stageReleaseFiles() {
	const paths = [...new Set(output("git", ["ls-files", "-m", "-o", "-d", "--exclude-standard"]).split("\n").filter(Boolean))];
	const unexpected = paths.filter((path) => !allowedPaths.has(path));
	if (unexpected.length) throw new Error(`Unexpected changes appeared during release; leaving them unstaged: ${unexpected.join(", ")}`);
	if (paths.length) command("git", ["add", "--", ...paths]);
}
stageReleaseFiles();
command("git", ["commit", "-m", `Release ${tag}`]);
command("git", ["tag", tag]);
for (const changelog of changelogs) {
	const content = readFileSync(changelog, "utf8");
	if (!content.includes("## [Unreleased]")) writeFileSync(changelog, content.replace(/^(# Changelog\r?\n\r?\n)/, "$1## [Unreleased]\n\n"));
}
stageReleaseFiles();
if (output("git", ["diff", "--cached", "--name-only"])) command("git", ["commit", "-m", "Add [Unreleased] section for next cycle"]);
command("git", ["push", "--atomic", "origin", `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`]);
console.log(`Prepared ${tag}; CI publishes the npm closure and then the GitHub release and optional Discord announcement.`);
