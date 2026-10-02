import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CustomMessageEntry, ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { CURRENT_SESSION_VERSION } from "../session-manager.ts";
import { isWorkflowJsonObject, isWorkflowJsonValue, type WorkflowJsonValue } from "./protocol.ts";

export const WORKFLOW_RECEIPT_TYPE = "durable-workflow-result";

/** The origin entry is the branch anchor. Descendants inherit the destination; sibling branches do not. */
export interface WorkflowReceiptDestination {
	sessionFile: string;
	sessionId: string;
	originEntryId: string;
}

export interface WorkflowReceiptEvent {
	eventId: string;
	runId: string;
	route: "foreground" | "background";
	payload: WorkflowJsonValue;
}

export interface WorkflowReceiptAcknowledgment {
	eventId: string;
	digest: string;
	entryId: string;
	destination: WorkflowReceiptDestination;
}

export type WorkflowReceiptResult =
	| { status: "persisted"; acknowledgment: WorkflowReceiptAcknowledgment }
	| { status: "pending"; reason: string };

/** Close when detaching this chat. A closed receiver can never append or acknowledge again. */
export interface WorkflowReceiptReceiver {
	close(): void;
}

export type WorkflowReceiptReadSession = Pick<
	ReadonlySessionManager,
	"getSessionFile" | "getSessionId" | "getLeafId" | "getEntries"
> & { isPersisted(): boolean };

export type WorkflowReceiptSession = WorkflowReceiptReadSession & {
	appendCustomMessageEntry<T>(customType: string, content: string, display: boolean, details: T): string;
	setSessionFile?(path: string): void;
	branch?(entryId: string | null): void;
};

interface ReceiverState {
	session: WorkflowReceiptSession;
	destination: WorkflowReceiptDestination;
	closed: boolean;
}

const receivers = new WeakMap<WorkflowReceiptReceiver, ReceiverState>();

/**
 * Exclusively attach one receipt receiver to this transcript across UI processes. The held SQLite write lock
 * survives SIGSTOP and is released by the kernel on SIGKILL. Never delete or expire its sidecar by heartbeat age.
 */
export function attachWorkflowReceiptReceiver(session: WorkflowReceiptSession): WorkflowReceiptReceiver {
	const destination = captureWorkflowReceiptDestination(session);
	const path = `${destination.sessionFile}.receipt-lock.sqlite`;
	const database = new DatabaseSync(path, { timeout: 0 });
	try {
		chmodSync(path, 0o600);
		database.exec("BEGIN IMMEDIATE");
	} catch (error) {
		database.close();
		throw new Error("Another receipt receiver holds this transcript, or its lock is unavailable", { cause: error });
	}
	const state: ReceiverState = { session, destination, closed: false };
	const receiver: WorkflowReceiptReceiver = {
		close() {
			if (state.closed) return;
			state.closed = true;
			try {
				database.exec("ROLLBACK");
			} finally {
				database.close();
			}
		},
	};
	receivers.set(receiver, state);
	return receiver;
}

function receiverState(receiver: WorkflowReceiptReceiver): ReceiverState {
	const state = receivers.get(receiver);
	if (!state || state.closed) throw new Error("Workflow receipt receiver is detached");
	assertDestination(state.session, state.destination);
	return state;
}

interface ReceiptDetails extends WorkflowReceiptEvent {
	digest: string;
	destination: WorkflowReceiptDestination;
}

interface DiskSession {
	sessionId: string;
	entries: SessionEntry[];
	byId: Map<string, SessionEntry>;
}

interface FailedAppend {
	destination: WorkflowReceiptDestination;
	previousLeafId: string;
	failedLeafId: string | null;
}

const failedAppends = new Map<string, FailedAppend>();

function receiptSessionKey(session: Pick<ReadonlySessionManager, "getSessionFile" | "getSessionId">): string {
	return `${session.getSessionFile() ?? ""}\0${session.getSessionId()}`;
}

