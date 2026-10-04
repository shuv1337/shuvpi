import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-copy-examples.mjs", import.meta.url));

async function check(t, files) {
	const root = await mkdtemp(join(tmpdir(), "shuvpi-copy-examples-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [path, contents] of Object.entries(files)) {
		const fullPath = join(root, path);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, contents);
	}
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

test("rejects cp examples whose source and destination are the same path", async (t) => {
	const result = await check(t, {
		"README.md": ["```bash", "cp -a .shuvpi .shuvpi", "cp -a ~/.shuvpi/ ~/.shuvpi", 'cp "./.pi" ./.pi', "```"].join(
			"\n",
		),
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /README\.md:2: cp copies \.shuvpi onto itself/);
	assert.match(result.stderr, /README\.md:3: cp copies ~\/\.shuvpi\/ onto itself/);
	assert.match(result.stderr, /README\.md:4: cp copies \.\/\.pi onto itself/);
});

test("accepts migration copies from upstream paths and ignores vendor trees", async (t) => {
	const result = await check(t, {
		"README.md": ["```bash", "mkdir -p ~/.shuvpi", "cp -a ~/.pi/agent ~/.shuvpi/", "cp -a .pi .shuvpi", "```"].join(
			"\n",
		),
		"docs/install.md": "$ cp permission-gate.ts ~/.shuvpi/agent/extensions/\n",
		"packages/example/vendor/NOTES.md": "cp -a .shuvpi .shuvpi\n",
		"node_modules/pkg/README.md": "cp -a .shuvpi .shuvpi\n",
	});
	assert.equal(result.status, 0, result.stderr);
});
