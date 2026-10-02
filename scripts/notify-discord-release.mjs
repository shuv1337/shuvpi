#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PACKAGE, RELEASE_REPOSITORY } from "./release-target.mjs";

export function normalizeVersion(version) {
	const value = String(version ?? "").trim();
	if (!value) throw new Error("version is required");
	const semver = value.replace(/^v/, "");
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(semver)) throw new Error(`Invalid release version: ${value}`);
	return { semver, tag: `v${semver}` };
}

export function buildDiscordReleaseMessage({ version, repo = RELEASE_REPOSITORY, packageName = RELEASE_PACKAGE } = {}) {
	const { semver, tag } = normalizeVersion(version);
	return [
		`**shuvpi ${tag}** is out`,
		`npm: https://www.npmjs.com/package/${packageName}/v/${semver}`,
		`tag: https://github.com/${repo}/tree/${tag}`,
	].join("\n");
}

export async function notifyDiscordRelease({ version, webhookUrl = process.env.DISCORD_RELEASE_WEBHOOK_URL, fetchImpl = globalThis.fetch } = {}) {
	if (!webhookUrl) return { skipped: true, reason: "DISCORD_RELEASE_WEBHOOK_URL is not set" };
	const content = buildDiscordReleaseMessage({ version });
	let response;
	try {
		response = await fetchImpl(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		// Fetch errors can embed the credential-bearing URL. Never pass them to logs.
		throw new Error("Discord webhook request failed");
	}
	if (!response.ok) throw new Error(`Discord webhook failed: HTTP ${response.status}`);
	return { skipped: false, content };
}

async function main(args) {
	const dryRun = args.includes("--dry-run");
	const values = args.filter((arg) => arg !== "--dry-run");
	if (values.length !== 1) throw new Error("Usage: node scripts/notify-discord-release.mjs <x.y.z|vX.Y.Z> [--dry-run]");
	if (dryRun) {
		console.log(JSON.stringify({ content: buildDiscordReleaseMessage({ version: values[0] }) }));
		return;
	}
	const result = await notifyDiscordRelease({ version: values[0] });
	console.log(result.skipped ? `Discord announcement skipped: ${result.reason}` : "Posted Discord release announcement");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : "Discord release announcement failed");
		process.exitCode = 1;
	});
}
