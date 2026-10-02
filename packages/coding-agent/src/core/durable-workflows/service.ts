import { createHash } from "node:crypto";
import { type Context, copyJson } from "@shuv1337/shuvpi-chord";
import {
	type AgentChange,
	configure,
	defineDoc,
	Harness,
	type HarnessOptions,
	type JsonObject,
	type Registry,
	type Storage,
	type TaskId,
} from "@shuv1337/shuvpi-durable";
import { WorkflowAgentTask, workflowAgentConfiguration } from "./agent-task.ts";
import {
	acknowledgeWorkflowReceipt,
	archiveWorkflowSettlement,
	createWorkflowTaskOnce,
	isWorkflowTaskInput,
	queueWorkflowReceipt,
	retryWorkflowReceipt,
	WorkflowRunArchiveDoc,
} from "./archive.ts";
import { WorkflowJournalDoc } from "./journal.ts";
import { startWorkflowOwner } from "./owner.ts";
import { WorkflowOwnerContext } from "./owner-context.ts";
import {
	isWorkflowJsonObject,
	WORKFLOW_OWNER_MAX_FRAME_BYTES,
	WORKFLOW_OWNER_PAGE_SIZE,
	WORKFLOW_OWNER_READ_CHUNK_BYTES,
	type WorkflowJsonValue,
	type WorkflowOwnerOperation,
} from "./protocol.ts";
import type { WorkflowReceiptAcknowledgment, WorkflowReceiptDestination } from "./receipt.ts";
import { createWorkflowTask, type WorkflowAgentResult } from "./runner.ts";

interface Delivery extends JsonObject {
	route: "foreground" | "background";
	destination: { sessionFile: string; sessionId: string; originEntryId: string };
}

const WorkflowServiceDoc = defineDoc<{ tasks: number[]; deliveries: Record<string, Delivery> }>({
	kind: "coding-agent.workflow-service",
	version: 1,
	scope: "session",
	initial: () => ({ tasks: [], deliveries: {} }),
});

export interface DurableWorkflowServiceOptions {
	socketPath: string;
	/** Called only after the exclusive owner lock has been acquired. */
	openStorage(): Promise<Storage>;
	harness: Omit<HarnessOptions, "registry"> & { registry: Registry };
	agent: AgentChange;
}

