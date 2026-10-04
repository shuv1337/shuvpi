import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { omitInheritedAllowScripts } from "./omit-inherited-allow-scripts.mjs";

const codingAgentName = "@shuv1337/shuvpi-coding-agent";

function poisonedEnv(extra = {}) {
	return {
		...process.env,
		npm_config_allow_scripts: "@xai-official/grok",
		NPM_CONFIG_ALLOW_SCRIPTS: "@xai-official/grok",
		...extra,
	};
}

// #233: npm run exports ~/.npmrc allow-scripts, and npm 12 rejects that env value during project installs.
test("omitInheritedAllowScripts drops only allow-scripts env keys", () => {
	const env = {
		npm_config_allow_scripts: "@xai-official/grok",
		NPM_CONFIG_ALLOW_SCRIPTS: "@xai-official/grok",
		Npm_Config_Allow_Scripts: "@xai-official/grok",
		npm_config_cache: "/tmp/cache",
		npm_config_allow_scripts_pin: "false",
		PATH: "/usr/bin",
	};
	const childEnv = omitInheritedAllowScripts(env);
	assert.equal(childEnv.npm_config_allow_scripts, undefined);
	assert.equal(childEnv.NPM_CONFIG_ALLOW_SCRIPTS, undefined);
	assert.equal(childEnv.Npm_Config_Allow_Scripts, undefined);
	assert.equal(childEnv.npm_config_cache, "/tmp/cache");
	assert.equal(childEnv.npm_config_allow_scripts_pin, "false");
	assert.equal(childEnv.PATH, "/usr/bin");
	assert.equal(env.npm_config_allow_scripts, "@xai-official/grok");
});

// #233: local-release.mjs is the npm run entrypoint, so its children must not inherit the exported policy.
test("local-release children do not inherit allow-scripts", () => {
	const root = mkdtempSync(join(tmpdir(), "shuvpi-allow-scripts-"));
	const outPath = join(root, "seen.json");
	try {
		const probe = join(root, "probe.mjs");
		writeFileSync(
			probe,
			`import { writeFileSync } from "node:fs";
writeFileSync(process.env.SHUVPI_PROBE_OUT, JSON.stringify({
	lower: process.env.npm_config_allow_scripts ?? null,
	upper: process.env.NPM_CONFIG_ALLOW_SCRIPTS ?? null,
	cache: process.env.npm_config_cache ?? null,
}));
`,
		);
		const runner = join(root, "runner.mjs");
		const localRelease = fileURLToPath(new URL("./local-release.mjs", import.meta.url));
		writeFileSync(
			runner,
			`import { run } from ${JSON.stringify(localRelease)};
run(process.execPath, [${JSON.stringify(probe)}], { capture: true });
`,
		);
		const result = spawnSync(process.execPath, [runner], {
			encoding: "utf8",
			env: poisonedEnv({
				npm_config_cache: "/tmp/keep-cache",
				SHUVPI_PROBE_OUT: outPath,
			}),
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.deepEqual(JSON.parse(readFileSync(outPath, "utf8")), {
			lower: null,
			upper: null,
			cache: "/tmp/keep-cache",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// #233: the isolated project install is spawned by coding-agent-consumer, not local-release's run().
test("coding-agent consumer install does not inherit allow-scripts", () => {
	const root = mkdtempSync(join(tmpdir(), "shuvpi-allow-scripts-install-"));
	const logPath = join(root, "npm-env.json");
	const bin = join(root, "bin");
	try {
		mkdirSync(bin);
		const record = join(bin, "record.mjs");
		writeFileSync(
			record,
			`import { writeFileSync } from "node:fs";
writeFileSync(process.env.SHUVPI_FAKE_NPM_LOG, JSON.stringify({
	lower: process.env.npm_config_allow_scripts ?? null,
	upper: process.env.NPM_CONFIG_ALLOW_SCRIPTS ?? null,
	args: process.argv.slice(2),
}));
`,
		);
		if (process.platform === "win32") {
			writeFileSync(
				join(bin, "npm.cmd"),
				`@echo off\r\n"${process.execPath}" "${record}" %*\r\n`,
			);
		} else {
			writeFileSync(join(bin, "npm"), `#!/bin/sh\nexec "${process.execPath}" "${record}" "$@"\n`);
			chmodSync(join(bin, "npm"), 0o755);
		}
		const runner = join(root, "runner.mjs");
		const consumer = fileURLToPath(new URL("./coding-agent-consumer.mjs", import.meta.url));
		writeFileSync(
			runner,
			`import { installCodingAgentConsumer } from ${JSON.stringify(consumer)};
installCodingAgentConsumer(${JSON.stringify(join(root, "consumer"))}, new Map([
	[${JSON.stringify(codingAgentName)}, ${JSON.stringify(join(root, "coding-agent.tgz"))}],
]));
`,
		);
		const result = spawnSync(process.execPath, [runner], {
			encoding: "utf8",
			env: poisonedEnv({
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				SHUVPI_FAKE_NPM_LOG: logPath,
			}),
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const seen = JSON.parse(readFileSync(logPath, "utf8"));
		assert.equal(seen.lower, null);
		assert.equal(seen.upper, null);
		assert.equal(seen.args[0], "install");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
