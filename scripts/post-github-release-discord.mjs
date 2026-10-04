#!/usr/bin/env node

// Release-workflow Discord embed. Replaces SethCohen/github-releases-to-discord:
// v1.20.0 is that repo's latest commit and still declares runs.using node16.

import { pathToFileURL } from "node:url";

const DEFAULT_USERNAME = "shuvpi releases";
const EMBED_COLOR = 2105893;
const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4096;
const EMBED_LIMIT = 6000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_SECONDS = 60;

function placeholder(index) {
	return `\u0000L${index}\u0000`;
}

function protectMarkdownLinks(text) {
	const links = [];
	const protectedText = text.replace(/\[.*?\]\(.*?\)/g, (link) => {
		const index = links.length;
		links.push(link);
		return placeholder(index);
	});
	return { protectedText, links };
}

function restoreMarkdownLinks(text, links) {
	return text.replace(/\u0000L(\d+)\u0000/g, (_match, index) => links[Number(index)] ?? "");
}

function linkMentions(text) {
	return text.replace(
		/(?<![/@\w])@((?!-)(?!.*?--)[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,37})(?![.\w/-])/g,
		(_match, name) => `[@${name}](https://github.com/${name})`,
	);
}

function linkBareGithubUrls(text) {
	return text
		.replace(
			/https:\/\/github\.com\/([\w-]+)\/([\w-]+)\/pull\/(\d+)/g,
			(match, _owner, _repo, number) => `[PR #${number}](${match})`,
		)
		.replace(
			/https:\/\/github\.com\/([\w-]+)\/([\w-]+)\/issues\/(\d+)/g,
			(match, _owner, _repo, number) => `[Issue #${number}](${match})`,
		)
		.replace(
			/https:\/\/github\.com\/([\w-]+)\/([\w-]+)\/compare\/([v\w.-]+)\.\.\.([v\w.-]+)/g,
			(match, _owner, _repo, fromVersion, toVersion) => `[${fromVersion}...${toVersion}](${match})`,
		);
}

function reduceHeadings(text) {
	return text
		.split("\n")
		.map((line) => {
			const heading3 = line.match(/^\s*###\s+(.+?)\s*#*\s*$/);
			if (heading3) return `**__${heading3[1].trim()}__**`;
			const heading2 = line.match(/^\s*##\s+(.+?)\s*#*\s*$/);
			if (heading2) return `**${heading2[1].trim()}**`;
			return line;
		})
		.join("\n");
}

function clipText(value, maxLength) {
	if (value.length <= maxLength) return value;
	const marker = "…";
	let clipped = value.slice(0, Math.max(0, maxLength - marker.length));
	const boundary = clipped.search(/\s+\S*$/);
	if (boundary > 0) clipped = clipped.slice(0, boundary);
	return `${clipped}${marker}`;
}

export function formatGithubReleaseNotes(body) {
	let text = String(body ?? "").replace(/\r/g, "");
	text = text.replace(/<!--.*?-->/gs, "");
	text = text.replace(/\n\s*\n/g, (whitespace) => {
		const newlineCount = (whitespace.match(/\n/g) ?? []).length;
		return newlineCount >= 2 ? "\n\n" : "\n";
	});

	const protectedLinks = protectMarkdownLinks(text);
	text = linkMentions(protectedLinks.protectedText);
	text = linkBareGithubUrls(text);
	text = restoreMarkdownLinks(text, protectedLinks.links);
	return reduceHeadings(text.trim());
}

function webhookEndpoint(webhookUrl) {
	return webhookUrl.includes("?") ? `${webhookUrl}&wait=true` : `${webhookUrl}?wait=true`;
}

function retryAfterSeconds(response) {
	const header = response.headers?.get?.("retry-after");
	const seconds = Number(header);
	if (!Number.isFinite(seconds) || seconds < 0) return 1;
	return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

export function buildGithubReleaseEmbed({ name, body, url, username = DEFAULT_USERNAME } = {}) {
	const title = clipText(String(name ?? "").trim(), TITLE_LIMIT);
	const descriptionLimit = Math.min(DESCRIPTION_LIMIT, EMBED_LIMIT - title.length);
	const embed = {
		title,
		description: clipText(formatGithubReleaseNotes(body), descriptionLimit),
		color: EMBED_COLOR,
	};
	const releaseUrl = String(url ?? "").trim();
	if (releaseUrl) embed.url = releaseUrl;
	return {
		username: String(username ?? "").trim() || DEFAULT_USERNAME,
		embeds: [embed],
	};
}

export async function postGithubReleaseEmbed({
	webhookUrl,
	name,
	body,
	url,
	username,
	fetchImpl = globalThis.fetch,
	sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
	const resolvedWebhookUrl = String(webhookUrl ?? "").trim();
	if (!resolvedWebhookUrl) throw new Error("DISCORD_RELEASE_WEBHOOK_URL is not set");
	if (!String(name ?? "").trim()) throw new Error("release name is required");
	if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

	const payload = buildGithubReleaseEmbed({ name, body, url, username });
	for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
		const response = await fetchImpl(webhookEndpoint(resolvedWebhookUrl), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
			await sleepImpl(retryAfterSeconds(response) * 1000);
			continue;
		}
		if (!response.ok) {
			const responseBody = typeof response.text === "function" ? await response.text() : "";
			throw new Error(
				`Discord webhook failed: ${response.status}${responseBody ? ` ${responseBody}` : ""}`,
			);
		}
		return payload;
	}
}

async function main() {
	const payload = await postGithubReleaseEmbed({
		webhookUrl: process.env.DISCORD_RELEASE_WEBHOOK_URL,
		name: process.env.DISCORD_RELEASE_NAME,
		body: process.env.DISCORD_RELEASE_BODY,
		url: process.env.DISCORD_RELEASE_URL,
		username: process.env.DISCORD_RELEASE_USERNAME,
	});
	console.log(`Posted Discord release notes: ${payload.embeds[0].title}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