/** Production owner: one Harness and SQLite store, with all client requests serialized through durable commits. */
export async function startDurableWorkflowService(
	options: DurableWorkflowServiceOptions,
	context: Context,
): Promise<{ close(): Promise<void> }> {
	let harness: Harness | undefined;
	const initialized = Promise.withResolvers<void>();
	// Mark the initialization rejection handled even when no client has connected yet.
	void initialized.promise.catch(() => {});
	const ownerContext = new WorkflowOwnerContext(
		options.harness.registry,
		options.agent,
		options.harness.toolPolicies ?? [],
	);
	const workflow = createWorkflowTask({
		createChild: async (tx, request) => {
			const agent = workflowAgentConfiguration(request, options.agent);
			const conversation = await tx.createConversation({
				ownership: { kind: "task", taskId: request.workflowTaskId },
			});
			const tools = await ownerContext.bind(tx, conversation.id, request.defaults);
			await configure(tx, conversation.id, { ...agent, tools });
			return tx.createTask(
				WorkflowAgentTask,
				{ ...request, childConversationId: conversation.id },
				{ ownership: { kind: "task", taskId: request.workflowTaskId } },
			);
		},
		readChildResult: async (task) => {
			if (task.state.outcome.status !== "completed")
				return { ok: false, output: "", error: task.state.outcome.status };
			return task.state.outcome.result as WorkflowAgentResult;
		},
		onSettled: async (tx, record) => {
			await archiveWorkflowSettlement(tx, record);
			const delivery = (await tx.doc(WorkflowServiceDoc)).deliveries[String(record.taskId)];
			if (delivery) await queueWorkflowReceipt(tx, record.taskId, delivery.route, delivery.destination);
		},
	});
	options.harness.registry.install({ name: "coding-agent.workflows", tasks: [workflow, WorkflowAgentTask] });
	const owner = await startWorkflowOwner({
		socketPath: options.socketPath,
		handle: async (operation) => {
			await initialized.promise;
			return handle(operation);
		},
	});
	try {
		harness = await Harness.open(
			await options.openStorage(),
			{ ...options.harness, toolPolicies: ownerContext.toolPolicies },
			context,
		);
		await harness.root(context, { agent: options.agent });
		harness.resume();
		initialized.resolve();
	} catch (error) {
		initialized.reject(error);
		await harness?.close(context);
		await owner.close();
		throw error;
	}

	async function archive(taskId: TaskId) {
		const value = await harness!.snapshot(WorkflowRunArchiveDoc, String(taskId), context);
		if (!value || value.taskId !== taskId) throw new Error("Unknown workflow run");
		if (value.status === "running") {
			const journal = await harness!.snapshot(WorkflowJournalDoc, taskId, context);
			if (journal) return { ...value, journal };
		}
		return value;
	}

	function responseFits(value: WorkflowJsonValue, requestId: string): boolean {
		return (
			Buffer.byteLength(
				`${JSON.stringify({
					version: 1,
					requestId: requestId.padEnd(128, "x"),
					ok: true,
					value,
				})}\n`,
			) <= WORKFLOW_OWNER_MAX_FRAME_BYTES
		);
	}

	function archiveSummary(value: Awaited<ReturnType<typeof archive>>): WorkflowJsonValue {
		const summary: Record<string, unknown> = { ...value };
		const references: Record<string, WorkflowJsonValue> = {};
		for (const section of ["result", "journal", "error"] as const) {
			const encoded = Buffer.from(JSON.stringify(value[section] ?? null), "utf8");
			references[section] = {
				section,
				bytes: encoded.byteLength,
				digest: createHash("sha256").update(encoded).digest("hex"),
			};
		}
		delete summary.result;
		delete summary.journal;
		delete summary.error;
		summary.resultReference = references.result;
		summary.journalReference = references.journal;
		summary.errorReference = references.error;
		return summary as WorkflowJsonValue;
	}

	function boundedArchive(value: Awaited<ReturnType<typeof archive>>, requestId: string): WorkflowJsonValue {
		if (responseFits(value as WorkflowJsonValue, requestId)) return copyJson(value) as WorkflowJsonValue;
		const summary = archiveSummary(value);
		if (!responseFits(summary, requestId)) throw new Error("Workflow archive summary exceeds its response budget");
		return summary;
	}

	async function handle(operation: WorkflowOwnerOperation): Promise<WorkflowJsonValue> {
		if (operation.type === "start") {
			if (
				!isWorkflowTaskInput(operation.input) ||
				typeof operation.requestId !== "string" ||
				!isDestination(operation.destination) ||
				(operation.route !== "foreground" && operation.route !== "background")
			)
				throw new Error("Invalid workflow start request");
			const root = await harness!.root(context);
			const { requestId, route, destination } = operation;
			const input = ownerContext.prepareInput(operation.input);
			const started = await root.commit(async (tx) => {
				const admission = await createWorkflowTaskOnce(tx, workflow, input, root.id, requestId, {
					ownership: { kind: "conversation" },
					background: route === "background",
				});
				const index = await tx.doc(WorkflowServiceDoc);
				const previous = index.deliveries[String(admission.taskId)];
				if (
					previous &&
					(previous.route !== route ||
						previous.destination.sessionFile !== destination.sessionFile ||
						previous.destination.sessionId !== destination.sessionId ||
						previous.destination.originEntryId !== destination.originEntryId)
				)
					throw new Error("Workflow request was already bound to a different receipt destination");
				if (admission.created) {
					index.tasks.push(admission.taskId);
					index.deliveries[String(admission.taskId)] = {
						route,
						destination: {
							sessionFile: destination.sessionFile,
							sessionId: destination.sessionId,
							originEntryId: destination.originEntryId,
						},
					};
				}
				return admission;
			}, context);
			harness!.resume();
			return { runId: `workflow-${started.taskId}`, taskId: started.taskId, created: started.created };
		}
		if (operation.type === "list" || operation.type === "receipts") {
			const index = await harness!.snapshot(WorkflowServiceDoc, context);
			const afterTaskId = parseCursor(operation.afterTaskId);
			const tasks = (index?.tasks ?? []).filter((id) => Number(id) > afterTaskId);
			const pageLimit = parsePageLimit(operation.limit);
			const pageTasks = tasks.slice(0, pageLimit);
			const records = await Promise.all(pageTasks.map((id) => archive(id as TaskId)));
			if (operation.type === "receipts") {
				return {
					items: records
						.filter((record) => record.receipt.status === "pending")
						.map((record) => ({
							taskId: record.taskId,
							runId: record.runId,
							route: record.receipt.route,
							destination: record.receipt.destination,
						})),
					nextCursor: pageTasks.length === tasks.length ? null : String(pageTasks.at(-1)),
				};
			}
			for (let count = records.length; count > 0; count--) {
				const items = records.slice(0, count).map((record) => boundedArchive(record, "x".repeat(128)));
				const page = {
					items,
					nextCursor: count === tasks.length ? null : String(pageTasks[count - 1]),
				};
				if (responseFits(page, "x".repeat(128))) return page;
			}
			if (tasks.length === 0) return { items: [], nextCursor: null };
			const record = records[0]!;
			const page = { items: [archiveSummary(record)], nextCursor: String(pageTasks[0]) };
			if (!responseFits(page, "x".repeat(128))) throw new Error("Workflow list page exceeds its response budget");
			return page;
		}
		const taskId = parseWorkflowTaskId(operation.runId);
		if (operation.type === "status") return boundedArchive(await archive(taskId), "x".repeat(128));
		if (operation.type === "read") {
			const section = operation.section;
			if (section !== "result" && section !== "journal" && section !== "error")
				throw new Error("Invalid workflow archive section");
			const offset = parseReadOffset(operation.offset);
			const limit = Math.min(parseReadLimit(operation.limit), WORKFLOW_OWNER_READ_CHUNK_BYTES);
			const value = await archive(taskId);
			const bytes = Buffer.from(JSON.stringify(value[section] ?? null), "utf8");
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (operation.digest !== digest || operation.totalBytes !== bytes.byteLength)
				throw new Error("Workflow archive changed while it was being read; retry the status request");
			const data = bytes.subarray(offset, Math.min(offset + limit, bytes.byteLength));
			return {
				section,
				offset,
				totalBytes: bytes.byteLength,
				digest,
				data: data.toString("base64"),
				nextOffset: offset + data.byteLength < bytes.byteLength ? offset + data.byteLength : null,
			};
		}
		if (operation.type === "cancel") {
			await archive(taskId);
			await harness!.abortTask(taskId, context);
			await harness!.waitForTask(taskId, context);
			return boundedArchive(await archive(taskId), "x".repeat(128));
		}
		if (operation.type === "ack") {
			if (!isAcknowledgment(operation.acknowledgment)) throw new Error("Invalid workflow receipt acknowledgment");
			const acknowledgment = operation.acknowledgment;
			await harness!.commit((tx) => acknowledgeWorkflowReceipt(tx, taskId, acknowledgment), context);
			return { status: "persisted" };
		}
		if (operation.type === "retry-receipt") {
			if (
				!isDestination(operation.destination) ||
				(operation.route !== "foreground" && operation.route !== "background")
			)
				throw new Error("Invalid workflow receipt retry");
			const { route, destination } = operation;
			await harness!.commit((tx) => retryWorkflowReceipt(tx, taskId, route, destination), context);
			return { status: "pending" };
		}
		throw new Error(`Unsupported workflow owner operation: ${operation.type}`);
	}

	return {
		close: async () => {
			try {
				await harness!.close(context);
			} finally {
				await owner.close();
			}
		},
	};
}

