import { createHash, randomUUID } from "node:crypto";
import {
	type BackgroundOwnerCommand,
	type BackgroundOwnerConnection,
	connectBackgroundWorkflowOwner,
	workflowOwnerClient,
} from "./client.ts";
import {
	isWorkflowJsonObject,
	isWorkflowJsonValue,
	WORKFLOW_OWNER_READ_CHUNK_BYTES,
	type WorkflowJsonObject,
	type WorkflowJsonValue,
	type WorkflowOwnerOperation,
} from "./protocol.ts";
import {
	attachWorkflowReceiptReceiver,
	captureWorkflowReceiptDestination,
	persistWorkflowReceipt,
	type WorkflowReceiptDestination,
	type WorkflowReceiptEvent,
	type WorkflowReceiptSession,
} from "./receipt.ts";
import type { WorkflowTaskInput } from "./runner.ts";

export interface WorkflowStart {
	input: WorkflowTaskInput;
	destination: WorkflowReceiptDestination;
	route: "foreground" | "background";
	requestId?: string;
}

export interface WorkflowRunHandle {
	runId: string;
	taskId: number;
	created: boolean;
}

/** Caller-controlled launch command works in both installed and source layouts. */
export async function connectDurableWorkflows(
	socketPath: string,
	command?: BackgroundOwnerCommand,
): Promise<DurableWorkflowConnection> {
	return new DurableWorkflowConnection(
		command ? await connectBackgroundWorkflowOwner(socketPath, command) : workflowOwnerClient(socketPath),
	);
}

export class DurableWorkflowConnection {
	readonly owner: BackgroundOwnerConnection;
	constructor(owner: BackgroundOwnerConnection) {
		this.owner = owner;
	}
	async start(request: WorkflowStart): Promise<WorkflowRunHandle> {
		const value = await this.owner.request({
			type: "start",
			input: { ...request.input },
			destination: { ...request.destination },
			route: request.route,
			requestId: request.requestId ?? randomUUID(),
		});
		if (
			!isWorkflowJsonObject(value) ||
			typeof value.runId !== "string" ||
			typeof value.taskId !== "number" ||
			typeof value.created !== "boolean"
		)
			throw new Error("Invalid workflow admission response");
		return { runId: value.runId, taskId: value.taskId, created: value.created };
	}
	async status(runId: string): Promise<WorkflowJsonValue> {
		return this.statusFromRequest({ type: "status", runId });
	}
	async list(): Promise<WorkflowJsonValue> {
		const items: WorkflowJsonValue[] = [];
		let afterTaskId = "0";
		for (;;) {
			const page = await this.owner.request({ type: "list", afterTaskId, limit: 64 });
			if (!isPage(page)) throw new Error("Invalid workflow list page");
			for (const item of page.items) {
				if (!isWorkflowJsonObject(item) || typeof item.runId !== "string")
					throw new Error("Invalid workflow list item");
				items.push(
					await hydrateArchiveWithRetry(this.owner, item, () =>
						this.owner.request({ type: "status", runId: item.runId as string }),
					),
				);
			}
			if (page.nextCursor === null) return items;
			afterTaskId = page.nextCursor;
		}
	}
	cancel(runId: string): Promise<WorkflowJsonValue> {
		return this.statusFromRequest({ type: "cancel", runId });
	}
	private async statusFromRequest(operation: WorkflowOwnerOperation): Promise<WorkflowJsonValue> {
		return hydrateArchiveWithRetry(this.owner, await this.owner.request(operation), () =>
			this.owner.request(operation),
		);
	}
}

async function hydrateArchiveWithRetry(
	owner: BackgroundOwnerConnection,
	initial: WorkflowJsonValue,
	refresh: () => Promise<WorkflowJsonValue>,
): Promise<WorkflowJsonValue> {
	let value = initial;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await hydrateArchive(owner, value);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("changed while it was being read") || attempt === 2)
				throw error;
			value = await refresh();
		}
	}
	throw new Error("Could not read a stable workflow archive");
}

async function hydrateArchive(owner: BackgroundOwnerConnection, value: WorkflowJsonValue): Promise<WorkflowJsonValue> {
	if (!isWorkflowJsonObject(value) || typeof value.runId !== "string") return value;
	let hydrated = false;
	const output: Record<string, WorkflowJsonValue> = { ...value };
	for (const section of ["result", "journal", "error"] as const) {
		const reference = value[`${section}Reference`];
		if (!isWorkflowJsonObject(reference)) continue;
		output[section] = JSON.parse(
			await readArchiveSection(owner, value.runId, section, reference),
		) as WorkflowJsonValue;
		delete output[`${section}Reference`];
		hydrated = true;
	}
	return hydrated ? output : value;
}

interface WorkflowPage extends WorkflowJsonObject {
	items: readonly WorkflowJsonValue[];
	nextCursor: string | null;
}

