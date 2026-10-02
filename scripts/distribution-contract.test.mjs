import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const repository = "shuv1337/shuvpi";
const workflowSource = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const workflow = parse(workflowSource);
const selectedPackages = ["ai", "agent-core", "coding-agent"].map((name) => ({
	name: `@shuv1337/shuvpi-${name}`,
	version: "1.0.0",
}));

function requiredStep(job, command) {
	const matches = job.steps.filter((step) => step.run === command);
	assert.equal(matches.length, 1, `Expected exactly one step running ${command}`);
	const step = matches[0];
	assert.equal(step.if, undefined, `${command} must not be conditionally skipped`);
	assert.notEqual(step["continue-on-error"], true, `${command} must block publication on failure`);
	return job.steps.indexOf(step);
}

function fixture(t, { packages = selectedPackages, notes = "# Reviewed Shuvpi 1.0.0 fixture notes\n" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "shuvpi-distribution-contract-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "scripts"));
	for (const name of ["release-target.mjs", "check-release-target.mjs", "release.mjs"]) {
		copyFileSync(new URL(name, import.meta.url), join(root, "scripts", name));
	}
	writeFileSync(join(root, "selected-packages.json"), JSON.stringify(packages));
	writeFileSync(join(root, "scripts/release-packages.mjs"), `import { readFileSync } from "node:fs";
export function getReleasePackages() { return JSON.parse(readFileSync("selected-packages.json", "utf8")); }
export const getPublicWorkspacePackages = getReleasePackages;
`);
	writeFileSync(join(root, "scripts/package-workspaces.mjs"), "export function findPackageDirectories() { return []; }\n");
	if (notes !== null) {
		mkdirSync(join(root, "release-notes"));
		writeFileSync(join(root, "release-notes/1.0.0.md"), notes);
	}
	const callsPath = join(root, "commands.jsonl");
	writeFileSync(callsPath, "");
	const preload = join(root, "deny-commands.mjs");
	writeFileSync(preload, `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
 childProcess[method] = (command, args) => {
  appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ method, command, args }) + "\\n");
  throw new Error("Fixture blocked external command: " + command);
 };
}
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("Fixture blocked network access"); };
`);
	return {
		run({ script = "check-release-target.mjs", args = [], tag = "v1.0.0", repo = repository } = {}) {
			const env = { FIXTURE_CALLS: callsPath };
			if (tag !== null) env.RELEASE_TAG = tag;
			if (repo !== null) env.GITHUB_REPOSITORY = repo;
			return spawnSync(process.execPath, ["--import", preload, `scripts/${script}`, ...args], {
				cwd: root,
				encoding: "utf8",
				env,
			});
		},
		calls() {
			return readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		},
	};
}

test("only the fork tag workflow can publish with npm OIDC after mandatory validation", () => {
	assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
	assert.deepEqual(workflow.on.push, { tags: ["v*"] });
	assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
	assert.equal(workflow.on.workflow_dispatch.inputs.tag.type, "string");
	assert.deepEqual(workflow.permissions, {});
	assert.equal(workflow.concurrency["cancel-in-progress"], false);
	assert.deepEqual(Object.keys(workflow.jobs).sort(), ["notify-discord", "publish-github-release", "publish-npm"]);

	const job = workflow.jobs["publish-npm"];
	assert.equal(job.if, `github.repository == '${repository}'`);
	assert.equal(job.environment, "npm-publish");
	assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" });
	assert.notEqual(job["continue-on-error"], true);
	assert.equal(job.env.RELEASE_TAG, "${{ github.event.inputs.tag || github.ref_name }}");
	assert.equal(job.env.SOURCE_REF, "${{ github.event.inputs.source_ref || github.event.inputs.tag || github.ref_name }}");
	const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
	assert.equal(checkout.with.ref, "${{ env.SOURCE_REF }}");
	assert.equal(checkout.with["persist-credentials"], false);
	const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
	assert.equal(setup.with["registry-url"], "https://registry.npmjs.org");

	const guard = requiredStep(job, "node scripts/check-release-target.mjs");
	const install = requiredStep(job, "npm ci --ignore-scripts");
	const publish = requiredStep(job, "node scripts/publish.mjs");
	assert.ok(guard < install, "Reject the wrong release identity before installing packages");
	for (const command of ["node scripts/build-release-packages.mjs", "npm run check", "./test.sh", "npm run check:package-install"]) {
		assert.ok(requiredStep(job, command) < publish, `${command} must succeed before publication`);
	}
	assert.ok(requiredStep(job, "npm install -g npm@11.16.0 --ignore-scripts") < publish);
	assert.doesNotMatch(JSON.stringify(job), /NODE_AUTH_TOKEN|NPM_TOKEN|npm login|npm adduser/);
});

test("GitHub release requires npm success and produces the announcement creation flag", () => {
	const job = workflow.jobs["publish-github-release"];
	assert.equal(job.needs, "publish-npm");
	assert.equal(job.if, undefined, "Use the default dependency-success gate");
	assert.notEqual(job["continue-on-error"], true);
	assert.deepEqual(job.permissions, { contents: "write" });
	assert.equal(job.env.GH_REPO, "${{ github.repository }}");
	assert.equal(job.env.RELEASE_TAG, workflow.jobs["publish-npm"].env.RELEASE_TAG);
	assert.equal(job.env.SOURCE_REF, workflow.jobs["publish-npm"].env.SOURCE_REF);
	assert.equal(job.outputs.created, "${{ steps.release.outputs.created }}");
	const release = job.steps.find((step) => step.id === "release");
	assert.equal(release.if, undefined);
	assert.notEqual(release["continue-on-error"], true);
	assert.match(release.run, /^set -euo pipefail\n/);
	assert.match(release.run, /^node scripts\/check-release-target\.mjs$/m);
	assert.ok(release.run.indexOf("node scripts/check-release-target.mjs") < release.run.indexOf("gh release create"));
	assert.match(release.run, /if \[ "\$version" = '1\.0\.0' \]; then\s+cp release-notes\/1\.0\.0\.md "\$notes_file"/);
	assert.match(release.run, /if gh release view "\$RELEASE_TAG"[^\n]*; then\s+echo 'created=false' >> "\$GITHUB_OUTPUT"\s+else\s+gh release create "\$RELEASE_TAG" --verify-tag[^\n]*--notes-file "\$notes_file"[^\n]*\n\s+echo 'created=true' >> "\$GITHUB_OUTPUT"\s+fi/);
});

test("Discord runs only for a newly created release and its failure cannot fail the release", () => {
	const job = workflow.jobs["notify-discord"];
	assert.equal(job.needs, "publish-github-release");
	assert.equal(job.if, "needs.publish-github-release.outputs.created == 'true'");
	assert.equal(job["continue-on-error"], true);
	assert.deepEqual(job.permissions, { contents: "read" });
	assert.equal(job.env.RELEASE_TAG, workflow.jobs["publish-npm"].env.RELEASE_TAG);
	assert.equal(job.env.SOURCE_REF, workflow.jobs["publish-npm"].env.SOURCE_REF);
	const announce = job.steps[requiredStep(job, 'node scripts/notify-discord-release.mjs "$RELEASE_TAG"')];
	assert.deepEqual(announce.env, { DISCORD_RELEASE_WEBHOOK_URL: "${{ secrets.DISCORD_RELEASE_WEBHOOK_URL }}" });
});

test("active distribution entrypoints contain no upstream website or R2 publication destination", () => {
	const activeSources = [
		workflowSource,
		...["release-target.mjs", "check-release-target.mjs", "release.mjs", "publish.mjs", "notify-discord-release.mjs", "build-binaries.sh"]
			.map((name) => readFileSync(new URL(name, import.meta.url), "utf8")),
	];
	for (const source of activeSources) {
		assert.doesNotMatch(source, /pi\.dev|earendil-works\/pi|@earendil-works|\bR2_|\bCLOUDFLARE_|\bwrangler\b|announce-pi-dev-release/i);
	}
});

test("local builder retains all six platform targets and archives named for the selected CLI", () => {
	const source = readFileSync(new URL("build-binaries.sh", import.meta.url), "utf8");
	const platforms = source.match(/^\s*PLATFORMS=\((darwin[^\n]+)\)$/m);
	assert.ok(platforms, "The default build must retain an explicit complete platform list");
	assert.deepEqual(platforms[1].split(/\s+/), ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"]);
	assert.match(source, /CLI_NAME=\$\(node -p '[^\n]+coding-agent\/package\.json[^\n]+\.bin/);
	assert.match(source, /bun_target="bun-\$platform"/);
	assert.match(source, /--target="\$bun_target"/);
	assert.match(source, /\$CLI_NAME-\$platform\.tar\.gz/);
	assert.match(source, /\$CLI_NAME-\$platform\.zip/);
	assert.doesNotMatch(source, /\b(?:npm publish|gh release create|curl|wget|wrangler)\b/);
});

test("target guard accepts the exact selected fork closure, version, tag and repository without subprocesses", (t) => {
	const harness = fixture(t);
	const result = harness.run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Verified Shuvpi release target v1\.0\.0/);
	assert.deepEqual(harness.calls(), []);
});

test("target guard rejects missing CLI, other package scopes, non-lockstep versions, wrong tags and repositories", async (t) => {
	const scenarios = [
		{ name: "empty selection", packages: [], error: /dependency closure/ },
		{ name: "missing CLI", packages: selectedPackages.slice(0, -1), error: /dependency closure/ },
		{ name: "upstream dependency", packages: [{ name: "@earendil-works/pi-ai", version: "1.0.0" }, selectedPackages[2]], error: /dependency closure/ },
		{ name: "similar foreign scope", packages: [{ name: "@shuv1337-other/shuvpi-ai", version: "1.0.0" }, selectedPackages[2]], error: /dependency closure/ },
		{ name: "mixed versions", packages: [{ ...selectedPackages[0], version: "1.0.1" }, selectedPackages[2]], error: /not lockstep stable versions/ },
		...["1.0.0-preview.1", "01.0.0", "1.0", ""].map((version) => ({ name: `invalid version ${version}`, packages: selectedPackages.map((pkg) => ({ ...pkg, version })), error: /not lockstep stable versions/ })),
		{ name: "missing tag", run: { tag: null }, error: /RELEASE_TAG is required/ },
		{ name: "wrong version tag", run: { tag: "v1.0.1" }, error: /does not match package version/ },
		{ name: "unprefixed tag", run: { tag: "1.0.0" }, error: /does not match package version/ },
		{ name: "upstream repository", run: { repo: "earendil-works/pi" }, error: /Release repository must be shuv1337\/shuvpi/ },
		{ name: "other fork repository", run: { repo: "other/shuvpi" }, error: /Release repository must be shuv1337\/shuvpi/ },
	];
	for (const scenario of scenarios) {
		await t.test(scenario.name, (child) => {
			const harness = fixture(child, scenario);
			const result = harness.run(scenario.run);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, scenario.error);
			assert.deepEqual(harness.calls(), []);
		});
	}
});

test("initial CI and local release guards require nonempty reviewed 1.0.0 notes before external commands", (t) => {
	for (const notes of [null, "", " \n\t"]) {
		for (const script of ["check-release-target.mjs", "release.mjs"]) {
			const harness = fixture(t, { notes });
			const args = script === "release.mjs" ? ["1.0.0", "--initial", "--branch", "release/1.0"] : [];
			const result = harness.run({ script, args });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /Initial release requires reviewed.*release-notes\/1\.0\.0\.md/);
			assert.deepEqual(harness.calls(), []);
		}
	}
	const later = fixture(t, { packages: selectedPackages.map((pkg) => ({ ...pkg, version: "1.0.1" })), notes: null });
	const result = later.run({ tag: "v1.0.1" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(later.calls(), []);
});
