import { createHash, randomBytes } from "node:crypto";
import type { Context, JsonValue } from "@shuv1337/shuvpi-chord";
import type { JsonObject, TaskId, TaskRuntime, Tx } from "@shuv1337/shuvpi-durable";
import { defineDoc } from "@shuv1337/shuvpi-durable";
import { isWorkflowJsonObject, isWorkflowJsonValue, type WorkflowJsonValue } from "./protocol.ts";

export type WorkflowOperationKind = "phase" | "agent";
export type WorkflowJournalStatus = "running" | "blocked" | "completed" | "failed" | "aborted";

export interface WorkflowOperationRecord extends JsonObject {
	readonly index: number;
	readonly kind: WorkflowOperationKind;
	readonly callSite: string;
	readonly argumentsDigest: string;
	readonly taskId: TaskId | null;
	readonly status: "started" | "settled";
	readonly completionOrder: number | null;
	readonly logicalTimeMs: number | null;
	readonly result: JsonValue | null;
}

export interface WorkflowRaceRecord extends JsonObject {
	readonly index: number;
	readonly callSite: string;
	readonly candidates: number[];
	readonly winner: number;
	readonly logicalTimeMs: number;
}

export interface WorkflowJournalState extends JsonObject {
	sourceDigest: string;
	argumentsDigest: string;
	seed: number | null;
	initialTimeMs: number | null;
	logicalTimeMs: number | null;
	status: WorkflowJournalStatus;
	error: string;
	nextCompletionOrder: number;
	operations: WorkflowOperationRecord[];
	races: WorkflowRaceRecord[];
}

export interface WorkflowOperationIdentity {
	readonly index: number;
	readonly kind: WorkflowOperationKind;
	readonly callSite: string;
	readonly arguments: WorkflowJsonValue;
}

export type WorkflowOperationAdmission =
	| { readonly kind: "existing"; readonly operation: WorkflowOperationRecord }
	| { readonly kind: "created"; readonly operation: WorkflowOperationRecord };

export class WorkflowReplayDivergenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowReplayDivergenceError";
	}
}

/** Task-owned journal for one workflow run. Its owner task and all child work survive UI detach. */
export const WorkflowJournalDoc = defineDoc<WorkflowJournalState>({
	kind: "pi.workflow.journal",
	version: 1,
	scope: "task",
	initial: () => ({
		sourceDigest: "",
		argumentsDigest: "",
		seed: null,
		initialTimeMs: null,
		logicalTimeMs: null,
		status: "running",
		error: "",
		nextCompletionOrder: 0,
		operations: [],
		races: [],
	}),
});

/** Bind a journal to exact source and arguments before the first child effect is created. */
export async function bindWorkflowJournal<I, S extends { phase: string }, R, H extends object>(
	taskId: TaskId,
	runtime: Pick<TaskRuntime<I, S, R, H>, "commit">,
	source: string,
	argumentsValue: WorkflowJsonValue,
	context: Context,
): Promise<void> {
	const sourceDigest = digest(source);
	const argumentsDigest = digestJson(argumentsValue);
	let diverged = false;
	await runtime.commit(async (tx) => {
		const journal = await tx.doc(WorkflowJournalDoc, taskId);
		if (journal.sourceDigest === "" && journal.argumentsDigest === "" && journal.operations.length === 0) {
			journal.sourceDigest = sourceDigest;
			journal.argumentsDigest = argumentsDigest;
			journal.seed = randomBytes(4).readUInt32BE(0);
			journal.initialTimeMs = Date.now();
			journal.logicalTimeMs = journal.initialTimeMs;
			return undefined;
		}
		if (journal.sourceDigest !== sourceDigest || journal.argumentsDigest !== argumentsDigest) {
			journal.status = "blocked";
			journal.error = "Workflow source or arguments changed since this run was admitted";
			diverged = true;
		}
		return undefined;
	}, context);
	if (diverged)
		throw new WorkflowReplayDivergenceError("Workflow source or arguments changed since this run was admitted");
}