function isPage(value: WorkflowJsonValue): value is WorkflowPage {
	return (
		isWorkflowJsonObject(value) &&
		Array.isArray(value.items) &&
		(value.nextCursor === null || typeof value.nextCursor === "string")
	);
}

async function readArchiveSection(
	owner: BackgroundOwnerConnection,
	runId: string,
	section: "result" | "journal" | "error",
	reference: WorkflowJsonObject,
): Promise<string> {
	if (
		reference.section !== section ||
		typeof reference.bytes !== "number" ||
		!Number.isSafeInteger(reference.bytes) ||
		reference.bytes < 0 ||
		typeof reference.digest !== "string" ||
		!/^[0-9a-f]{64}$/.test(reference.digest)
	)
		throw new Error("Invalid workflow archive reference");
	const chunks: Buffer[] = [];
	let offset = 0;
	while (offset < reference.bytes) {
		const value = await owner.request({
			type: "read",
			runId,
			section,
			offset,
			limit: WORKFLOW_OWNER_READ_CHUNK_BYTES,
			totalBytes: reference.bytes,
			digest: reference.digest,
		});
		if (
			!isWorkflowJsonObject(value) ||
			value.section !== section ||
			value.offset !== offset ||
			value.totalBytes !== reference.bytes ||
			value.digest !== reference.digest ||
			typeof value.data !== "string" ||
			(value.nextOffset !== null && typeof value.nextOffset !== "number")
		)
			throw new Error("Invalid workflow archive chunk");
		const chunk = Buffer.from(value.data, "base64");
		if (chunk.byteLength === 0 || chunk.byteLength > WORKFLOW_OWNER_READ_CHUNK_BYTES)
			throw new Error("Invalid workflow archive chunk size");
		chunks.push(chunk);
		offset += chunk.byteLength;
		if (value.nextOffset !== (offset < reference.bytes ? offset : null))
			throw new Error("Workflow archive chunk cursor did not advance");
	}
	const bytes = Buffer.concat(chunks);
	if (bytes.byteLength !== reference.bytes || createHash("sha256").update(bytes).digest("hex") !== reference.digest)
		throw new Error("Workflow archive reference digest did not match");
	return bytes.toString("utf8");
}

/** Drain into the currently attached branch, then acknowledge only disk-verified entries. Safe to retry after reconnect. */
export async function drainWorkflowReceipts(
	connection: DurableWorkflowConnection,
	session: WorkflowReceiptSession,
): Promise<{ persisted: number; pending: number; reasons: string[] }> {
	const active = captureWorkflowReceiptDestination(session);
	const receiver = attachWorkflowReceiptReceiver(session);
	const result = { persisted: 0, pending: 0, reasons: [] as string[] };
	try {
		let afterTaskId = "0";
		for (;;) {
			const page = await connection.owner.request({ type: "receipts", afterTaskId, limit: 1 });
			if (!isPage(page)) throw new Error("Invalid workflow receipt outbox page");
			for (const value of page.items) {
				if (
					!isWorkflowJsonObject(value) ||
					!isWorkflowJsonObject(value.destination) ||
					typeof value.runId !== "string" ||
					(value.route !== "foreground" && value.route !== "background")
				)
					throw new Error("Invalid workflow outbox receipt");
				const { destination, runId, route } = value;
				if (destination.sessionFile !== active.sessionFile || destination.sessionId !== active.sessionId) continue;
				if (typeof destination.originEntryId !== "string") throw new Error("Invalid workflow outbox receipt");
				const archive = await connection.status(runId);
				if (
					!isWorkflowJsonObject(archive) ||
					typeof archive.runId !== "string" ||
					typeof archive.status !== "string" ||
					!isWorkflowJsonValue(archive.result) ||
					!(archive.error === null || typeof archive.error === "string")
				)
					throw new Error("Invalid workflow receipt archive");
				const event: WorkflowReceiptEvent = {
					eventId: `${archive.runId}:result`,
					runId: archive.runId,
					route,
					payload: { status: archive.status, result: archive.result, error: archive.error },
				};
				const delivery = persistWorkflowReceipt(
					receiver,
					{
						sessionFile: active.sessionFile,
						sessionId: active.sessionId,
						originEntryId: destination.originEntryId,
					},
					{ eventId: event.eventId, runId: event.runId, route: event.route, payload: event.payload },
				);
				if (delivery.status === "pending") {
					result.pending++;
					result.reasons.push(delivery.reason);
					continue;
				}
				// If this request loses its response, a later drain verifies the same transcript entry and resends this exact acknowledgment.
				await connection.owner.request({
					type: "ack",
					runId,
					acknowledgment: { ...delivery.acknowledgment, destination: { ...delivery.acknowledgment.destination } },
				});
				result.persisted++;
			}
			if (page.nextCursor === null) return result;
			afterTaskId = page.nextCursor;
		}
	} finally {
		receiver.close();
	}
}
