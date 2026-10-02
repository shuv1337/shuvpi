import { createHash } from "node:crypto";
import { copyJson, type Draft, type JsonValue } from "@shuv1337/shuvpi-chord";
import {
	type ConversationId,
	defineDocFamily,
	type JsonObject,
	type Task,
	type TaskId,
	type TaskOptions,
	type Tx,
} from "@shuv1337/shuvpi-durable";
import { isWorkflowJsonValue, type WorkflowJsonObject, type WorkflowJsonValue } from "./protocol.ts";
import {
	type WorkflowReceiptAcknowledgment,
	type WorkflowReceiptDestination,
	type WorkflowReceiptEvent,
	workflowReceiptDigest,
} from "./receipt.ts";
import type { WorkflowTaskInput, WorkflowTaskSettlement } from "./runner.ts";

export type WorkflowRunStatus = "running" | "completed" | "failed" | "aborted";

export type WorkflowOutboxStatus = "not_queued" | "pending" | "persisted" | "blocked";

export interface WorkflowRunReceiptState extends JsonObject {
	status: WorkflowOutboxStatus;
	eventId: string | null;
	route: "foreground" | "background" | null;
	destination: JsonValue;
	acknowledgment: JsonValue;
	error: string | null;
}

export interface WorkflowRunArchive extends JsonObject {
	runId: string;
	taskId: TaskId;
	conversationId: ConversationId;
	status: WorkflowRunStatus;
	result: JsonValue;
	error: string | null;
	journal: JsonValue;
	receipt: WorkflowRunReceiptState;
}

interface WorkflowRequestBinding extends JsonObject {
	requestId: string;
	taskId: TaskId | null;
	bindingDigest: string;
}

export const WorkflowRunArchiveDoc = defineDocFamily<WorkflowRunArchive, string>({
	kind: "coding-agent.workflow-run-archive",
	version: 1,
	scope: "session",
	family: true,
	initial: (runId) => ({
		runId,
		taskId: 0 as TaskId,
		conversationId: 0 as ConversationId,
		status: "running",
		result: null,
		error: null,
		journal: {
			sourceDigest: "",
			argumentsDigest: "",
			status: "running",
			error: "",
			nextCompletionOrder: 0,
			operations: [],
			races: [],
		},
		receipt: {
			status: "not_queued",
			eventId: null,
			route: null,
			destination: null,
			acknowledgment: null,
			error: null,
		},
	}),
});

/** Create a workflow root once per caller request ID and archive its stable task ID in the same transaction. */
export async function createWorkflowTaskOnce<H extends object>(
	tx: Tx,
	task: Task<WorkflowTaskInput, { phase: "run" }, WorkflowJsonValue, H>,
	input: WorkflowTaskInput,
	conversationId: ConversationId,
	requestId: string,
	options: TaskOptions,
): Promise<{ taskId: TaskId<WorkflowJsonValue>; created: boolean }> {
	if (!requestId || requestId.length > 256) throw new TypeError("Workflow request ID must be 1 to 256 characters");
	if (options.conversationId !== undefined && options.conversationId !== conversationId)
		throw new Error("Workflow archive conversation does not match task ownership");
	const requestKey = createHash("sha256").update(requestId).digest("hex");
	const bindingDigest = digestWorkflowJson({
		input: { source: input.source, args: input.args, agent: input.agent ?? null },
		conversationId,
		options: {
			ownership:
				options.ownership.kind === "task"
					? { kind: "task", taskId: Number(options.ownership.taskId) }
					: { kind: "conversation" },
			conversationId: options.conversationId === undefined ? null : Number(options.conversationId),
			background: options.background ?? null,
		},
	});
	const request = await tx.doc(WorkflowRequestByIdDoc, requestKey, requestId);
	if (request.requestId && request.requestId !== requestId) throw new Error("Workflow request ID hash collision");
	if (request.taskId !== null) {
		if (request.bindingDigest !== bindingDigest)
			throw new Error("Workflow request ID was already used with different input or ownership");
		return { taskId: request.taskId as TaskId<WorkflowJsonValue>, created: false };
	}
	const taskId = await tx.createTask(task, input, options);
	request.requestId = requestId;
	request.taskId = taskId;
	request.bindingDigest = bindingDigest;
	const archive = await getWorkflowRunArchive(tx, taskId);
	archive.runId = `workflow-${taskId}`;
	archive.taskId = taskId;
	archive.conversationId = conversationId;
	archive.status = "running";
	return { taskId, created: true };
}

const WorkflowRequestByIdDoc = defineDocFamily<WorkflowRequestBinding, string>({
	kind: "coding-agent.workflow-request-by-id",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ requestId: "", taskId: null, bindingDigest: "" }),
});

/** Copy the task-owned journal into durable session history before terminal cleanup retires it. */
export async function archiveWorkflowSettlement(tx: Tx, settlement: WorkflowTaskSettlement): Promise<void> {
	const archive = await getWorkflowRunArchive(tx, settlement.taskId);
	archive.runId = `workflow-${settlement.taskId}`;
	archive.taskId = settlement.taskId;
	archive.conversationId = settlement.conversationId;
	archive.status = settlement.status;
	archive.result = settlement.result === undefined ? null : copyJson(settlement.result);
	archive.error = settlement.error ?? null;
	archive.journal = copyJson(settlement.journal);
}

