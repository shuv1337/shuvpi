import { spawnSync } from "node:child_process";

/**
 * Trusted publisher for `.github/workflows/build-binaries.yml` job `publish-npm`.
 * npm can attach this only after the package exists, so OIDC cannot bootstrap it.
 * Papercut pc_e7c7d6c0c39b (#237).
 */
export const RELEASE_TRUSTED_PUBLISHER = {
	repository: "shuv1337/shuvpi",
	workflowFile: "build-binaries.yml",
	environment: "npm-publish",
};

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

function listedPackages(value) {
	return (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

export function classifyNpmViewResult({ status, stdout, stderr, errorMessage }) {
	const out = typeof stdout === "string" ? stdout : "";
	if (status === 0 && out.trim()) {
		return { kind: "registered" };
	}

	const output = [out, stderr, errorMessage]
		.filter((part) => typeof part === "string" && part.length > 0)
		.join("\n");
	if (output.includes("E404") || output.includes("404 Not Found")) {
		return { kind: "unregistered" };
	}

	return { kind: "error", output };
}

export function queryNpmViewVersion(packageName, spawnImpl = spawnSync) {
	const command = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnImpl(command, ["view", packageName, "version", "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return classifyNpmViewResult({
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		errorMessage: result.error?.message,
	});
}

export function npmViewError(packageName, registration) {
	const output = registration.output ?? "";
	return new Error(
		output
			? `Failed to query npm registration for ${packageName}\n${output}`
			: `Failed to query npm registration for ${packageName}`,
	);
}

export function bootstrapInstructions() {
	const publisher = RELEASE_TRUSTED_PUBLISHER;
	return [
		"Trusted publishing cannot create an npm package. The package must already exist before a trusted publisher can be attached, and CI OIDC cannot do that first publish.",
		"Bootstrap each package before it is included in a release:",
		"1. Build it, then from that package directory publish it once with an npm account that can publish the scope (not GitHub Actions OIDC):",
		"   npm publish --access public --ignore-scripts",
		"2. Configure the GitHub Actions trusted publisher and allow publish:",
		`   repository: ${publisher.repository}`,
		`   workflow file: ${publisher.workflowFile}`,
		`   environment: ${publisher.environment}`,
		`   npm trust github <name> --repo ${publisher.repository} --file ${publisher.workflowFile} --env ${publisher.environment} --allow-publish`,
		"   `npm trust` requires npm 11.15 or newer and account 2FA. The package must already exist.",
		"3. Confirm bootstrap: `npm view <name> version` prints a version.",
		"SHUVPI_RELEASE_ALLOW_NEW_PACKAGES does not skip this check. Allow a package into a release only after that confirmation succeeds.",
	].join("\n");
}

export function formatUnregisteredPackageError(unregisteredPackages, allowlistValue) {
	const lines = [
		"The following public workspace packages are not registered on npm:",
		...unregisteredPackages.map((packageName) => `  ${packageName}`),
		"",
		bootstrapInstructions(),
	];
	const ignored = listedPackages(allowlistValue).filter((packageName) => unregisteredPackages.includes(packageName));
	if (ignored.length > 0) {
		lines.push("");
		lines.push(
			`SHUVPI_RELEASE_ALLOW_NEW_PACKAGES listed ${ignored.join(", ")} and was ignored because those packages are still unregistered.`,
		);
	}
	return lines.join("\n");
}

export function escapeNpmPackageName(name) {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("Package name is required");
	}
	return name.replace("/", "%2f");
}

export function oidcPreflightMode(env) {
	if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
		return "exchange";
	}
	if (env.GITHUB_ACTIONS === "true") {
		return "missing";
	}
	return "skip";
}

