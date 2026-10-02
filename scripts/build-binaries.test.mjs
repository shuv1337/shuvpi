import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"];

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "binary-release-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const write = (path, text) => {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	write("package.json", '{"private":true}');
	write("packages/coding-agent/package.json", '{"name":"@shuv1337/shuvpi-coding-agent","version":"1.0.0","bin":{"shuvpi":"dist/cli.js"}}');
	for (const path of ["README.md", "CHANGELOG.md", "dist/modes/interactive/theme/dark.json", "dist/modes/interactive/assets/logo.txt", "dist/core/export-html/template.html", "docs/cli.md", "examples/example.ts"]) write(`packages/coding-agent/${path}`, "fixture asset");
	write("node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", "fixture wasm");
	for (const platform of platforms) {
		const native = platform.replace("windows-", "win32-");
		write(`packages/tui/native/${native.split("-")[0]}/prebuilds/${native}/helper.node`, native);
	}
	mkdirSync(join(repo, "scripts"));
	for (const name of ["build-binaries.sh", "release-output.mjs"]) copyFileSync(new URL(name, import.meta.url), join(repo, "scripts", name));
	const fakebin = join(root, "bin");
	mkdirSync(fakebin);
	const log = join(root, "bun.jsonl");
	writeFileSync(log, "");
	writeFileSync(join(fakebin, "bun"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "build") throw new Error("Unexpected Bun command");
const output = args[args.indexOf("--outfile") + 1];
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, "compiled fixture " + args.find((arg) => arg.startsWith("--target=")));
fs.chmodSync(output, 0o755);
`);
	chmodSync(join(fakebin, "bun"), 0o755);
	return {
		root, repo, output: join(root, "output"),
		run: (args) => spawnSync("bash", ["scripts/build-binaries.sh", "--skip-install", "--skip-build", ...args], { cwd: repo, encoding: "utf8", env: { PATH: `${fakebin}:${process.env.PATH}`, HOME: root, FIXTURE_LOG: log } }),
		calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

test("binary archives preserve all six platforms, worker entrypoints and matching native helpers", (t) => {
	const harness = fixture(t);
	const result = harness.run(["--out", harness.output]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(harness.calls().length, platforms.length);
	for (const [index, platform] of platforms.entries()) {
		const args = harness.calls()[index];
		assert.ok(args.includes(`--target=bun-${platform}${platform.endsWith("x64") ? "-baseline" : ""}`));
		for (const arg of ["--compile", "--no-compile-autoload-bunfig", "./dist/bun/cli.js", "./src/utils/image-resize-worker.ts", "./src/extensions/codemode/worker.ts"]) assert.ok(args.includes(arg));
		const native = platform.replace("windows-", "win32-");
		const directory = join(harness.output, platform);
		assert.ok(existsSync(join(directory, platform.startsWith("windows-") ? "shuvpi.exe" : "shuvpi")));
		assert.equal(readFileSync(join(directory, `native/${native.split("-")[0]}/prebuilds/${native}/helper.node`), "utf8"), native);
		for (const path of ["package.json", "photon_rs_bg.wasm", "theme/dark.json", "assets/logo.txt", "export-html/template.html", "docs/cli.md", "examples/example.ts"]) assert.ok(existsSync(join(directory, path)));
		const windows = platform.startsWith("windows-");
		const archive = join(harness.output, `shuvpi-${platform}${windows ? ".zip" : ".tar.gz"}`);
		const contents = spawnSync(windows ? "unzip" : "tar", windows ? ["-Z1", archive] : ["-tzf", archive], { encoding: "utf8" });
		assert.equal(contents.status, 0, contents.stderr);
		assert.ok(contents.stdout.includes(windows ? "shuvpi.exe" : "shuvpi/shuvpi"));
		assert.ok(contents.stdout.includes(`native/${native.split("-")[0]}/prebuilds/${native}/helper.node`));
	}
});

test("single-platform binary build derives CLI names and rejects destructive output paths before building", (t) => {
	const harness = fixture(t);
	const alias = join(harness.root, "alias");
	symlinkSync(harness.repo, alias);
	for (const output of [harness.root, harness.repo, join(harness.repo, "packages"), join(alias, "source")]) {
		const result = harness.run(["--out", output]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /outside the repository/);
		assert.deepEqual(harness.calls(), []);
		assert.ok(existsSync(join(harness.repo, "package.json")));
	}
	const result = harness.run(["--platform", "linux-x64"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(harness.calls().length, 1);
	assert.ok(existsSync(join(harness.repo, "packages/coding-agent/binaries/shuvpi-linux-x64.tar.gz")));
});
