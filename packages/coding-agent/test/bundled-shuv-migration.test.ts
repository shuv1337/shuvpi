import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateBundledShuvPackage } from "../src/migrations.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("bundled shuv package migration", () => {
	it("removes npm and local copies while retaining unrelated packages", async () => {
		const root = await mkdtemp(join(tmpdir(), "shuvpi-bundled-shuv-"));
		temporaryDirectories.push(root);
		const agentDir = join(root, "agent");
		const localPackage = join(agentDir, "pi-shuv");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(localPackage, { recursive: true });
		writeFileSync(join(localPackage, "package.json"), JSON.stringify({ name: "@shuv1337/shuvpi-shuv" }));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [
					"@shuv1337/shuvpi-shuv",
					"./pi-shuv",
					"npm:@shuv1337/shuvpi-shuv@1.0.0",
					{ source: "./pi-shuv" },
					{ source: "npm:@plannotator/pi-extension", skills: [] },
				],
			}),
		);

		migrateBundledShuvPackage(agentDir);

		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({
			packages: [{ source: "npm:@plannotator/pi-extension", skills: [] }],
		});
	});

	it("resolves project-local packages from the project settings directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "shuvpi-bundled-shuv-project-"));
		temporaryDirectories.push(root);
		const settingsDir = join(root, ".shuvpi");
		const localPackage = join(settingsDir, "pi-shuv");
		mkdirSync(settingsDir, { recursive: true });
		mkdirSync(localPackage, { recursive: true });
		writeFileSync(join(localPackage, "package.json"), JSON.stringify({ name: "@shuv1337/shuvpi-shuv" }));
		writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ packages: ["./pi-shuv", "npm:other"] }));

		migrateBundledShuvPackage(settingsDir);

		expect(JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf-8"))).toEqual({
			packages: ["npm:other"],
		});
	});
});
