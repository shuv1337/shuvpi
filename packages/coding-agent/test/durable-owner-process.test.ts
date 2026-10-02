import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { connectBackgroundWorkflowOwner } from "../src/core/durable-workflows/client.ts";
import { requestWorkflowOwner, startWorkflowOwner } from "../src/core/durable-workflows/owner.ts";

const children = new Set<ChildProcess>();

describe.skipIf(process.platform === "win32")("durable workflow background owner process", () => {
	afterEach(async () => {
		for (const child of children) await stopChild(child);
		children.clear();
	});

	it("keeps ownership across UI exit and SIGSTOP, then permits takeover after SIGKILL", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-workflow-owner-"));
		const socketPath = join(directory, "owner.sock");
		const resolver = new URL("../src/experimental/source-resolver.ts", import.meta.url).pathname;
		const fixture = new URL("./fixtures/durable-owner-process.ts", import.meta.url).pathname;
		const command = process.execPath;
		const ownerArgs = ["--experimental-strip-types", "--import", resolver, fixture, "owner", socketPath];
		let ownerPid: number | undefined;
		try {
			const connection = await connectBackgroundWorkflowOwner(socketPath, {
				command,
				args: ownerArgs,
				readyTimeoutMs: 5_000,
			});
			expect(connection.started).toBe(true);
			expect(connection.ownerPid).toBeTypeOf("number");
			ownerPid = connection.ownerPid;
			if (ownerPid === undefined) throw new Error("Started workflow owner did not return its process ID");

			const ui = spawn(
				command,
				["--experimental-strip-types", "--import", resolver, fixture, "client", socketPath],
				{
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			children.add(ui);
			const uiOutput = collectOutput(ui);
			await waitForExit(ui);
			expect(uiOutput()).toContain('"accepted":true');
			expect(await requestWorkflowOwner(socketPath, { type: "after-ui-exit" })).toEqual({
				accepted: true,
				type: "after-ui-exit",
			});
			await disconnectClient(socketPath);
			expect(await requestWorkflowOwner(socketPath, { type: "after-disconnect" })).toEqual({
				accepted: true,
				type: "after-disconnect",
			});
			const oversized = await sendRaw(
				socketPath,
				`{"version":1,"requestId":"x","operation":{"type":"x","payload":"${"x".repeat(3 * 1024 * 1024)}"}}\n`,
			);
			expect(JSON.parse(oversized)).toMatchObject({ ok: false, error: expect.stringMatching(/frame limit/u) });
			await expect(
				requestWorkflowOwner(socketPath, { type: "large", payload: "x".repeat(3 * 1024 * 1024) }),
			).rejects.toThrow(/frame limit/u);
			const incompatible = await sendRaw(
				socketPath,
				'{"version":2,"requestId":"bad","operation":{"type":"health"}}\n',
			);
			expect(JSON.parse(incompatible)).toMatchObject({ version: 1, ok: false });

			process.kill(ownerPid, "SIGSTOP");
			await expect(startWorkflowOwner({ socketPath, handle: async () => ({ acquired: true }) })).rejects.toThrow(
				/already holds/u,
			);
			process.kill(ownerPid, "SIGKILL");
			await waitForOwnerLockRelease(`${socketPath}.lock.sqlite`);

			const contenders = await Promise.allSettled([
				startWorkflowOwner({
					socketPath,
					handle: async (operation) => ({ acquired: true, contender: "a", type: operation.type }),
				}),
				startWorkflowOwner({
					socketPath,
					handle: async (operation) => ({ acquired: true, contender: "b", type: operation.type }),
				}),
			]);
			const winners = contenders.filter(
				(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startWorkflowOwner>>> =>
					result.status === "fulfilled",
			);
			expect(winners).toHaveLength(1);
			try {
				expect(await requestWorkflowOwner(socketPath, { type: "after-death" })).toEqual({
					acquired: true,
					contender: expect.any(String),
					type: "after-death",
				});
			} finally {
				await winners[0]?.value.close();
			}
		} finally {
			if (ownerPid !== undefined) {
				try {
					process.kill(ownerPid, "SIGCONT");
					process.kill(ownerPid, "SIGKILL");
				} catch {
					// The owner exited during the test.
				}
			}
			await rm(directory, { recursive: true, force: true });
		}
	}, 20_000);

	it.skipIf(spawnSync("bun", ["--version"], { stdio: "ignore" }).error !== undefined)(
		"runs the background owner on Bun and serves a Node client",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-workflow-owner-bun-"));
			const socketPath = join(directory, "owner.sock");
			const fixture = new URL("./fixtures/durable-owner-process.ts", import.meta.url).pathname;
			const owner = spawn("bun", [fixture, "owner", socketPath], { stdio: ["ignore", "pipe", "pipe"] });
			children.add(owner);
			const ownerOutput = collectOutput(owner);
			try {
				await waitForText(owner, ownerOutput, "ready");
				expect(await requestWorkflowOwner(socketPath, { type: "from-node" })).toEqual({
					accepted: true,
					type: "from-node",
				});
			} finally {
				await stopChild(owner);
				children.delete(owner);
				await rm(directory, { recursive: true, force: true });
			}
		},
		15_000,
	);

	it("joins concurrent client startups to the same kernel-owned process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-workflow-owner-contenders-"));
		const socketPath = join(directory, "owner.sock");
		const resolver = new URL("../src/experimental/source-resolver.ts", import.meta.url).pathname;
		const fixture = new URL("./fixtures/durable-owner-process.ts", import.meta.url).pathname;
		const owner: { command: string; args: string[]; readyTimeoutMs: number } = {
			command: process.execPath,
			args: ["--experimental-strip-types", "--import", resolver, fixture, "owner", socketPath],
			readyTimeoutMs: 5_000,
		};
		let ownerPid: number | undefined;
		try {
			const [first, second] = await Promise.all([
				connectBackgroundWorkflowOwner(socketPath, owner),
				connectBackgroundWorkflowOwner(socketPath, owner),
			]);
			expect(first.ownerPid).toBeTypeOf("number");
			expect(second.ownerPid).toBe(first.ownerPid);
			expect([first.started, second.started].filter(Boolean)).toHaveLength(1);
			ownerPid = first.ownerPid;
			expect(await first.request({ type: "first" })).toMatchObject({ accepted: true });
			expect(await second.request({ type: "second" })).toMatchObject({ accepted: true });
		} finally {
			if (ownerPid !== undefined) {
				try {
					process.kill(ownerPid, "SIGKILL");
				} catch {
					// The detached owner exited during the test.
				}
			}
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);
});