export function parseWorkflowTaskId(value: unknown): TaskId {
	if (typeof value !== "string" || !/^workflow-[1-9]\d*$/.test(value)) throw new Error("Invalid workflow run ID");
	const id = Number(value.slice("workflow-".length));
	if (!Number.isSafeInteger(id)) throw new Error("Invalid workflow task ID");
	return id as TaskId;
}

function parseCursor(value: unknown): number {
	if (value === undefined || value === null) return 0;
	if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid workflow page cursor");
	const cursor = Number(value);
	if (!Number.isSafeInteger(cursor)) throw new Error("Invalid workflow page cursor");
	return cursor;
}

function parsePageLimit(value: unknown): number {
	if (value === undefined) return WORKFLOW_OWNER_PAGE_SIZE;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > WORKFLOW_OWNER_PAGE_SIZE)
		throw new Error("Invalid workflow page limit");
	return value;
}

function parseReadOffset(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid workflow archive offset");
	return value;
}

function parseReadLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error("Invalid workflow archive chunk size");
	return value;
}

export function isDestination(value: unknown): value is WorkflowReceiptDestination {
	return (
		isWorkflowJsonObject(value) &&
		typeof value.sessionFile === "string" &&
		value.sessionFile.startsWith("/") &&
		typeof value.sessionId === "string" &&
		value.sessionId.length > 0 &&
		typeof value.originEntryId === "string" &&
		value.originEntryId.length > 0
	);
}

function isAcknowledgment(value: unknown): value is WorkflowReceiptAcknowledgment {
	return (
		isWorkflowJsonObject(value) &&
		typeof value.eventId === "string" &&
		typeof value.digest === "string" &&
		/^[0-9a-f]{64}$/.test(value.digest) &&
		typeof value.entryId === "string" &&
		value.entryId.length > 0 &&
		isDestination(value.destination)
	);
}
