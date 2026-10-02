import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("pinning exempts actual workspace names across the fork rename but rejects external ranges and aliases", (t) => {
	const root = mkdtempSync(join(tmpdir(), "dependency-pins-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "scripts"));
	mkdirSync(join(root, "packages/ai"), { recursive: true });
	for (const name of ["check-pinned-deps.mjs", "package-workspaces.mjs"]) copyFileSync(new URL(name, import.meta.url), join(root, "scripts", name));
	writeFileSync(join(root, "packages/ai/package.json"), JSON.stringify({ name: "@shuv1337/shuvpi-ai", version: "1.0.0" }));
	const run = (dependencies) => {
		writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies }));
		return spawnSync(process.execPath, ["scripts/check-pinned-deps.mjs"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
	};
	assert.equal(run({ "@shuv1337/shuvpi-ai": "^1.0.0", sdk: "2.3.4", aliased: "npm:@vendor/sdk@2.3.4" }).status, 0);
	for (const dependency of [{ "@shuv1337/shuvpi-external": "^1.0.0" }, { sdk: "~2.3.4" }, { aliased: "npm:@vendor/sdk@^2.3.4" }]) {
		const result = run(dependency);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /must be pinned/);
	}
});