/** Atomically record an operation and create its child task; replay returns the original task ID. */
export async function admitWorkflowOperation<I, S extends { phase: string }, R, H extends object>(
	taskId: TaskId,
	runtime: Pick<TaskRuntime<I, S, R, H>, "commit">,
	identity: WorkflowOperationIdentity,
	createChild: (tx: Tx) => Promise<TaskId | null>,
	context: Context,
): Promise<WorkflowOperationAdmission> {
	if (!Number.isSafeInteger(identity.index) || identity.index < 0 || !identity.callSite)
		throw new TypeError("Workflow operation identity is invalid");
	if (!isWorkflowJsonValue(identity.arguments)) throw new TypeError("Workflow operation arguments must be JSON");
	const argumentsDigest = digestJson(identity.arguments);
	let result: WorkflowOperationAdmission | undefined;
	await commitJournal(
		runtime,
		taskId,
		async (tx) => {
			const journal = await tx.doc(WorkflowJournalDoc, taskId);
			if (journal.status !== "running")
				throw new WorkflowReplayDivergenceError(`Workflow journal is ${journal.status}`);
			if (journal.sourceDigest === "" || journal.argumentsDigest === "")
				throw new WorkflowReplayDivergenceError("Workflow journal identity must be bound before child work starts");
			const previous = journal.operations[identity.index];
			if (previous !== undefined) {
				assertSameOperation(previous, identity, argumentsDigest);
				result = { kind: "existing", operation: copyWorkflowOperation(previous) };
				return undefined;
			}
			if (journal.operations.length !== identity.index)
				throw new WorkflowReplayDivergenceError("Workflow operation order diverged");
			const child = await createChild(tx);
			const operation: WorkflowOperationRecord = {
				index: identity.index,
				kind: identity.kind,
				callSite: identity.callSite,
				argumentsDigest,
				taskId: child,
				status: "started",
				completionOrder: null,
				logicalTimeMs: null,
				result: null,
			};
			journal.operations.push(operation);
			result = { kind: "created", operation };
			return undefined;
		},
		context,
	);
	if (result === undefined) throw new Error("Workflow operation admission did not produce a record");
	return result;
}

/** Persist a child outcome once, assigning the durable order used to reproduce Promise.race. */
export async function settleWorkflowOperation<I, S extends { phase: string }, R, H extends object>(
	taskId: TaskId,
	runtime: Pick<TaskRuntime<I, S, R, H>, "commit">,
	index: number,
	value: WorkflowJsonValue,
	context: Context,
): Promise<WorkflowOperationRecord> {
	if (!isWorkflowJsonValue(value)) throw new TypeError("Workflow operation result must be JSON");
	let result: WorkflowOperationRecord | undefined;
	await commitJournal(
		runtime,
		taskId,
		async (tx) => {
			const journal = await tx.doc(WorkflowJournalDoc, taskId);
			const operation = journal.operations[index];
			if (operation === undefined)
				throw new WorkflowReplayDivergenceError(`Workflow operation ${index} was not admitted`);
			if (operation.status === "settled") {
				if (digestJson(operation.result) !== digestJson(value))
					throw new WorkflowReplayDivergenceError(`Workflow operation ${index} returned a different result`);
				result = copyWorkflowOperation(operation);
				return undefined;
			}
			const settled: WorkflowOperationRecord = {
				...operation,
				status: "settled",
				completionOrder: journal.nextCompletionOrder,
				logicalTimeMs: nextLogicalTime(journal.logicalTimeMs),
				result: copyWorkflowJson(value),
			};
			journal.operations[index] = settled;
			journal.logicalTimeMs = settled.logicalTimeMs;
			journal.nextCompletionOrder++;
			result = settled;
			return undefined;
		},
		context,
	);
	if (result === undefined) throw new Error("Workflow operation settlement did not produce a record");
	return result;
}

