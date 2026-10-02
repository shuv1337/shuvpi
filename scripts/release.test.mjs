import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(t, scenario = {}) {
	const root = mkdtempSync(join(tmpdir(), "initial-release-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "scripts"));
	for (const name of ["release.mjs", "release-packages.mjs", "release-target.mjs", "package-workspaces.mjs", "npm-registry.mjs"]) copyFileSync(new URL(name, import.meta.url), join(root, "scripts", name));
	const published = "## [1.0.0] - 2026-10-01\n\nExisting upstream history must remain exact.\n";
	for (const [directory, name, dependencies] of [
		["ai", "@shuv1337/shuvpi-ai", {}],
		["coding-agent", "@shuv1337/shuvpi-coding-agent", { "@shuv1337/shuvpi-ai": "^1.0.0" }],
		["server", "@shuv1337/shuvpi-server", {}],
	]) {
		const path = join(root, "packages", directory);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies }));
		writeFileSync(join(path, "CHANGELOG.md"), `# Changelog\n\n${scenario.ordinary ? "## [Unreleased]\n\n- Next change.\n\n" : ""}${published}`);
	}
	writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
	mkdirSync(join(root, "release-notes"));
	if (!scenario.missingNotes) writeFileSync(join(root, "release-notes/1.0.0.md"), "# Reviewed Shuvpi 1.0.0 fixture notes\n");
	const log = join(root, "commands.jsonl");
	writeFileSync(log, "");
	const preload = join(root, "commands.mjs");
	writeFileSync(preload, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const scenario = JSON.parse(process.env.FIXTURE_SCENARIO);
const files = () => ["package-lock.json", ...readdirSync("packages").flatMap((name) => ["packages/" + name + "/package.json", "packages/" + name + "/CHANGELOG.md"]), ...readdirSync("release-notes").map((name) => "release-notes/" + name)];
let baseline = new Map(files().map((path) => [path, readFileSync(path, "utf8")]));
let staged = [];
const result = (stdout = "", status = 0, stderr = "") => ({ status, stdout, stderr });
childProcess.spawnSync = (command, args) => {
 appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ command, args }) + "\\n");
 if (command === "git") {
  if (args[0] === "branch") return result(scenario.branch ?? (scenario.ordinary ? "main" : "release/1.0"));
  if (args[0] === "remote") return result(scenario.origin ?? "git@github.com:shuv1337/shuvpi.git");
  if (args[0] === "status") return result(scenario.dirty ? " M existing.txt" : "");
  if (args[0] === "show-ref") return result("", scenario.localTag ? 0 : 1);
  if (args[0] === "ls-remote") return result("", scenario.remoteError ? 128 : scenario.remoteTag ? 0 : 2);
  if (args[0] === "rev-parse") return result("0123456789abcdef0123456789abcdef01234567");
  if (args[0] === "ls-files") return result([...files().filter((path) => baseline.get(path) !== readFileSync(path, "utf8")), ...(existsSync("other-session.txt") ? ["other-session.txt"] : [])].join("\\n"));
  if (args[0] === "add") { staged = args.slice(2); return result(); }
  if (args[0] === "commit") { baseline = new Map(files().map((path) => [path, readFileSync(path, "utf8")])); staged = []; return result(); }
  if (args[0] === "diff") return result(staged.join("\\n"));
  if (args[0] === "tag" || args[0] === "push") return result();
  throw new Error("Unexpected git command");
 }
 if (command === "npm") {
  if (args[0] === "view") {
   const exact = args[1].lastIndexOf("@") > 0;
   if (scenario.registryError) return result("", 1, "ETIMEDOUT");
   if (exact) return scenario.published ? result(JSON.stringify("1.0.0")) : result("", 1, "E404");
   if (scenario.newPackage && args[1].endsWith("coding-agent")) return result("", 1, "E404");
   return result(JSON.stringify(scenario.registryVersion ?? "0.87.1"));
  }
  if (args[0] === "version") {
   for (const directory of readdirSync("packages")) { const path = join("packages", directory, "package.json"); const pkg = JSON.parse(readFileSync(path, "utf8")); pkg.version = args[1]; writeFileSync(path, JSON.stringify(pkg)); }
  }
  if (args[0] === "run" && args[1] === "check") {
   if (scenario.unrelatedChange) writeFileSync("other-session.txt", "preserve this work");
   if (scenario.checkFailure) return result("", 1, "fixture check failure");
  }
  if (["version", "install", "ci", "run"].includes(args[0])) return result();
  throw new Error("Unexpected npm command");
 }
 if (command === "node" || command === "./test.sh") return result();
 throw new Error("Unexpected external command " + command);
};
syncBuiltinESMExports();
`);
	return {
		root, published,
		run: (args = ["1.0.0", "--initial", "--branch", "release/1.0"], env = {}) => spawnSync(process.execPath, ["--import", preload, "scripts/release.mjs", ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, FIXTURE_LOG: log, FIXTURE_SCENARIO: JSON.stringify(scenario), ...env } }),
		calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

test("initial 1.0 keeps released changelogs/version and stages an exact fork manifest before atomically pushing the selected branch/tag", (t) => {
	const harness = fixture(t);
	const result = harness.run();
	assert.equal(result.status, 0, result.stderr);
	const calls = harness.calls();
	assert.ok(!calls.some((call) => call.command === "npm" && ["version", "publish"].includes(call.args[0])));
	assert.deepEqual(calls.filter((call) => call.command === "git" && call.args[0] === "commit").map((call) => call.args[2]), ["Release v1.0.0", "Add [Unreleased] section for next cycle"]);
	assert.deepEqual(calls.at(-1), { command: "git", args: ["push", "--atomic", "origin", "HEAD:refs/heads/release/1.0", "refs/tags/v1.0.0"] });
	const changelog = readFileSync(join(harness.root, "packages/coding-agent/CHANGELOG.md"), "utf8");
	assert.equal(changelog, `# Changelog\n\n## [Unreleased]\n\n${harness.published}`);
	const manifest = JSON.parse(readFileSync(join(harness.root, "release-notes/1.0.0.manifest.json"), "utf8"));
	assert.equal(manifest.version, "1.0.0");
	assert.equal(manifest.branch, "release/1.0");
	assert.deepEqual(manifest.packages.map((pkg) => pkg.name), ["@shuv1337/shuvpi-ai", "@shuv1337/shuvpi-coding-agent"]);
});

