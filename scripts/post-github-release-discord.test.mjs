import assert from "node:assert/strict";
import test from "node:test";
import {
	buildGithubReleaseEmbed,
	formatGithubReleaseNotes,
	postGithubReleaseEmbed,
} from "./post-github-release-discord.mjs";

test("formatGithubReleaseNotes matches the release-action defaults", () => {
	const notes = [
		"## Added",
		"",
		"See https://github.com/shuv1337/shuvpi/pull/240 and thanks @shuv1337 for the release.",
		"Keep [PR #1](https://github.com/shuv1337/shuvpi/pull/1) and dev@example.com.",
		"Package @shuv1337/shuvpi-coding-agent stays plain.",
		"Issue https://github.com/shuv1337/shuvpi/issues/12",
		"Compare https://github.com/shuv1337/shuvpi/compare/v1.0.0...v1.1.0",
		"",
		"<!-- generated -->",
		"",
		"### Fixed  ",
		"",
	].join("\n");

	assert.equal(
		formatGithubReleaseNotes(notes.replace("\n", "\r\n")),
		[
			"**Added**",
			"",
			"See [PR #240](https://github.com/shuv1337/shuvpi/pull/240) and thanks [@shuv1337](https://github.com/shuv1337) for the release.",
			"Keep [PR #1](https://github.com/shuv1337/shuvpi/pull/1) and dev@example.com.",
			"Package @shuv1337/shuvpi-coding-agent stays plain.",
			"Issue [Issue #12](https://github.com/shuv1337/shuvpi/issues/12)",
			"Compare [v1.0.0...v1.1.0](https://github.com/shuv1337/shuvpi/compare/v1.0.0...v1.1.0)",
			"",
			"**__Fixed__**",
		].join("\n"),
	);
});

test("buildGithubReleaseEmbed clips the title and description and sets the default color", () => {
	const payload = buildGithubReleaseEmbed({
		name: `v1 ${"title ".repeat(50)}`,
		body: "word ".repeat(2000),
		url: " https://github.com/shuv1337/shuvpi/releases/tag/v1.2.3 ",
		username: " ",
	});

	assert.equal(payload.username, "shuvpi releases");
	assert.equal(payload.embeds[0].color, 2105893);
	assert.equal(payload.embeds[0].url, "https://github.com/shuv1337/shuvpi/releases/tag/v1.2.3");
	assert.ok(payload.embeds[0].title.length <= 256);
	assert.ok(payload.embeds[0].title.endsWith("…"));
	assert.ok(payload.embeds[0].description.length <= 4096);
	assert.ok(payload.embeds[0].description.endsWith("…"));
});

test("postGithubReleaseEmbed posts the embed and retries a Discord rate limit", async () => {
	const calls = [];
	const sleeps = [];
	const payload = await postGithubReleaseEmbed({
		webhookUrl: "https://discord.test/api/webhooks/1/token",
		name: "v1.2.3",
		body: "## Added\n\nNotes",
		url: "https://github.com/shuv1337/shuvpi/releases/tag/v1.2.3",
		username: "shuvpi releases",
		sleepImpl: async (milliseconds) => {
			sleeps.push(milliseconds);
		},
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			if (calls.length === 1) {
				return { ok: false, status: 429, headers: { get: () => "2" }, text: async () => "" };
			}
			return { ok: true, status: 200, text: async () => "" };
		},
	});

	assert.equal(sleeps.length, 1);
	assert.equal(sleeps[0], 2000);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, "https://discord.test/api/webhooks/1/token?wait=true");
	assert.equal(calls[0].options.method, "POST");
	assert.deepEqual(JSON.parse(calls[1].options.body), payload);
	assert.equal(payload.embeds[0].title, "v1.2.3");
	assert.equal(payload.embeds[0].description, "**Added**\n\nNotes");
});

test("postGithubReleaseEmbed requires a webhook and a release name", async () => {
	await assert.rejects(
		() => postGithubReleaseEmbed({ webhookUrl: "", name: "v1.2.3", fetchImpl: async () => ({}) }),
		/DISCORD_RELEASE_WEBHOOK_URL is not set/,
	);
	await assert.rejects(
		() =>
			postGithubReleaseEmbed({
				webhookUrl: "https://discord.test/api/webhooks/1/token",
				name: " ",
				fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
			}),
		/release name is required/,
	);
});

test("postGithubReleaseEmbed throws the Discord status on a failed post", async () => {
	await assert.rejects(
		() =>
			postGithubReleaseEmbed({
				webhookUrl: "https://discord.test/api/webhooks/1/token?thread_id=1",
				name: "v1.2.3",
				fetchImpl: async (url) => {
					assert.equal(url, "https://discord.test/api/webhooks/1/token?thread_id=1&wait=true");
					return { ok: false, status: 401, text: async () => "unauthorized" };
				},
			}),
		/Discord webhook failed: 401 unauthorized/,
	);
});