async function readJsonBody(response) {
	const text = await response.text();
	if (!text) {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export async function exchangeNpmOidcToken({
	packageName,
	registry = DEFAULT_REGISTRY,
	env,
	fetchImpl,
}) {
	if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
		throw new Error(`GitHub Actions OIDC credentials are missing for ${packageName}. No release packages were published.`);
	}
	if (typeof fetchImpl !== "function") {
		throw new Error(`OIDC preflight has no fetch implementation for ${packageName}. No release packages were published.`);
	}

	const audience = `npm:${new URL(registry).hostname}`;
	const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
	url.searchParams.append("audience", audience);

	let idResponse;
	try {
		idResponse = await fetchImpl(url, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to fetch a GitHub OIDC token for ${packageName}: ${message}. No release packages were published.`);
	}

	const idBody = await readJsonBody(idResponse);
	if (!idResponse.ok || !idBody || typeof idBody.value !== "string" || idBody.value.length === 0) {
		throw new Error(
			`Failed to fetch a GitHub OIDC token for ${packageName}: HTTP ${idResponse.status}. No release packages were published.`,
		);
	}

	const exchangeUrl = new URL(`/-/npm/v1/oidc/token/exchange/package/${escapeNpmPackageName(packageName)}`, registry);
	let exchangeResponse;
	try {
		exchangeResponse = await fetchImpl(exchangeUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${idBody.value}`,
			},
			body: "",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Trusted publisher preflight failed for ${packageName}: ${message}. No release packages were published.`);
	}

	const exchangeBody = await readJsonBody(exchangeResponse);
	const exchangeMessage =
		exchangeBody && typeof exchangeBody.message === "string" && exchangeBody.message.length > 0
			? exchangeBody.message
			: `HTTP ${exchangeResponse.status}`;
	if (!exchangeResponse.ok || !exchangeBody || typeof exchangeBody.token !== "string" || exchangeBody.token.length === 0) {
		const publisher = RELEASE_TRUSTED_PUBLISHER;
		throw new Error(
			`Trusted publisher preflight failed for ${packageName}: ${exchangeMessage}. No release packages were published. ` +
				`Bootstrap it with a manual publish and \`npm trust github ${packageName} --repo ${publisher.repository} --file ${publisher.workflowFile} --env ${publisher.environment} --allow-publish\` before retrying.`,
		);
	}
}

export async function preflightNpmPublish({
	packageNames,
	env,
	fetchImpl,
	viewPackage,
	registry = DEFAULT_REGISTRY,
	log = console.log,
}) {
	if (packageNames.length === 0) {
		return;
	}

	const unregistered = [];
	for (const packageName of packageNames) {
		const kind = await viewPackage(packageName);
		switch (kind) {
			case "registered":
				log(`  ${packageName} is registered on npm`);
				break;
			case "unregistered":
				unregistered.push(packageName);
				break;
			default: {
				const unexpected = kind;
				throw new Error(`Unexpected npm registration result for ${packageName}: ${unexpected}`);
			}
		}
	}

	if (unregistered.length > 0) {
		throw new Error(formatUnregisteredPackageError(unregistered, env.SHUVPI_RELEASE_ALLOW_NEW_PACKAGES));
	}

	const mode = oidcPreflightMode(env);
	switch (mode) {
		case "skip":
			log("  Trusted-publisher OIDC preflight skipped (not running in GitHub Actions).");
			return;
		case "missing":
			throw new Error(
				"GitHub Actions is publishing without an OIDC request token. The publish-npm job needs id-token: write (ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN). No release packages were published.",
			);
		case "exchange":
			break;
		default: {
			const unexpected = mode;
			throw new Error(`Unknown OIDC preflight mode: ${unexpected}`);
		}
	}

	for (const packageName of packageNames) {
		await exchangeNpmOidcToken({ packageName, registry, env, fetchImpl });
		log(`  OIDC trusted-publisher exchange succeeded for ${packageName}`);
	}
}

export async function publishAfterPreflight(options) {
	const { packageNames, dryRun = false, publishPackage, log = console.log } = options;
	if (packageNames.length === 0) {
		log("All release packages are already published at this version.");
		return;
	}

	log(
		`Preflight: checking ${packageNames.length} unpublished package${packageNames.length === 1 ? "" : "s"} before publishing any of them.`,
	);
	await preflightNpmPublish(options);
	if (dryRun) {
		log("Dry run: preflight finished; no packages were published.");
		return;
	}

	for (const packageName of packageNames) {
		await publishPackage(packageName);
	}
}