/** Commit a durable outbox intent before delivering the completion to its captured transcript branch. */
export async function queueWorkflowReceipt(
	tx: Tx,
	taskId: TaskId,
	route: "foreground" | "background",
	destination: WorkflowReceiptDestination,
): Promise<WorkflowReceiptEvent> {
	const archive = await getWorkflowRunArchive(tx, taskId);
	if (archive.status === "running") throw new Error("Workflow result is not settled yet");
	const eventId = `${archive.runId}:result`;
	const receipt = archive.receipt;
	if (receipt.status === "blocked")
		throw new Error("Workflow receipt is blocked; explicitly retry it before delivery");
	if (receipt.status !== "not_queued") {
		if (receipt.eventId !== eventId || receipt.route !== route || !sameDestination(receipt.destination, destination))
			throw new Error("Workflow result already has a different outbox destination");
		return workflowReceiptEvent(archive, route);
	}
	receipt.status = "pending";
	receipt.eventId = eventId;
	receipt.route = route;
	receipt.destination = copyJson(destination);
	receipt.error = null;
	return workflowReceiptEvent(archive, route);
}

/** Record only the acknowledgment that exactly matches the persisted outbox event and branch. */
export async function acknowledgeWorkflowReceipt(
	tx: Tx,
	taskId: TaskId,
	acknowledgment: WorkflowReceiptAcknowledgment,
): Promise<void> {
	const archive = await getWorkflowRunArchive(tx, taskId);
	const receipt = archive.receipt;
	if (receipt.eventId !== acknowledgment.eventId || !sameDestination(receipt.destination, acknowledgment.destination))
		throw new Error("Workflow receipt acknowledgment does not match the durable outbox");
	if (
		receipt.route === null ||
		acknowledgment.digest !==
			workflowReceiptDigest(workflowReceiptEvent(archive, receipt.route), acknowledgment.destination)
	)
		throw new Error("Workflow receipt acknowledgment digest does not match the queued event");
	if (receipt.status === "persisted") {
		if (!sameAcknowledgment(receipt.acknowledgment, acknowledgment))
			throw new Error("Workflow receipt acknowledgment changed after persistence");
		return;
	}
	if (receipt.status !== "pending") throw new Error("Workflow result has no pending receipt");
	receipt.acknowledgment = copyJson(acknowledgment);
	receipt.status = "persisted";
	receipt.error = null;
}

export async function blockWorkflowReceipt(tx: Tx, taskId: TaskId, reason: string): Promise<void> {
	const archive = await getWorkflowRunArchive(tx, taskId);
	if (archive.receipt.status !== "pending") throw new Error("Only a pending workflow receipt can be blocked");
	archive.receipt.status = "blocked";
	archive.receipt.error = reason;
}

/** Explicitly reopen a blocked delivery only for its exact captured branch and event route. */
export async function retryWorkflowReceipt(
	tx: Tx,
	taskId: TaskId,
	route: "foreground" | "background",
	destination: WorkflowReceiptDestination,
): Promise<WorkflowReceiptEvent> {
	const archive = await getWorkflowRunArchive(tx, taskId);
	const receipt = archive.receipt;
	if (
		receipt.status !== "blocked" ||
		receipt.route !== route ||
		receipt.eventId !== `${archive.runId}:result` ||
		!sameDestination(receipt.destination, destination)
	)
		throw new Error("Workflow receipt retry does not match the blocked outbox event");
	receipt.status = "pending";
	receipt.error = null;
	return workflowReceiptEvent(archive, route);
}

function getWorkflowRunArchive(tx: Tx, taskId: TaskId): Promise<Draft<WorkflowRunArchive>> {
	return tx.doc(WorkflowRunArchiveDoc, String(taskId), `workflow-${taskId}`);
}

/** Rebuild the exact event for retries from durable run history; never returns a Chord overlay. */
export function workflowReceiptEvent(
	archive: Readonly<WorkflowRunArchive>,
	route: "foreground" | "background",
): WorkflowReceiptEvent {
	return {
		eventId: `${archive.runId}:result`,
		runId: archive.runId,
		route,
		payload: copyJson({ status: archive.status, result: archive.result, error: archive.error }) as WorkflowJsonValue,
	};
}

function sameAcknowledgment(left: JsonValue, right: WorkflowReceiptAcknowledgment): boolean {
	return (
		isObject(left) &&
		left.eventId === right.eventId &&
		left.digest === right.digest &&
		left.entryId === right.entryId &&
		sameDestination(left.destination as JsonValue, right.destination)
	);
}

function digestWorkflowJson(value: WorkflowJsonValue): string {
	return createHash("sha256").update(canonicalWorkflowJson(value)).digest("hex");
}

function canonicalWorkflowJson(value: WorkflowJsonValue): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalWorkflowJson(item)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalWorkflowJson((value as WorkflowJsonObject)[key]!)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function isWorkflowTaskInput(value: unknown): value is WorkflowTaskInput {
	if (!isObject(value) || typeof value.source !== "string" || !isWorkflowJsonValue(value.args)) return false;
	if (value.agent === undefined) return true;
	if (!isObject(value.agent)) return false;
	return (
		(value.agent.model === undefined ||
			(isObject(value.agent.model) &&
				typeof value.agent.model.provider === "string" &&
				typeof value.agent.model.modelId === "string")) &&
		(value.agent.effort === undefined ||
			(typeof value.agent.effort === "string" &&
				["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value.agent.effort)))
	);
}

function sameDestination(left: JsonValue, right: WorkflowReceiptDestination): boolean {
	return (
		isObject(left) &&
		left.sessionFile === right.sessionFile &&
		left.sessionId === right.sessionId &&
		left.originEntryId === right.originEntryId
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
