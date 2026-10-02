import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { buildDiscordReleaseMessage, normalizeVersion, notifyDiscordRelease } from "./notify-discord-release.mjs";

test("Discord message contains only release version and fork links", () => {
	assert.deepEqual(normalizeVersion("v1.0.0"), { semver: "1.0.0", tag: "v1.0.0" });
	for (const version of ["", "1.0", "1.0.0-beta", "01.0.0"]) assert.throws(() => normalizeVersion(version));
	assert.equal(buildDiscordReleaseMessage({ version: "1.0.0" }), "**shuvpi v1.0.0** is out\nnpm: https://www.npmjs.com/package/@shuv1337/shuvpi-coding-agent/v/1.0.0\ntag: https://github.com/shuv1337/shuvpi/tree/v1.0.0");
});

test("missing webhook skips and CLI dry run never exposes the environment credential", async () => {
	const result = await notifyDiscordRelease({ version: "1.0.0", webhookUrl: "", fetchImpl: () => { throw new Error("Must not fetch"); } });
	assert.equal(result.skipped, true);
	const cli = spawnSync(process.execPath, ["scripts/notify-discord-release.mjs", "1.0.0", "--dry-run"], { encoding: "utf8", env: { PATH: process.env.PATH, DISCORD_RELEASE_WEBHOOK_URL: "secret-fixture-only" } });
	assert.equal(cli.status, 0, cli.stderr);
	assert.deepEqual(JSON.parse(cli.stdout), { content: buildDiscordReleaseMessage({ version: "1.0.0" }) });
	assert.doesNotMatch(cli.stdout + cli.stderr, /secret-fixture-only/);
});

test("mock HTTP endpoint receives one JSON post and rate limits are not retried", async (t) => {
	const requests = [];
	let status = 204;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push({ method: request.method, type: request.headers["content-type"], body: JSON.parse(body) });
		response.writeHead(status).end("fixture body is not logged");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	const webhookUrl = `http://127.0.0.1:${server.address().port}/webhook-fixture-secret`;
	await notifyDiscordRelease({ version: "1.0.0", webhookUrl });
	assert.deepEqual(requests, [{ method: "POST", type: "application/json", body: { content: buildDiscordReleaseMessage({ version: "1.0.0" }) } }]);
	status = 429;
	await assert.rejects(notifyDiscordRelease({ version: "1.0.0", webhookUrl }), /^Error: Discord webhook failed: HTTP 429$/);
	assert.equal(requests.length, 2);
});

test("network failures redact URL-bearing causes", async () => {
	await assert.rejects(notifyDiscordRelease({ version: "1.0.0", webhookUrl: "secret-fixture-url", fetchImpl: () => { throw new Error("connect failed secret-fixture-url"); } }), /^Error: Discord webhook request failed$/);
});
