import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(t, scenario = {}) {
	const root = mkdtempSync(join(tmpdir(), "publish-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "scripts"));
	for (const name of ["publish.mjs", "release-packages.mjs", "package-workspaces.mjs", "npm-pack.mjs", "npm-registry.mjs", "release-target.mjs"]) copyFileSync(new URL(name, import.meta.url), join(root, "scripts", name));
	for (const [directory, name, dependencies] of [
		["ai", "@shuv1337/shuvpi-ai", {}],
		["coding-agent", "@shuv1337/shuvpi-coding-agent", { "@shuv1337/shuvpi-ai": "1.0.0" }],
		["server", "@shuv1337/shuvpi-server", {}],
	]) {
		const path = join(root, "packages", directory);
		mkdirSync(join(path, "dist"), { recursive: true });
		writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies }));
	}
	const preload = join(root, "mock-npm.mjs");
	writeFileSync(preload, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const scenario = JSON.parse(process.env.FIXTURE_SCENARIO);
childProcess.spawnSync = (command, args, options = {}) => {
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ command, args, cwd: options.cwd }) + "\\n");
  if (command !== "npm") throw new Error("Unexpected external command");
  if (args[0] === "view") {
    if (scenario.registryFailure) return { status: 1, stdout: "", stderr: "ETIMEDOUT" };
    if (scenario.published?.includes(args[1])) return { status: 0, stdout: JSON.stringify(scenario.registryVersion ?? (scenario.wrongVersion ? "9.9.9" : "1.0.0")), stderr: "" };
    return { status: 1, stdout: "", stderr: "E404" };
  }
  if (args[0] === "pack") {
    const pkg = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
    if (scenario.badPack && pkg.name.endsWith("coding-agent")) return { status: 0, stdout: "[]", stderr: "" };
    const packed = { filename: pkg.name.split("/")[1] + "-1.0.0.tgz", files: [{ path: "package.json" }], size: 10, unpackedSize: 20 };
    return { status: 0, stdout: JSON.stringify(scenario.keyedPack ? { [pkg.name]: packed } : [packed]), stderr: "" };
  }
  if (args[0] === "publish") return { status: scenario.publishFailure ? 1 : 0, stdout: "", stderr: scenario.publishFailure ? "publish rejected" : "" };
  throw new Error("Unexpected npm command");
};
syncBuiltinESMExports();
`);
	const log = join(root, "commands.jsonl");
	writeFileSync(log, "");
	return {
		run: (args = [], env = {}) => spawnSync(process.execPath, ["--import", preload, "scripts/publish.mjs", ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, FIXTURE_LOG: log, FIXTURE_SCENARIO: JSON.stringify(scenario), RELEASE_TAG: "v1.0.0", GITHUB_REPOSITORY: "shuv1337/shuvpi", ...env } }),
		calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

test("validates the full closure before publishing, supports keyed pack JSON, and skips published versions", (t) => {
	const harness = fixture(t, { keyedPack: true, published: ["@shuv1337/shuvpi-ai@1.0.0"] });
	const result = harness.run();
	assert.equal(result.status, 0, result.stderr);
	const calls = harness.calls();
	assert.deepEqual(calls.map((call) => call.args[0]), ["view", "pack", "view", "pack", "publish"]);
	assert.ok(calls.every((call) => !JSON.stringify(call).includes("shuvpi-server")));
	assert.deepEqual(calls.at(-1).args, ["publish", "--access", "public", "--provenance", "--ignore-scripts"]);
	assert.match(calls.at(-1).cwd, /coding-agent$/);
});

test("dry run and invalid pack metadata never publish", (t) => {
	for (const [scenario, args, success] of [[{}, ["--dry-run"], true], [{ badPack: true }, [], false], [{ registryFailure: true }, [], false], [{ published: ["@shuv1337/shuvpi-ai@1.0.0"], wrongVersion: true }, [], false]]) {
		const harness = fixture(t, scenario);
		const result = harness.run(args);
		assert.equal(result.status === 0, success, result.stderr);
		assert.ok(harness.calls().every((call) => call.args[0] !== "publish"));
	}
});

test("npm 12 version arrays skip an existing release while ambiguous or mismatched versions stop publication", (t) => {
	const valid = fixture(t, { published: ["@shuv1337/shuvpi-ai@1.0.0"], registryVersion: ["1.0.0"] });
	assert.equal(valid.run().status, 0);
	assert.equal(valid.calls().filter((call) => call.args[0] === "publish").length, 1);
	for (const registryVersion of [[], ["1.0.0", "1.0.1"], ["9.9.9"], ["invalid"]]) {
		const harness = fixture(t, { published: ["@shuv1337/shuvpi-ai@1.0.0"], registryVersion });
		assert.notEqual(harness.run().status, 0);
		assert.ok(harness.calls().every((call) => call.args[0] !== "publish"));
	}
});

test("refuses tag or repository mismatch before registry or publication effects", (t) => {
	for (const env of [{ RELEASE_TAG: "v2.0.0" }, { GITHUB_REPOSITORY: "earendil-works/pi" }]) {
		const harness = fixture(t);
		const result = harness.run([], env);
		assert.notEqual(result.status, 0);
		assert.deepEqual(harness.calls(), []);
	}
});