test("ordinary patch/minor releases stay on main and update every workspace without rewriting older history", (t) => {
	for (const [bump, version] of [["patch", "1.0.1"], ["minor", "1.1.0"]]) {
		const harness = fixture(t, { ordinary: true });
		const result = harness.run([bump]);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(harness.calls().some((call) => call.command === "npm" && call.args[0] === "version" && call.args[1] === version));
		for (const directory of ["ai", "coding-agent", "server"]) assert.equal(JSON.parse(readFileSync(join(harness.root, "packages", directory, "package.json"), "utf8")).version, version);
		const changelog = readFileSync(join(harness.root, "packages/coding-agent/CHANGELOG.md"), "utf8");
		assert.ok(changelog.endsWith(harness.published));
		assert.match(changelog, new RegExp(`## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`));
		assert.deepEqual(harness.calls().at(-1).args, ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/v${version}`]);
	}
});

test("initial release accepts npm 12 single-result version arrays but rejects ambiguous or malformed registry versions before mutation", (t) => {
	const valid = fixture(t, { registryVersion: ["0.87.1"] });
	assert.equal(valid.run().status, 0);
	for (const registryVersion of [[], ["0.87.1", "0.87.2"], ["invalid"], { version: "0.87.1" }]) {
		const harness = fixture(t, { registryVersion });
		assert.notEqual(harness.run().status, 0);
		assert.ok(harness.calls().every((call) => call.command === "git" ? !["add", "commit", "tag", "push"].includes(call.args[0]) : call.command === "npm" && call.args[0] === "view"));
	}
});

test("initial release refuses branch/origin/dirty/tag/registry/notes uncertainty before mutation", (t) => {
	for (const scenario of [{ branch: "main" }, { origin: "git@github.com:earendil-works/pi.git" }, { dirty: true }, { localTag: true }, { remoteTag: true }, { remoteError: true }, { registryError: true }, { published: true }, { missingNotes: true }, { newPackage: true }]) {
		const harness = fixture(t, scenario);
		const result = harness.run();
		assert.notEqual(result.status, 0, JSON.stringify(scenario));
		assert.ok(harness.calls().every((call) => call.command === "git" ? !["add", "commit", "tag", "push"].includes(call.args[0]) : call.command === "npm" && call.args[0] === "view"));
		assert.equal(readFileSync(join(harness.root, "packages/coding-agent/CHANGELOG.md"), "utf8"), `# Changelog\n\n${harness.published}`);
	}
});

test("new package allowance is exact and failed checks or unrelated concurrent work never commit", (t) => {
	const allowed = fixture(t, { newPackage: true });
	assert.equal(allowed.run(undefined, { SHUVPI_RELEASE_ALLOW_NEW_PACKAGES: "@shuv1337/shuvpi-coding-agent" }).status, 0);
	for (const scenario of [{ checkFailure: true }, { unrelatedChange: true }]) {
		const harness = fixture(t, scenario);
		assert.notEqual(harness.run().status, 0);
		assert.ok(harness.calls().every((call) => call.command !== "git" || !["add", "commit", "tag", "push"].includes(call.args[0])));
		if (scenario.unrelatedChange) assert.equal(readFileSync(join(harness.root, "other-session.txt"), "utf8"), "preserve this work");
	}
});

test("major, equal ordinary version and unknown options never run external commands", (t) => {
	for (const args of [["major"], ["1.0.0"], ["2.0.0"], ["patch", "--typo"], ["1.0.0", "--initial"]]) {
		const harness = fixture(t);
		assert.notEqual(harness.run(args).status, 0);
		assert.deepEqual(harness.calls(), []);
	}
});
