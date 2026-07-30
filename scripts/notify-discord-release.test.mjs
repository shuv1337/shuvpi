import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDiscordReleaseMessage,
	normalizeVersion,
	notifyDiscordRelease,
} from "./notify-discord-release.mjs";

test("normalizeVersion accepts x.y.z and vX.Y.Z", () => {
	assert.deepEqual(normalizeVersion("1.2.3"), { semver: "1.2.3", tag: "v1.2.3" });
	assert.deepEqual(normalizeVersion("v1.2.3"), { semver: "1.2.3", tag: "v1.2.3" });
});

test("normalizeVersion rejects invalid versions", () => {
	assert.throws(() => normalizeVersion(""), /version is required/);
	assert.throws(() => normalizeVersion("1.2"), /invalid version/);
	assert.throws(() => normalizeVersion("v1.2.3-beta"), /invalid version/);
});

test("buildDiscordReleaseMessage is version + links only", () => {
	const content = buildDiscordReleaseMessage({ version: "0.82.1" });
	assert.equal(
		content,
		[
			"**shuvpi v0.82.1** is out",
			"npm: https://www.npmjs.com/package/@shuv1337/shuvpi-coding-agent/v/0.82.1",
			"tag: https://github.com/shuv1337/shuvpi/tree/v0.82.1",
		].join("\n"),
	);
});

test("notifyDiscordRelease skips when webhook is unset", async () => {
	const result = await notifyDiscordRelease({
		version: "1.0.0",
		webhookUrl: "",
		fetchImpl: async () => {
			throw new Error("fetch should not be called");
		},
	});
	assert.deepEqual(result, {
		skipped: true,
		reason: "DISCORD_RELEASE_WEBHOOK_URL is not set",
	});
});

test("notifyDiscordRelease posts JSON content to the webhook", async () => {
	const calls = [];
	const result = await notifyDiscordRelease({
		version: "v2.3.4",
		webhookUrl: "https://discord.test/api/webhooks/1/token",
		repo: "shuv1337/shuvpi",
		packageName: "@shuv1337/shuvpi-coding-agent",
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			return { ok: true, status: 204, text: async () => "" };
		},
	});

	assert.equal(result.skipped, false);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://discord.test/api/webhooks/1/token");
	assert.equal(calls[0].options.method, "POST");
	assert.equal(calls[0].options.headers["Content-Type"], "application/json");
	assert.deepEqual(JSON.parse(calls[0].options.body), {
		content: buildDiscordReleaseMessage({ version: "2.3.4" }),
	});
});

test("notifyDiscordRelease throws on non-OK webhook responses", async () => {
	await assert.rejects(
		() =>
			notifyDiscordRelease({
				version: "1.0.0",
				webhookUrl: "https://discord.test/api/webhooks/1/token",
				fetchImpl: async () => ({
					ok: false,
					status: 401,
					text: async () => "unauthorized",
				}),
			}),
		/Discord webhook failed: 401 unauthorized/,
	);
});
