import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@shuv1337/shuvpi-ai";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import { createRegistry } from "@shuv1337/shuvpi-durable";
import { openNodeSqliteStorage } from "@shuv1337/shuvpi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundOwnerConnection } from "../src/core/durable-workflows/client.ts";
import {
	connectDurableWorkflows,
	DurableWorkflowConnection,
	drainWorkflowReceipts,
} from "../src/core/durable-workflows/connection.ts";
import {
	isWorkflowJsonObject,
	type WorkflowJsonValue,
	type WorkflowOwnerOperation,
} from "../src/core/durable-workflows/protocol.ts";
import { captureWorkflowReceiptDestination, WORKFLOW_RECEIPT_TYPE } from "../src/core/durable-workflows/receipt.ts";
import { startDurableWorkflowService } from "../src/core/durable-workflows/service.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const context = BACKGROUND_CONTEXT;
const closes: (() => Promise<void>)[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const close of closes.splice(0).reverse()) await close();
	for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "workflow-service-"));
	directories.push(directory);
	const socketPath = join(directory, "owner.sock");
	const storePath = join(directory, "state.sqlite");
	const session = SessionManager.create(directory, directory);
	session.appendMessage({ role: "user", content: "workflow", timestamp: 1 });
	const destination = captureWorkflowReceiptDestination(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const reports: unknown[] = [];
	const open = async () => {
		const service = await startDurableWorkflowService(
			{
				socketPath,
				openStorage: () => openNodeSqliteStorage(storePath),
				harness: { models, registry: createRegistry(), onReport: (error) => reports.push(error) },
				agent: { model: { provider: "faux", modelId: "faux-1" } },
			},
			context,
		);
		let closed = false;
		const close = async () => {
			if (!closed) {
				closed = true;
				await service.close();
			}
		};
		closes.push(close);
		return { close, connection: await connectDurableWorkflows(socketPath) };
	};
	return { directory, session, destination, faux, reports, open, socketPath };
}

