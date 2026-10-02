import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestWorkflowOwner } from "../src/core/durable-workflows/owner.ts";

interface PackagedProcess {
	child: ChildProcess;
	output(): string;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(process.platform === "win32" || !bunAvailable)("packaged durable storage and ownership", () => {
	let directory: string;
	let bundle: string;
	let binary: string;
	const children = new Set<PackagedProcess>();
	const cleanEnvironment = { PATH: process.env.PATH, SHUVPI_OFFLINE: "1", TZ: "America/Los_Angeles" };

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-durable-package-"));
		bundle = join(directory, "owner.mjs");
		binary = join(directory, "owner-bun");
		const result = await build({
			entryPoints: [fileURLToPath(new URL("./fixtures/durable-package-entry.ts", import.meta.url))],
			outfile: bundle,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22.19",
			conditions: ["source"],
			tsconfigRaw: { compilerOptions: {} },
			metafile: true,
		});
		const external = Object.values(result.metafile.inputs)
			.flatMap((input) => input.imports)
			.filter((entry) => entry.external && !isBuiltin(entry.path));
		expect(external).toEqual([]);
		expect(await readFile(bundle, "utf8")).not.toMatch(/source-resolver|node_modules\//u);
		const compiled = spawnSync("bun", ["build", "--compile", bundle, "--outfile", binary], {
			cwd: directory,
			env: cleanEnvironment,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
	}, 40_000);

	afterAll(async () => {
		for (const child of children) await stop(child, "SIGKILL");
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it.each(["node", "bun"] as const)(
		"reopens %s commits in the other packaged runtime after SIGKILL",
		async (runtime) => {
			const state = join(directory, runtime);
			await mkdir(state, { mode: 0o700 });
			const socket = join(state, "owner.sock");
			const other = runtime === "node" ? "bun" : "node";
			const original = launch(runtime, state);
			await ready(original);
			expect(await requestWorkflowOwner(socket, { type: "increment" })).toEqual({ count: 1 });
			original.child.kill("SIGSTOP");
			const contender = launch(other, state);
			const rejected = await contender.exited;
			expect(rejected.code, contender.output()).not.toBe(0);
			expect(contender.output()).toContain("already holds");
			await stop(original, "SIGKILL");
			const recovered = launch(other, state);
			await ready(recovered);
			expect(await requestWorkflowOwner(socket, { type: "read" })).toEqual({ count: 1 });
			expect(await requestWorkflowOwner(socket, { type: "increment" })).toEqual({ count: 2 });
			await stop(recovered, "SIGTERM");
			const reopened = launch(runtime, state);
			await ready(reopened);
			expect(await requestWorkflowOwner(socket, { type: "read" })).toEqual({ count: 2 });
			await stop(reopened, "SIGTERM");
		},
		20_000,
	);

	function launch(runtime: "node" | "bun", state: string): PackagedProcess {
		const child =
			runtime === "node"
				? spawn(process.execPath, [bundle, state], {
						cwd: directory,
						env: cleanEnvironment,
						stdio: ["ignore", "pipe", "pipe"],
					})
				: spawn(binary, [state], { cwd: directory, env: cleanEnvironment, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			output += chunk;
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		const packaged = { child, output: () => output, exited };
		children.add(packaged);
		return packaged;
	}

	async function ready(process: PackagedProcess): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			if (process.output().includes("ready\n")) return;
			if (process.child.exitCode !== null || process.child.signalCode !== null)
				throw new Error(`Packaged owner exited: ${process.output()}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Packaged owner did not start: ${process.output()}`);
	}

	async function stop(process: PackagedProcess, signal: NodeJS.Signals): Promise<void> {
		if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill(signal);
		await process.exited;
		children.delete(process);
	}
});
