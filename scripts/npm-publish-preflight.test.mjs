import assert from "node:assert/strict";
import test from "node:test";
import {
	RELEASE_TRUSTED_PUBLISHER,
	classifyNpmViewResult,
	escapeNpmPackageName,
	exchangeNpmOidcToken,
	formatUnregisteredPackageError,
	oidcPreflightMode,
	publishAfterPreflight,
	queryNpmViewVersion,
} from "./npm-publish-preflight.mjs";

const registeredView = async () => "registered";

function githubEnv(overrides = {}) {
	return {
		ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.test/token?base=1",
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
		GITHUB_ACTIONS: "true",
		...overrides,
	};
}

function jsonResponse(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
	};
}

function successfulFetch() {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(String(url));
		if (String(url).includes("token.actions.githubusercontent.test")) {
			return jsonResponse(200, { value: "id-token" });
		}
		return jsonResponse(200, { token: "npm-token" });
	};
	return { calls, fetchImpl };
}

test("classifyNpmViewResult distinguishes registration from query failures", () => {
	assert.deepEqual(classifyNpmViewResult({ status: 0, stdout: '"1.2.3"\n' }), { kind: "registered" });
	assert.deepEqual(
		classifyNpmViewResult({ status: 1, stdout: "", stderr: "npm error code E404\n404 Not Found" }),
		{ kind: "unregistered" },
	);
	assert.equal(classifyNpmViewResult({ status: 1, stdout: "", stderr: "npm error code ECONNRESET" }).kind, "error");
});

test("queryNpmViewVersion passes the package name to npm view", () => {
	let seen = null;
	const registration = queryNpmViewVersion("@shuv1337/shuvpi-ai", (command, args, options) => {
		seen = { command, args, options };
		return { status: 0, stdout: '"0.87.1"\n', stderr: "" };
	});
	assert.equal(registration.kind, "registered");
	assert.equal(seen.command, "npm");
	assert.deepEqual(seen.args, ["view", "@shuv1337/shuvpi-ai", "version", "--json"]);
	assert.deepEqual(seen.options.stdio, ["ignore", "pipe", "pipe"]);
});

// #237
test("unregistered-package error documents bootstrap and ignores the allowlist", () => {
	const message = formatUnregisteredPackageError(
		["@shuv1337/shuvpi-protocol", "@shuv1337/shuvpi-session-backend-sqlite-node"],
		"@shuv1337/shuvpi-protocol, @shuv1337/other",
	);
	assert.match(message, /not registered on npm/);
	assert.match(message, /npm publish --access public --ignore-scripts/);
	assert.match(
		message,
		new RegExp(
			`npm trust github <name> --repo ${RELEASE_TRUSTED_PUBLISHER.repository} --file ${RELEASE_TRUSTED_PUBLISHER.workflowFile} --env ${RELEASE_TRUSTED_PUBLISHER.environment} --allow-publish`,
		),
	);
	assert.match(message, /only after that confirmation succeeds/);
	assert.match(message, /SHUVPI_RELEASE_ALLOW_NEW_PACKAGES listed @shuv1337\/shuvpi-protocol and was ignored/);
	assert.doesNotMatch(message, /will be created on first CI publish/);
	assert.doesNotMatch(message, /@shuv1337\/other/);
});

test("escapeNpmPackageName escapes the scope slash the way the npm registry expects", () => {
	assert.equal(escapeNpmPackageName("@shuv1337/shuvpi-ai"), "@shuv1337%2fshuvpi-ai");
	assert.equal(escapeNpmPackageName("left-pad"), "left-pad");
});

test("oidcPreflightMode exchanges only when GitHub provides an OIDC request token", () => {
	assert.equal(oidcPreflightMode({}), "skip");
	assert.equal(oidcPreflightMode({ GITHUB_ACTIONS: "true" }), "missing");
	assert.equal(
		oidcPreflightMode({
			GITHUB_ACTIONS: "true",
			ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/token",
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
		}),
		"exchange",
	);
});

// #237
test("publish preflight rejects an unregistered package before OIDC exchange or publish", async () => {
	const published = [];
	let fetched = false;
	await assert.rejects(
		() =>
			publishAfterPreflight({
				packageNames: ["@shuv1337/shuvpi-ai", "@shuv1337/shuvpi-protocol"],
				env: githubEnv({ SHUVPI_RELEASE_ALLOW_NEW_PACKAGES: "@shuv1337/shuvpi-protocol" }),
				fetchImpl: async () => {
					fetched = true;
					throw new Error("fetch should not be called");
				},
				viewPackage: async (packageName) => (packageName.endsWith("protocol") ? "unregistered" : "registered"),
				publishPackage: async (packageName) => {
					published.push(packageName);
				},
				log() {},
			}),
		/@shuv1337\/shuvpi-protocol[\s\S]*was ignored/,
	);
	assert.equal(fetched, false);
	assert.deepEqual(published, []);
});