describe("workflow owner production integration", () => {
	it("refreshes a list item when its chunked archive changes during hydration", async () => {
		const operations: WorkflowOwnerOperation[] = [];
		const owner: BackgroundOwnerConnection = {
			started: false,
			request: async (operation) => {
				operations.push(operation);
				if (operation.type === "list")
					return {
						items: [
							{
								runId: "workflow-1",
								status: "running",
								resultReference: { section: "result", bytes: 4, digest: "0".repeat(64) },
							},
						],
						nextCursor: null,
					} as WorkflowJsonValue;
				if (operation.type === "read") throw new Error("Workflow archive changed while it was being read");
				if (operation.type === "status")
					return { runId: "workflow-1", status: "completed", result: "current", error: null } as WorkflowJsonValue;
				throw new Error(`Unexpected test operation: ${operation.type}`);
			},
		};
		const listed = await new DurableWorkflowConnection(owner).list();
		expect(listed).toEqual([{ runId: "workflow-1", status: "completed", result: "current", error: null }]);
		expect(operations.map((operation) => operation.type)).toEqual(["list", "read", "status"]);
	});

	it("reconnects through the detached launcher after SIGKILL during an agent and before receipt acknowledgment", async () => {
		const fixture = await setup();
		const launcher = (mode: string) => ({
			command: process.execPath,
			args: [
				"--experimental-strip-types",
				"--import",
				fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url)),
				fileURLToPath(new URL("./fixtures/durable-service-process.ts", import.meta.url)),
				fixture.directory,
				mode,
			],
			cwd: fixture.directory,
		});
		const pids = new Set<number>();
		closes.push(async () => {
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		});
		const first = await connectDurableWorkflows(fixture.socketPath, launcher("hold"));
		pids.add(first.owner.ownerPid!);
		const run = await first.start({
			input: { source: 'return await agent("persisted request");', args: null },
			route: "background",
			destination: fixture.destination,
		});
		await vi.waitFor(async () => expect(await readFile(join(fixture.directory, "reached"), "utf8")).toBe("ready"));
		process.kill(first.owner.ownerPid!, "SIGKILL");
		await vi.waitFor(async () =>
			expect(
				await first.owner.request({ type: "health" }).then(
					() => true,
					() => false,
				),
			).toBe(false),
		);
		pids.delete(first.owner.ownerPid!);
		const second = await connectDurableWorkflows(fixture.socketPath, launcher("resume"));
		pids.add(second.owner.ownerPid!);
		await vi.waitFor(async () =>
			expect(await second.status(run.runId)).toMatchObject({
				status: "completed",
				result: { output: "process resumed" },
				receipt: { status: "pending" },
			}),
		);
		process.kill(second.owner.ownerPid!, "SIGKILL");
		await vi.waitFor(async () =>
			expect(
				await second.owner.request({ type: "health" }).then(
					() => true,
					() => false,
				),
			).toBe(false),
		);
		pids.delete(second.owner.ownerPid!);
		const third = await connectDurableWorkflows(fixture.socketPath, launcher("resume"));
		pids.add(third.owner.ownerPid!);
		expect(await drainWorkflowReceipts(third, fixture.session)).toMatchObject({ persisted: 1 });
		expect(
			(await readFile(join(fixture.directory, "requests.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([{ users: 1 }, { users: 1 }]);
		expect(await third.status(run.runId)).toMatchObject({ receipt: { status: "persisted" } });
	});

	it("runs generated agents through owned Harness conversations and drains an archived result after reconnect", async () => {
		const fixture = await setup();
		fixture.faux.setResponses([
			fauxAssistantMessage([fauxText('{"items":["a","b"]}')]),
			fauxAssistantMessage([fauxText("first")]),
			fauxAssistantMessage([fauxText("second")]),
		]);
		const first = await fixture.open();
		const run = await first.connection.start({
			input: {
				source:
					'const plan=await agent("plan",{schema:{type:"object",properties:{items:{type:"array",items:{type:"string"}}},required:["items"]}}); return await Promise.all(plan.structured.items.map(x=>agent(x,{effort:"high"})));',
				args: null,
			},
			route: "background",
			destination: fixture.destination,
			requestId: "one",
		});
		await vi.waitFor(async () =>
			expect(await first.connection.status(run.runId)).toMatchObject({
				status: "completed",
				result: [
					{ ok: true, output: "first" },
					{ ok: true, output: "second" },
				],
				receipt: { status: "pending" },
			}),
		);
		expect(fixture.session.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
		await first.close();
		const second = await fixture.open();
		expect(await drainWorkflowReceipts(second.connection, fixture.session)).toEqual({
			persisted: 1,
			pending: 0,
			reasons: [],
		});
		expect(await second.connection.status(run.runId)).toMatchObject({
			status: "completed",
			receipt: { status: "persisted" },
		});
		expect(await drainWorkflowReceipts(second.connection, fixture.session)).toEqual({
			persisted: 0,
			pending: 0,
			reasons: [],
		});
		const receipts = SessionManager.open(fixture.destination.sessionFile)
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === WORKFLOW_RECEIPT_TYPE);
		expect(receipts).toHaveLength(1);
		expect(fixture.reports).toEqual([]);
	});

	it("deduplicates start requests, rejects changed input or destination, and rejects forged acknowledgments", async () => {
		const fixture = await setup();
		const { connection } = await fixture.open();
		const request = {
			input: {
				source: "return args;",
				args: { value: 4 },
				agent: { model: { provider: "faux", modelId: "faux-1" }, effort: "high" },
			},
			route: "foreground" as const,
			destination: fixture.destination,
			requestId: "repeat",
		};
		const first = await connection.start(request);
		expect(await connection.start(request)).toEqual({ ...first, created: false });
		await expect(connection.start({ ...request, input: { ...request.input, args: { value: 5 } } })).rejects.toThrow(
			"different",
		);
		await expect(
			connection.start({
				...request,
				input: { ...request.input, agent: { model: { provider: "faux", modelId: "faux-2" }, effort: "high" } },
			}),
		).rejects.toThrow("different");
		await expect(
			connection.start({ ...request, destination: { ...fixture.destination, originEntryId: "other" } }),
		).rejects.toThrow("different");
		await vi.waitFor(async () => expect(await connection.status(first.runId)).toMatchObject({ status: "completed" }));
		await expect(
			connection.owner.request({
				type: "ack",
				runId: first.runId,
				acknowledgment: {
					eventId: `${first.runId}:result`,
					entryId: "forged",
					digest: "0".repeat(64),
					destination: { ...fixture.destination },
				},
			}),
		).rejects.toThrow("match");
		expect(await connection.status(first.runId)).toMatchObject({ receipt: { status: "pending" } });
	});

	it("reopens a running agent without duplicating its durable submission", async () => {
		const fixture = await setup();
		const reached = Promise.withResolvers<void>();
		fixture.faux.setResponses([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					reached.resolve();
					options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
				}),
		]);
		const first = await fixture.open();
		const run = await first.connection.start({
			input: { source: 'return await agent("resume me");', args: null },
			route: "background",
			destination: fixture.destination,
		});
		await reached.promise;
		await first.close();
		fixture.faux.setResponses([
			(request) => {
				expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1);
				return fauxAssistantMessage([fauxText("resumed")]);
			},
		]);
		const second = await fixture.open();
		await vi.waitFor(async () =>
			expect(await second.connection.status(run.runId)).toMatchObject({
				status: "completed",
				result: { ok: true, output: "resumed" },
			}),
		);
		expect(await drainWorkflowReceipts(second.connection, fixture.session)).toMatchObject({ persisted: 1 });
		expect(fixture.reports).toEqual([]);
	});

	it("cancels the owned agent subtree and delivers an explicit aborted completion", async () => {
		const fixture = await setup();
		const reached = Promise.withResolvers<void>();
		fixture.faux.setResponses([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					reached.resolve();
					options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
				}),
		]);
		const { connection } = await fixture.open();
		const run = await connection.start({
			input: { source: 'return await agent("hold");', args: null },
			route: "background",
			destination: fixture.destination,
		});
		await reached.promise;
		expect(await connection.cancel(run.runId)).toMatchObject({ status: "aborted", receipt: { status: "pending" } });
		expect(await drainWorkflowReceipts(connection, fixture.session)).toMatchObject({ persisted: 1 });
		expect(fixture.session.getEntries().find((entry) => entry.type === "custom_message")).toMatchObject({
			details: { payload: { status: "aborted", result: null } },
		});
	});

	it("holds a completion pending on a sibling transcript branch", async () => {
		const fixture = await setup();
		const origin = fixture.session.getLeafId()!;
		fixture.session.appendMessage({ role: "user", content: "launch branch", timestamp: 2 });
		const destination = captureWorkflowReceiptDestination(fixture.session);
		const { connection } = await fixture.open();
		const run = await connection.start({
			input: { source: "return 42;", args: null },
			route: "foreground",
			destination,
		});
		await vi.waitFor(async () => expect(await connection.status(run.runId)).toMatchObject({ status: "completed" }));
		fixture.session.branch(origin);
		fixture.session.appendMessage({ role: "user", content: "sibling", timestamp: 3 });
		expect(await drainWorkflowReceipts(connection, fixture.session)).toMatchObject({ persisted: 0, pending: 1 });
		expect(await connection.status(run.runId)).toMatchObject({ receipt: { status: "pending" } });
	});

	it("pages large archives and outbox receipts without losing transcript deliveries", async () => {
		const fixture = await setup();
		const { connection } = await fixture.open();
		const output = "x".repeat(614_400);
		const runs = await Promise.all(
			["large-one", "large-two", "large-three", "large-four"].map((requestId) =>
				connection.start({
					input: { source: "return 'x'.repeat(614400);", args: null },
					route: "background",
					destination: fixture.destination,
					requestId,
				}),
			),
		);
		await vi.waitFor(async () => {
			const archives = await Promise.all(runs.map((run) => connection.status(run.runId)));
			expect(archives.every((archive) => isCompletedWithLargeOutput(archive))).toBe(true);
		});
		const firstPage = await connection.owner.request({ type: "list", afterTaskId: "0", limit: 64 });
		expect(firstPage).toMatchObject({ nextCursor: expect.any(String) });
		if (!isWorkflowJsonObject(firstPage) || !Array.isArray(firstPage.items))
			throw new Error("Expected bounded workflow list page");
		expect(firstPage.items.length).toBeLessThan(4);
		expect(Buffer.byteLength(JSON.stringify(firstPage))).toBeLessThan(2 * 1024 * 1024);
		const receiptPage = await connection.owner.request({ type: "receipts", afterTaskId: "0", limit: 64 });
		expect(Buffer.byteLength(JSON.stringify(receiptPage))).toBeLessThan(2 * 1024 * 1024);
		if (!isWorkflowJsonObject(receiptPage) || !Array.isArray(receiptPage.items))
			throw new Error("Expected bounded workflow receipt page");
		expect(receiptPage.items.every((item) => isWorkflowJsonObject(item) && !("event" in item))).toBe(true);
		const listed = await connection.list();
		expect(Array.isArray(listed)).toBe(true);
		if (!Array.isArray(listed)) throw new Error("Expected workflow list array");
		expect(listed).toHaveLength(4);
		for (const archive of listed) {
			expect(archive).toMatchObject({ status: "completed" });
			expect(archive).toHaveProperty("result", output);
		}
		expect(await connection.cancel(runs[0]!.runId)).toMatchObject({
			status: "completed",
			journal: { operations: expect.any(Array) },
		});

		expect(await drainWorkflowReceipts(connection, fixture.session)).toMatchObject({ persisted: 4, pending: 0 });
		expect(await drainWorkflowReceipts(connection, fixture.session)).toMatchObject({ persisted: 0, pending: 0 });
		const persisted = SessionManager.open(fixture.destination.sessionFile)
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === WORKFLOW_RECEIPT_TYPE);
		expect(persisted).toHaveLength(4);
		expect(
			persisted.map((entry) => {
				if (
					entry.type !== "custom_message" ||
					typeof entry.details !== "object" ||
					entry.details === null ||
					!("payload" in entry.details)
				)
					return null;
				const payload = entry.details.payload;
				if (typeof payload !== "object" || payload === null || !("result" in payload)) return null;
				return payload.result;
			}),
		).toEqual([output, output, output, output]);
	});

	it("reconstructs an oversized archived journal from digest-verified chunks", async () => {
		const fixture = await setup();
		const { connection } = await fixture.open();
		const output = "large child output ".repeat(30_000);
		fixture.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText(output)])));
		const run = await connection.start({
			input: {
				source:
					'const results = await Promise.all(Array.from({length:4}, (_, i) => agent("large child " + i))); return results.map(result => result.ok);',
				args: null,
			},
			route: "foreground",
			destination: fixture.destination,
		});
		const archive = await vi.waitFor(async () => {
			const value = await connection.status(run.runId);
			if (!isWorkflowJsonObject(value) || value.status !== "completed") throw new Error("Workflow is still running");
			return value;
		});
		expect(archive).toMatchObject({ status: "completed", result: [true, true, true, true] });
		if (!isWorkflowJsonObject(archive.journal) || !Array.isArray(archive.journal.operations))
			throw new Error("Expected archived workflow operations");
		expect(archive.journal.operations).toHaveLength(4);
		for (const operation of archive.journal.operations) {
			if (!isWorkflowJsonObject(operation) || !isWorkflowJsonObject(operation.result))
				throw new Error("Expected archived child output");
			expect(operation.result.output).toBe(output);
		}
		const summary = await connection.owner.request({ type: "status", runId: run.runId });
		if (!isWorkflowJsonObject(summary) || !isWorkflowJsonObject(summary.journalReference))
			throw new Error("Expected a chunked workflow journal reference");
		await expect(
			connection.owner.request({
				type: "read",
				runId: run.runId,
				section: "journal",
				offset: 0,
				limit: 256 * 1024,
				totalBytes: summary.journalReference.bytes,
				digest: "0".repeat(64),
			}),
		).rejects.toThrow("changed while it was being read");
		expect(await connection.cancel(run.runId)).toMatchObject({
			status: "completed",
			journal: { operations: expect.any(Array) },
		});
	});
});

function isCompletedWithLargeOutput(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		value.status === "completed" &&
		"result" in value &&
		value.result === "x".repeat(614_400)
	);
}
