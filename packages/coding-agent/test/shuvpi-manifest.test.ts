import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { readShuvpiManifest } from "../src/core/shuvpi-manifest.ts";
import { allowNetwork } from "./test-network-env.ts";

describe("shuvpi resource manifest", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "shuvpi-manifest-"));
		vi.stubEnv("HOME", root);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses only shuvpi resource fields and ignores malformed individual arrays", () => {
		const manifestPath = join(root, "package.json");
		writeFileSync(manifestPath, JSON.stringify({ pi: { extensions: ["legacy.ts"] } }));
		expect(readShuvpiManifest(manifestPath)).toBeNull();
		writeFileSync(
			manifestPath,
			JSON.stringify({
				pi: { extensions: ["legacy.ts"], themes: ["legacy.json"] },
				shuvpi: { extensions: ["current.ts"], skills: ["skills", 7], prompts: ["prompt.md"], themes: false },
			}),
		);
		expect(readShuvpiManifest(manifestPath)).toEqual({ extensions: ["current.ts"], prompts: ["prompt.md"] });
	});

	it("installs, loads, updates and removes all four resource kinds from a real npm tarball", async () => {
		allowNetwork(); // Only the wrapper's local registry replies are used; npm itself remains offline.
		const name = "@shuvpi-fixture/all-resources";
		const source = `npm:${name}`;
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const userconfig = join(root, "npmrc");
		writeFileSync(userconfig, "");
		const controlPath = join(root, "control.json");
		const log = join(root, "npm-operations.jsonl");
		const settingsManager = SettingsManager.inMemory({
			npmCommand: [
				process.execPath,
				fileURLToPath(new URL("./fixtures/local-package-npm.mjs", import.meta.url)),
				controlPath,
				"npm",
			],
		});
		const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
		const installedPath = join(agentDir, "npm", "node_modules", name);

		for (const generation of [1, 2]) {
			const version = `${generation}.0.0`;
			const label = `resource-v${generation}`;
			const packageDir = join(root, `package-v${generation}`);
			const assets = join(packageDir, "payload", label);
			mkdirSync(join(assets, "skill"), { recursive: true });
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({
					name,
					version,
					type: "module",
					shuvpi: {
						extensions: [`payload/${label}/extension.ts`],
						skills: [`payload/${label}/skill`],
						prompts: [`payload/${label}/${label}.md`],
						themes: [`payload/${label}/theme.json`],
					},
				}),
			);
			writeFileSync(
				join(assets, "extension.ts"),
				`export default function (api) { api.registerCommand("${label}", { handler: async () => {} }); }`,
			);
			writeFileSync(
				join(assets, "skill", "SKILL.md"),
				`---\nname: ${label}\ndescription: Packed fixture ${generation}\n---\nSkill ${generation}\n`,
			);
			writeFileSync(
				join(assets, `${label}.md`),
				`---\ndescription: Packed prompt ${generation}\n---\nPrompt ${generation}\n`,
			);
			const theme = JSON.parse(
				readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
			) as Record<string, unknown>;
			writeFileSync(join(assets, "theme.json"), JSON.stringify({ ...theme, name: label }));
			const packed = JSON.parse(
				execFileSync(
					"npm",
					[
						"pack",
						"--json",
						"--ignore-scripts",
						"--offline",
						"--pack-destination",
						root,
						"--cache",
						join(root, "cache"),
						"--userconfig",
						userconfig,
					],
					{ cwd: packageDir, encoding: "utf8" },
				),
			) as Record<string, { filename: string }> | Array<{ filename: string }>;
			const [archive] = Object.values(packed);
			expect(archive.filename).toMatch(/\.tgz$/);
			writeFileSync(
				controlPath,
				JSON.stringify({ name, root, userconfig, log, version, tarball: join(root, archive.filename) }),
			);
			if (generation === 1) await manager.installAndPersist(source);
			else await manager.update(source);
			expect(settingsManager.getGlobalSettings().packages).toEqual([source]);
			expect(JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8")).version).toBe(version);
			const resolved = await manager.resolve();
			for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
				expect(resolved[kind], kind).toHaveLength(1);
				expect(resolved[kind][0].enabled).toBe(true);
				expect(resolved[kind][0].path).toContain(label);
				expect(resolved[kind][0].metadata).toMatchObject({
					origin: "package",
					source,
					scope: "user",
					packageRoot: installedPath,
				});
			}
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions).toHaveLength(1);
			expect([...loader.getExtensions().extensions[0].commands.keys()]).toEqual([label]);
			expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual([label]);
			expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual([label]);
			expect(loader.getPrompts().prompts[0].content).toContain(`Prompt ${generation}`);
			expect(loader.getThemes().themes.map((loadedTheme) => loadedTheme.name)).toEqual([label]);
			expect([
				...loader.getSkills().diagnostics,
				...loader.getPrompts().diagnostics,
				...loader.getThemes().diagnostics,
			]).toEqual([]);
			if (generation === 2) expect(existsSync(join(installedPath, "payload", "resource-v1"))).toBe(false);
		}
		expect(await manager.removeAndPersist(source)).toBe(true);
		expect(settingsManager.getGlobalSettings().packages).toEqual([]);
		expect(existsSync(installedPath)).toBe(false);
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getPrompts().prompts).toEqual([]);
		expect(loader.getThemes().themes).toEqual([]);
		const operations = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		expect(operations.filter((args) => args[0] === "install")).toHaveLength(2);
		expect(operations.some((args) => args[0] === "view")).toBe(true);
		expect(operations.filter((args) => args[0] === "uninstall")).toHaveLength(1);
	}, 30_000);
});