/** Persist Promise.race's winner once; later replays must use it even if ready child order changes. */
export async function recordWorkflowRace<I, S extends { phase: string }, R, H extends object>(
	taskId: TaskId,
	runtime: Pick<TaskRuntime<I, S, R, H>, "commit">,
	index: number,
	callSite: string,
	candidates: readonly number[],
	winner: number,
	context: Context,
): Promise<{ winner: number; logicalTimeMs: number }> {
	if (!candidates.includes(winner) || new Set(candidates).size !== candidates.length)
		throw new TypeError("Workflow race candidates or winner are invalid");
	let result: { winner: number; logicalTimeMs: number } | undefined;
	await commitJournal(
		runtime,
		taskId,
		async (tx) => {
			const journal = await tx.doc(WorkflowJournalDoc, taskId);
			const previous = journal.races[index];
			if (previous !== undefined) {
				if (previous.callSite !== callSite || JSON.stringify(previous.candidates) !== JSON.stringify(candidates))
					throw new WorkflowReplayDivergenceError(`Workflow race ${index} diverged`);
				result = { winner: previous.winner, logicalTimeMs: previous.logicalTimeMs };
				return undefined;
			}
			if (journal.races.length !== index) throw new WorkflowReplayDivergenceError("Workflow race order diverged");
			const logicalTimeMs = nextLogicalTime(journal.logicalTimeMs);
			journal.races.push({ index, callSite, candidates: [...candidates], winner, logicalTimeMs });
			journal.logicalTimeMs = logicalTimeMs;
			result = { winner, logicalTimeMs };
			return undefined;
		},
		context,
	);
	if (result === undefined) throw new Error("Workflow race did not produce a winner");
	return result;
}

function nextLogicalTime(previous: number | null): number {
	return Math.max(Date.now(), (previous ?? 0) + 1);
}

export async function readWorkflowJournal<I, S extends { phase: string }, R, H extends object>(
	taskId: TaskId,
	runtime: Pick<TaskRuntime<I, S, R, H>, "snapshot">,
	context: Context,
): Promise<WorkflowJournalState | undefined> {
	return await runtime.snapshot(WorkflowJournalDoc, taskId, context);
}

function assertSameOperation(
	previous: WorkflowOperationRecord,
	identity: WorkflowOperationIdentity,
	argumentsDigest: string,
): void {
	if (
		previous.index !== identity.index ||
		previous.kind !== identity.kind ||
		previous.callSite !== identity.callSite ||
		previous.argumentsDigest !== argumentsDigest
	)
		throw new WorkflowReplayDivergenceError(`Workflow operation ${identity.index} changed during replay`);
}

/** A failed journal transaction rolls back, so persist divergence in a follow-up transaction. */
async function commitJournal<I, S extends { phase: string }, R, H extends object, T>(
	runtime: Pick<TaskRuntime<I, S, R, H>, "commit">,
	taskId: TaskId,
	operation: (tx: Tx) => Promise<T | undefined>,
	context: Context,
): Promise<T | undefined> {
	try {
		let result: T | undefined;
		await runtime.commit(async (tx) => {
			result = await operation(tx);
			return undefined;
		}, context);
		return result;
	} catch (error) {
		if (!(error instanceof WorkflowReplayDivergenceError)) throw error;
		await runtime.commit(async (tx) => {
			const journal = await tx.doc(WorkflowJournalDoc, taskId);
			journal.status = "blocked";
			journal.error = error.message;
		}, context);
		throw error;
	}
}

function copyWorkflowJson(value: WorkflowJsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(copyWorkflowJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, copyWorkflowJson(member)]));
	}
	return value;
}

function copyWorkflowOperation(operation: WorkflowOperationRecord): WorkflowOperationRecord {
	return {
		index: operation.index,
		kind: operation.kind,
		callSite: operation.callSite,
		argumentsDigest: operation.argumentsDigest,
		taskId: operation.taskId,
		status: operation.status,
		completionOrder: operation.completionOrder,
		logicalTimeMs: operation.logicalTimeMs,
		result: operation.result === null ? null : copyWorkflowJson(operation.result),
	};
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function digestJson(value: WorkflowJsonValue): string {
	return digest(canonicalJson(value));
}

function canonicalJson(value: WorkflowJsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isWorkflowJsonObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
