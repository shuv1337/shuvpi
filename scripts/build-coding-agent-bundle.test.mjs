import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const googleAntigravityBundle = fileURLToPath(
	new URL("../packages/coding-agent/dist/bundle/chunks/google-antigravity.js", import.meta.url),
);

test("bundles the Google Antigravity OAuth implementation beside its lazy loader", async () => {
	await access(googleAntigravityBundle);
	const module = await import(pathToFileURL(googleAntigravityBundle).href);
	assert.equal(typeof module.googleAntigravityOAuth?.refresh, "function");
});
