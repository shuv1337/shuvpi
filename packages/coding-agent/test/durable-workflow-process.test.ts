import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requestWorkflowOwner } from "../src/core/durable-workflows/owner.ts";
import { isWorkflowJsonObject, type WorkflowJsonObject } from "../src/core/durable-workflows/protocol.ts";

interface Fixture {
	child: ChildProcess;
	messages: WorkflowJsonObject[];
	output(): string;
	exited: Promise<void>;
}
const processes = new Set<Fixture>();
const directories: string[] = [];
afterEach(async () => {
	for (const fixture of processes) await stop(fixture, "SIGKILL");
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("workflow generated JavaScript across owner death", () => {
	it.each(["child-running", "child-settled"])(
		"reuses admitted children after SIGKILL at %s",
		async (boundary) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-workflow-process-"));
			directories.push(directory);
			const before = launch(directory, boundary);
			const started = await message(before, "ready");
			const interrupted = await message(before, "boundary");
			const snapshot = await requestWorkflowOwner(join(directory, "owner.sock"), { type: "snapshot" });
			expect(snapshot).toMatchObject({
				ledger: {
					root: started.workflowId,
					children: [{ id: interrupted.childId, prompt: "seed", completed: boundary === "child-settled" }],
				},
				journal: {
					operations: [
						{ kind: "phase", status: "settled" },
						{ kind: "agent", taskId: interrupted.childId, status: "started" },
					],
				},
			});
			await stop(before, "SIGKILL");
			expect(before.child.signalCode).toBe("SIGKILL");
			const after = launch(directory, "resume");
			expect((await message(after, "ready")).workflowId).toBe(started.workflowId);
			const completed = await message(after, "complete");
			expect(completed.outcome).toEqual({
				status: "completed",
				result: { values: ["same", "same"], selected: "selected:fast" },
			});
			if (!isWorkflowJsonObject(completed.ledger) || !Array.isArray(completed.ledger.children))
				throw new Error("Missing completion ledger");
			const children = completed.ledger.children;
			expect(children).toHaveLength(6);
			expect(children[0]).toEqual({ id: interrupted.childId, prompt: "seed", completed: true });
			expect(children.every((child) => isWorkflowJsonObject(child) && child.completed === true)).toBe(true);
			expect(new Set(children.map((child) => (isWorkflowJsonObject(child) ? child.id : null))).size).toBe(6);
			await stop(after, "SIGTERM");
		},
		20_000,
	);
});

function launch(directory: string, boundary: string): Fixture {
	const child = fork(
		fileURLToPath(new URL("./fixtures/durable-workflow-process.ts", import.meta.url)),
		[directory, boundary],
		{
			execArgv: [
				"--experimental-strip-types",
				"--import",
				fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url)),
			],
			env: { PATH: process.env.PATH, SHUVPI_OFFLINE: "1", TZ: "America/Los_Angeles" },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	let output = "";
	child.stdout?.on("data", (data: Buffer) => {
		output += data.toString();
	});
	child.stderr?.on("data", (data: Buffer) => {
		output += data.toString();
	});
	const messages: WorkflowJsonObject[] = [];
	child.on("message", (value: unknown) => {
		if (isWorkflowJsonObject(value)) messages.push(value);
	});
	const exited = new Promise<void>((resolve, reject) => {
		child.once("exit", () => resolve());
		child.once("error", reject);
	});
	const fixture = { child, messages, output: () => output, exited };
	processes.add(fixture);
	return fixture;
}

async function message(fixture: Fixture, event: string): Promise<WorkflowJsonObject> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		const found = fixture.messages.find((value) => value.event === event);
		if (found) return found;
		if (fixture.child.exitCode !== null || fixture.child.signalCode !== null)
			throw new Error(`Fixture exited before ${event}: ${fixture.output()}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`No ${event} event: ${JSON.stringify(fixture.messages)} ${fixture.output()}`);
}

async function stop(fixture: Fixture, signal: NodeJS.Signals): Promise<void> {
	if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill(signal);
	await fixture.exited;
	processes.delete(fixture);
}