function canonical(value: WorkflowJsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, WorkflowJsonValue>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Stable digest shared by transcript persistence and the workflow owner's durable acknowledgment. */
export function workflowReceiptDigest(event: WorkflowReceiptEvent, destination: WorkflowReceiptDestination): string {
	return createHash("sha256")
		.update(canonical({ ...event, destination: { ...destination } }))
		.digest("hex");
}

function readDiskSession(destination: WorkflowReceiptDestination): DiskSession {
	if (realpathSync(destination.sessionFile) !== destination.sessionFile) {
		throw new Error("Receipt destination path changed");
	}
	const source = readFileSync(destination.sessionFile, "utf8");
	if (!source.endsWith("\n")) throw new Error("Session has an incomplete final line; repair it before reconciliation");
	const records: unknown[] = source
		.slice(0, -1)
		.split("\n")
		.map((line) => JSON.parse(line));
	const header = records.shift();
	if (
		!header ||
		typeof header !== "object" ||
		!("type" in header) ||
		header.type !== "session" ||
		!("id" in header) ||
		header.id !== destination.sessionId ||
		!("version" in header) ||
		header.version !== CURRENT_SESSION_VERSION
	) {
		throw new Error("Receipt destination session header does not match");
	}
	const byId = new Map<string, SessionEntry>();
	for (const record of records) {
		if (
			!record ||
			typeof record !== "object" ||
			!("type" in record) ||
			typeof record.type !== "string" ||
			record.type === "session" ||
			!("id" in record) ||
			typeof record.id !== "string" ||
			byId.has(record.id) ||
			!("parentId" in record) ||
			(record.parentId !== null && (typeof record.parentId !== "string" || !byId.has(record.parentId)))
		) {
			throw new Error("Session has an invalid entry or parent chain");
		}
		byId.set(record.id, record as SessionEntry);
	}
	if (!byId.has(destination.originEntryId)) throw new Error("Receipt origin is missing from disk");
	return { sessionId: destination.sessionId, entries: [...byId.values()], byId };
}

function isAncestor(disk: DiskSession, ancestor: string, leaf: string | null): boolean {
	let current = leaf;
	while (current) {
		if (current === ancestor) return true;
		current = disk.byId.get(current)?.parentId ?? null;
	}
	return false;
}

function assertDestination(
	session: Pick<ReadonlySessionManager, "getSessionFile" | "getSessionId"> & { isPersisted(): boolean },
	destination: WorkflowReceiptDestination,
): void {
	const file = session.getSessionFile();
	if (
		!session.isPersisted() ||
		!file ||
		session.getSessionId() !== destination.sessionId ||
		realpathSync(file) !== destination.sessionFile
	) {
		throw new Error("The originating session is not attached; result remains pending");
	}
}

/** Capture only an established disk-backed chat. Setup-only and in-memory sessions cannot receive receipts. */
export function captureWorkflowReceiptDestination(session: WorkflowReceiptReadSession): WorkflowReceiptDestination {
	const file = session.getSessionFile();
	const originEntryId = session.getLeafId();
	if (!session.isPersisted() || !file || !originEntryId) throw new Error("A persisted chat is required");
	if (failedAppends.has(receiptSessionKey(session))) throw new Error("Session needs explicit receipt reconciliation");
	const destination = { sessionFile: realpathSync(file), sessionId: session.getSessionId(), originEntryId };
	const disk = readDiskSession(destination);
	if (
		!disk.entries.some(
			(entry) =>
				entry.type === "message" &&
				(entry.message.role === "user" || entry.message.role === "assistant") &&
				isAncestor(disk, entry.id, originEntryId),
		)
	) {
		throw new Error("A persisted chat is required");
	}
	if (JSON.stringify(session.getEntries()) !== JSON.stringify(disk.entries))
		throw new Error("Session memory differs from disk");
	return destination;
}

/**
 * Append once, then prove the displayed entry exists on the destination branch on disk before acknowledging.
 * The chat process owns its SessionManager; the background owner queues events and never writes the chat file.
 * This does not start a model turn or claim the user has seen the result.
 */
export function persistWorkflowReceipt(
	receiver: WorkflowReceiptReceiver,
	destination: WorkflowReceiptDestination,
	event: WorkflowReceiptEvent,
): WorkflowReceiptResult {
	let session: WorkflowReceiptSession | undefined;
	let previousLeafId: string | null = null;
	let appendStarted = false;
	try {
		const attachment = receiverState(receiver);
		session = attachment.session;
		if (
			attachment.destination.sessionFile !== destination.sessionFile ||
			attachment.destination.sessionId !== destination.sessionId
		)
			throw new Error("Receipt does not belong to this attached session");
		if (failedAppends.has(receiptSessionKey(session)))
			return { status: "pending", reason: "Session needs explicit receipt reconciliation" };
		if (!event.eventId || !event.runId || !isWorkflowJsonValue(event.payload))
			throw new Error("Invalid workflow receipt event");
		assertDestination(session, destination);
		const disk = readDiskSession(destination);
		previousLeafId = session.getLeafId();
		if (!isAncestor(disk, destination.originEntryId, previousLeafId))
			throw new Error("The originating branch is not attached; result remains pending");
		if (JSON.stringify(session.getEntries()) !== JSON.stringify(disk.entries))
			throw new Error("Session memory differs from disk; reconcile before delivery");
		const digest = workflowReceiptDigest(event, destination);
		const status =
			isWorkflowJsonObject(event.payload) &&
			(event.payload.status === "completed" ||
				event.payload.status === "failed" ||
				event.payload.status === "aborted")
				? event.payload.status
				: "completed";
		const content = `Workflow ${event.runId} ${status}\n${JSON.stringify(JSON.parse(canonical(event.payload)), null, 2)}`;
		const expectedDetails = canonical({ ...event, digest, destination: { ...destination } });
		const existing = disk.entries.filter(
			(entry): entry is CustomMessageEntry<ReceiptDetails> =>
				entry.type === "custom_message" &&
				entry.customType === WORKFLOW_RECEIPT_TYPE &&
				!!entry.details &&
				typeof entry.details === "object" &&
				"eventId" in entry.details &&
				entry.details.eventId === event.eventId,
		);
		if (existing.length > 1) throw new Error("Duplicate persisted workflow event requires reconciliation");
		let entryId = existing[0]?.id;
		if (existing[0]) {
			const entry = existing[0];
			if (entry.details?.digest !== digest || entry.content !== content || !entry.display)
				throw new Error("Workflow event identity conflicts with persisted result");
			if (!isAncestor(disk, destination.originEntryId, entry.id) || !isAncestor(disk, entry.id, previousLeafId)) {
				throw new Error("Persisted result is not visible on the attached branch");
			}
		} else {
			appendStarted = true;
			entryId = session.appendCustomMessageEntry(WORKFLOW_RECEIPT_TYPE, content, true, JSON.parse(expectedDetails));
		}
		// fsync is part of receipt persistence; a close/append return alone is not a durable acknowledgment.
		const fd = openSync(destination.sessionFile, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		const verified = readDiskSession(destination);
		const entry = entryId ? verified.byId.get(entryId) : undefined;
		if (
			!entry ||
			entry.type !== "custom_message" ||
			entry.customType !== WORKFLOW_RECEIPT_TYPE ||
			entry.content !== content ||
			!entry.display ||
			!isWorkflowJsonValue(entry.details) ||
			canonical(entry.details) !== expectedDetails ||
			!isAncestor(verified, destination.originEntryId, entry.id) ||
			!isAncestor(verified, entry.id, session.getLeafId())
		) {
			throw new Error("Workflow receipt was not verified on disk");
		}
		return {
			status: "persisted",
			acknowledgment: { eventId: event.eventId, digest, entryId: entry.id, destination },
		};
	} catch (error) {
		if (appendStarted && previousLeafId && session)
			failedAppends.set(receiptSessionKey(session), {
				destination: { ...destination },
				previousLeafId,
				failedLeafId: session.getLeafId(),
			});
		return { status: "pending", reason: error instanceof Error ? error.message : String(error) };
	}
}

/** Explicitly discard only the uncertain append after verifying the original file, preserving the active branch. */
export function reconcileWorkflowReceiptSession(receiver: WorkflowReceiptReceiver): void {
	const { session } = receiverState(receiver);
	const key = receiptSessionKey(session);
	const failed = failedAppends.get(key);
	if (!failed) return;
	assertDestination(session, failed.destination);
	const disk = readDiskSession(failed.destination);
	if (session.getLeafId() !== failed.failedLeafId)
		throw new Error("Session advanced after the failed append; reconcile it manually");
	const leaf = failed.failedLeafId && disk.byId.has(failed.failedLeafId) ? failed.failedLeafId : failed.previousLeafId;
	if (!isAncestor(disk, failed.destination.originEntryId, leaf)) throw new Error("The destination branch is missing");
	// Strict validation above prevents the normal session loader from silently repairing torn JSONL or migrating it.
	if (!session.setSessionFile || !session.branch)
		throw new Error("This receipt receiver does not expose explicit reconciliation controls");
	session.setSessionFile(failed.destination.sessionFile);
	session.branch(leaf);
	failedAppends.delete(key);
}