function collectOutput(child: ChildProcess): () => string {
	let output = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		output += chunk;
	});
	return () => output;
}

async function waitForOwnerLockRelease(lockPath: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const database = new DatabaseSync(lockPath, { timeout: 0 });
		try {
			database.exec("BEGIN IMMEDIATE");
			database.exec("ROLLBACK");
			return;
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("database is locked")) throw error;
		} finally {
			database.close();
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Workflow owner lock did not release after SIGKILL");
}

function sendRaw(socketPath: string, frame: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let output = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			output += chunk;
		});
		socket.once("connect", () => socket.end(frame));
		socket.once("error", reject);
		socket.once("end", () => resolve(output.trim()));
	});
}

function disconnectClient(socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => socket.destroy());
		socket.once("close", resolve);
		socket.once("error", reject);
	});
}

function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			children.delete(child);
			if (code === 0) resolve();
			else reject(new Error(`Child failed with code ${code} and signal ${signal}`));
		});
	});
}

function waitForText(child: ChildProcess, output: () => string, expected: string): Promise<void> {
	if (output().includes(expected)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child output: ${output()}`)), 10_000);
		const check = (): void => {
			if (!output().includes(expected)) return;
			clearTimeout(timeout);
			child.stdout?.off("data", check);
			resolve();
		};
		child.stdout?.on("data", check);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`Child exited before readiness with code ${code} and signal ${signal}: ${output()}`));
		});
	});
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		setTimeout(resolve, 1_000).unref();
	});
}
