import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getReleasePackages } from "./release-packages.mjs";
import { parsePackResult } from "./npm-pack.mjs";

function fixture(t, manifests) {
	const root = mkdtempSync(join(tmpdir(), "release-closure-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packagesRoot = join(root, "packages");
	for (const [directory, manifest] of Object.entries(manifests)) {
		mkdirSync(join(packagesRoot, directory), { recursive: true });
		writeFileSync(join(packagesRoot, directory, "package.json"), JSON.stringify({ version: "1.0.0", ...manifest }));
	}
	return { packagesRoot };
}

test("release closure follows runtime and optional/peer workspace dependencies, excluding development and unrelated packages", (t) => {
	const options = fixture(t, {
		"coding-agent": { name: "@fixture/cli", dependencies: { "@fixture/agent": "1.0.0" }, optionalDependencies: { "@fixture/native": "1.0.0" }, peerDependencies: { "@fixture/peer": "1.0.0" }, devDependencies: { "@fixture/server": "1.0.0" } },
		agent: { name: "@fixture/agent", dependencies: { "@fixture/ai": "1.0.0", "external-sdk": "1.0.0" } },
		ai: { name: "@fixture/ai" }, native: { name: "@fixture/native" }, peer: { name: "@fixture/peer" },
		server: { name: "@fixture/server" }, example: { name: "@fixture/example", private: true },
	});
	assert.deepEqual(getReleasePackages(options).map((pkg) => pkg.name), ["@fixture/ai", "@fixture/agent", "@fixture/native", "@fixture/peer", "@fixture/cli"]);
});

test("current CLI closure contains durable, MCP and codemode but no development server/client/protocol", () => {
	const directories = getReleasePackages().map((pkg) => pkg.directory);
	for (const directory of ["durable", "mcp", "codemode", "chord", "telemetry", "ai", "agent", "tui", "coding-agent"]) assert.ok(directories.includes(`packages/${directory}`));
	for (const directory of ["server", "client", "protocol", "web-ui", "mom", "pods"]) assert.ok(!directories.includes(`packages/${directory}`));
	assert.equal(directories.at(-1), "packages/coding-agent");
});

test("release closure fails on private dependencies, missing workspaces and cycles", (t) => {
	for (const [dependency, expected] of [
		[{ name: "@fixture/dep", private: true }, /private/],
		[{ name: "@fixture/dep", dependencies: { "@fixture/cli": "1.0.0" } }, /cycle/],
		[{ name: "@fixture/other" }, /Missing workspace/],
	]) {
		const options = fixture(t, { "coding-agent": { name: "@fixture/cli", dependencies: { "@fixture/dep": "workspace:*" } }, dep: dependency });
		assert.throws(() => getReleasePackages(options), expected);
	}
});

test("npm pack parser accepts array and keyed results and rejects ambiguous or unsafe metadata", () => {
	const packed = { filename: "fixture-1.0.0.tgz", files: [{ path: "package.json" }], size: 12, unpackedSize: 24 };
	assert.deepEqual(parsePackResult(JSON.stringify([packed])), packed);
	assert.deepEqual(parsePackResult(JSON.stringify({ "@fixture/pkg": packed })), packed);
	for (const data of [null, [], {}, [packed, packed], [{ ...packed, filename: "../escape.tgz" }], [{ ...packed, files: null }]]) assert.throws(() => parsePackResult(JSON.stringify(data)));
});