// #237
test("publish preflight stops before publishing when a later trusted-publisher exchange fails", async () => {
	const published = [];
	const exchanged = [];
	await assert.rejects(
		() =>
			publishAfterPreflight({
				packageNames: ["@shuv1337/shuvpi-ai", "@shuv1337/shuvpi-protocol"],
				env: githubEnv(),
				fetchImpl: async (url) => {
					const href = String(url);
					if (href.includes("token.actions.githubusercontent.test")) {
						return jsonResponse(200, { value: "id-token" });
					}
					exchanged.push(href);
					if (href.includes("protocol")) {
						return jsonResponse(403, { message: "trusted publisher not configured" });
					}
					return jsonResponse(200, { token: "npm-token" });
				},
				viewPackage: registeredView,
				publishPackage: async (packageName) => {
					published.push(packageName);
				},
				log() {},
			}),
		/Trusted publisher preflight failed for @shuv1337\/shuvpi-protocol: trusted publisher not configured/,
	);
	assert.deepEqual(exchanged.map((href) => href.includes("protocol")), [false, true]);
	assert.deepEqual(published, []);
});

test("publish preflight publishes only after every pending package exchanges", async () => {
	const published = [];
	const { calls, fetchImpl } = successfulFetch();
	await publishAfterPreflight({
		packageNames: ["@shuv1337/shuvpi-ai", "@shuv1337/shuvpi-agent-core"],
		env: githubEnv(),
		fetchImpl,
		viewPackage: registeredView,
		publishPackage: async (packageName) => {
			published.push(packageName);
		},
		log() {},
	});
	assert.deepEqual(published, ["@shuv1337/shuvpi-ai", "@shuv1337/shuvpi-agent-core"]);
	assert.equal(calls.filter((href) => href.includes("oidc/token/exchange")).length, 2);
	assert.match(calls.find((href) => href.includes("exchange")), /@shuv1337%2fshuvpi-ai/);
});

test("dry run checks registration and does not publish", async () => {
	const published = [];
	await publishAfterPreflight({
		packageNames: ["@shuv1337/shuvpi-ai"],
		dryRun: true,
		env: {},
		viewPackage: registeredView,
		publishPackage: async (packageName) => {
			published.push(packageName);
		},
		log() {},
	});
	assert.deepEqual(published, []);
});

test("GitHub Actions without an OIDC request token publishes nothing", async () => {
	const published = [];
	await assert.rejects(
		() =>
			publishAfterPreflight({
				packageNames: ["@shuv1337/shuvpi-ai"],
				env: { GITHUB_ACTIONS: "true" },
				viewPackage: registeredView,
				publishPackage: async (packageName) => {
					published.push(packageName);
				},
				log() {},
			}),
		/id-token: write/,
	);
	assert.deepEqual(published, []);
});

test("local publishes skip OIDC exchange after registration succeeds", async () => {
	const published = [];
	let fetched = false;
	await publishAfterPreflight({
		packageNames: ["@shuv1337/shuvpi-ai"],
		env: {},
		fetchImpl: async () => {
			fetched = true;
			throw new Error("fetch should not be called");
		},
		viewPackage: registeredView,
		publishPackage: async (packageName) => {
			published.push(packageName);
		},
		log() {},
	});
	assert.equal(fetched, false);
	assert.deepEqual(published, ["@shuv1337/shuvpi-ai"]);
});

test("exchangeNpmOidcToken omits token values from failures", async () => {
	await assert.rejects(
		() =>
			exchangeNpmOidcToken({
				packageName: "@shuv1337/shuvpi-ai",
				env: githubEnv(),
				fetchImpl: async (url) => {
					if (String(url).includes("token.actions.githubusercontent.test")) {
						return jsonResponse(200, { value: "super-secret-id-token" });
					}
					return jsonResponse(401, { message: "unauthorized", token: "super-secret-npm-token" });
				},
			}),
		(error) => {
			assert.match(error.message, /unauthorized/);
			assert.doesNotMatch(error.message, /super-secret/);
			return true;
		},
	);
});
