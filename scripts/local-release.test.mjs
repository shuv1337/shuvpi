import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "local-release-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(join(repo, "scripts"), { recursive: true });
	for (const name of ["local-release.mjs", "coding-agent-consumer.mjs", "release-packages.mjs", "package-workspaces.mjs", "npm-pack.mjs", "release-output.mjs"]) copyFileSync(new URL(name, import.meta.url), join(repo, "scripts", name));
	writeFileSync(join(repo, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
	for (const directory of ["ai", "coding-agent", "client", "protocol", "server"]) {
		const path = join(repo, "packages", directory);
		mkdirSync(join(path, "dist/bundle"), { recursive: true });
		const isCli = directory === "coding-agent";
		writeFileSync(join(path, "package.json"), JSON.stringify({
			name: `@shuv1337/shuvpi-${directory}`, version: "1.0.0", type: "module", exports: { ".": "./dist/index.js" },
			...(isCli ? { bin: { shuvpi: "dist/bundle/cli.js" }, dependencies: { "@shuv1337/shuvpi-ai": "1.0.0" }, devDependencies: { "@shuv1337/shuvpi-server": "1.0.0" } } : {}),
		}));
		writeFileSync(join(path, "dist/index.js"), isCli ? 'import { value } from "@shuv1337/shuvpi-ai"; if (value !== 42) throw new Error("Wrong local dependency"); export function createAgentSession() {} export class SessionManager { static inMemory() {} } export class ModelRuntime { static create() {} }' : "export const value = 42;");
		for (const file of ["dist/cli.js", "dist/bundle/cli.js"]) writeFileSync(join(path, file), 'console.log("1.0.0");');
	}
	const log = join(root, "commands.jsonl");
	writeFileSync(log, "");
	const preload = join(root, "mock-processes.mjs");
	writeFileSync(preload, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const realSpawn = childProcess.spawnSync;
const repo = process.cwd();
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
childProcess.spawnSync = (command, args, options = {}) => {
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ command, args, cwd: options.cwd, env: options.env }) + "\\n");
  if (command === "npm" && args[0] === "run") return ok();
  if (command === "./test.sh") return ok();
  if (command === "npm" && args[0] === "pack") {
    const manifest = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
    const filename = manifest.name.split("/")[1] + "-1.0.0.tgz";
    writeFileSync(join(args[args.indexOf("--pack-destination") + 1], filename), "fixture tarball");
    return ok(JSON.stringify({ [manifest.name]: { filename, files: [{ path: "package.json" }] } }));
  }
  if (command === "bun" && args[0] === "--version") return ok("1.3.0");
  if (command === "./scripts/build-binaries.sh") {
    const platform = args[args.indexOf("--platform") + 1];
    const output = args[args.indexOf("--out") + 1];
    mkdirSync(join(output, platform), { recursive: true });
    writeFileSync(join(output, platform, platform.startsWith("windows-") ? "shuvpi.exe" : "shuvpi"), "fixture compiled binary");
    writeFileSync(join(output, "shuvpi-" + platform + (platform.startsWith("windows-") ? ".zip" : ".tar.gz")), "fixture binary archive");
    return ok();
  }
  if (["npm", "bun"].includes(command) && args[0] === "install") {
    const consumer = JSON.parse(readFileSync(join(options.cwd, "package.json"), "utf8"));
    if (Object.keys(consumer.dependencies).join() !== "@shuv1337/shuvpi-coding-agent") throw new Error("Consumer added undeclared direct dependencies");
    for (const directory of ["ai", "coding-agent"]) cpSync(join(repo, "packages", directory), join(options.cwd, "node_modules/@shuv1337/shuvpi-" + directory), { recursive: true });
    mkdirSync(join(options.cwd, "node_modules/.bin"), { recursive: true });
    symlinkSync("../@shuv1337/shuvpi-coding-agent/dist/bundle/cli.js", join(options.cwd, "node_modules/.bin/shuvpi"));
    return ok();
  }
  if (command === process.execPath || command === "bun") return realSpawn(process.execPath, args, options);
  throw new Error("Unexpected external command: " + command + " " + args.join(" "));
};
syncBuiltinESMExports();
`);
	return {
		root, repo, output: join(root, "output"),
		run: (args) => spawnSync(process.execPath, ["--import", preload, "scripts/local-release.mjs", ...args], { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, FIXTURE_LOG: log } }),
		calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

test("local release selects the production closure and creates isolated Node and Bun consumers with metadata-derived shims", (t) => {
	const harness = fixture(t);
	const result = harness.run(["--out", harness.output]);
	assert.equal(result.status, 0, result.stderr);
	for (const directory of ["node", "bun-install"]) {
		const consumer = JSON.parse(readFileSync(join(harness.output, directory, "package.json"), "utf8"));
		assert.deepEqual(Object.keys(consumer.dependencies), ["@shuv1337/shuvpi-coding-agent"]);
		assert.deepEqual(Object.keys(consumer.overrides), ["@shuv1337/shuvpi-ai", "@shuv1337/shuvpi-coding-agent"]);
		assert.ok(existsSync(join(harness.output, directory, "shuvpi")));
		assert.equal(existsSync(join(harness.output, directory, "node_modules/@shuv1337/shuvpi-server")), false);
	}
	const calls = harness.calls();
	assert.ok(calls.every((call) => !call.cwd?.endsWith("/server")));
	assert.deepEqual(calls.filter((call) => call.command === "npm" && call.args[0] === "run").map((call) => call.args), [["run", "generate:models"], ["run", "check"], ["run", "clean"], ["run", "build:offline"], ["run", "clean"], ["run", "build"]]);
	assert.ok(calls.some((call) => call.command === "./test.sh"));
	assert.equal(calls.filter((call) => call.args[0] === "install").length, 2);
	for (const call of calls.filter((call) => call.env)) {
		assert.equal(call.env.SHUVPI_OFFLINE, "1");
		assert.equal(call.env.SHUVPI_TELEMETRY, "0");
		assert.ok(call.env.HOME.startsWith(harness.output));
		assert.ok(call.cwd.startsWith(harness.output));
	}
});

test("tarball-only local release skips installs while still refreshing and building selected packages", (t) => {
	const harness = fixture(t);
	const result = harness.run(["--out", harness.output, "--skip-check", "--skip-test", "--skip-install"]);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(harness.calls().every((call) => call.args[0] !== "install" && call.command !== "./scripts/build-binaries.sh"));
	assert.deepEqual(harness.calls()[0].args, ["run", "generate:models"]);
	assert.ok(!existsSync(join(harness.output, "node")));
});

test("local release refuses force-removal of checkout paths, ancestors and symlink aliases before effects", (t) => {
	const harness = fixture(t);
	const alias = join(harness.root, "repo-alias");
	symlinkSync(harness.repo, alias);
	for (const output of [harness.repo, harness.root, join(harness.repo, "packages"), alias, join(alias, "new-output")]) {
		const result = harness.run(["--out", output, "--force"]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /outside the repository/);
		assert.ok(existsSync(join(harness.repo, "package.json")));
		assert.deepEqual(harness.calls(), []);
	}
	assert.equal(dirname(harness.repo), harness.root);
});
