import { type Context, copyJson } from "@shuv1337/shuvpi-chord";
import { CodemodeSandbox, loadQuickJSWasm } from "@shuv1337/shuvpi-codemode";
import {
	bindToolEffectScope,
	type ConversationId,
	defineTask,
	type SettledTask,
	type Task,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "@shuv1337/shuvpi-durable";
import { getCodemodeWorkerSpecifier, getQuickJSWasmPath } from "../../config.ts";
import {
	admitWorkflowOperation,
	bindWorkflowJournal,
	readWorkflowJournal,
	recordWorkflowRace,
	settleWorkflowOperation,
	WorkflowJournalDoc,
	type WorkflowJournalState,
	type WorkflowOperationRecord,
	WorkflowReplayDivergenceError,
} from "./journal.ts";
import {
	isWorkflowJsonObject,
	isWorkflowJsonValue,
	type WorkflowJsonObject,
	type WorkflowJsonValue,
} from "./protocol.ts";

export interface WorkflowTaskInput {
	source: string;
	args: WorkflowJsonValue;
	/** Model and effort captured from the caller before the detached run starts. */
	agent?: WorkflowJsonObject;
}

export interface WorkflowAgentResult {
	ok: boolean;
	output: string;
	structured?: WorkflowJsonValue;
	error?: string;
}

export interface WorkflowChildRequest {
	workflowTaskId: TaskId;
	index: number;
	prompt: string;
	options: WorkflowJsonObject;
	defaults?: WorkflowJsonObject;
}

export interface WorkflowTaskHost {
	/** Create an owned child inside this transaction; never launch work outside the transaction. */
	createChild(tx: Tx, request: WorkflowChildRequest): Promise<TaskId>;
	/** Read the already committed child outcome. No provider calls or external effects. */
	readChildResult(task: SettledTask<unknown>, context: Context): Promise<WorkflowAgentResult>;
	/** Save an archive in the same terminal commit, before task-scoped documents retire. */
	onSettled?(tx: Tx, record: WorkflowTaskSettlement): void | Promise<void>;
}

export interface WorkflowTaskSettlement {
	taskId: TaskId;
	conversationId: ConversationId;
	status: "completed" | "failed" | "aborted";
	result?: WorkflowJsonValue;
	error?: string;
	journal: WorkflowJournalState;
}

type Runtime = TaskRuntime<WorkflowTaskInput, { phase: "run" }, WorkflowJsonValue, object>;

/** Installed task handler; generated orchestration runs only in the QuickJS worker. */
export function createWorkflowTask(
	host: WorkflowTaskHost,
): Task<WorkflowTaskInput, { phase: "run" }, WorkflowJsonValue, object> {
	return defineTask<WorkflowTaskInput, { phase: "run" }, WorkflowJsonValue>({
		name: "pi.workflow",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				try {
					const value = await executeWorkflow(task.input, runtime, host, context);
					await runtime.commit(async (tx) => {
						const journal = await tx.doc(WorkflowJournalDoc, runtime.taskId);
						journal.status = "completed";
						await host.onSettled?.(tx, {
							taskId: runtime.taskId,
							conversationId: runtime.conversationId,
							status: "completed",
							result: value,
							journal: copyJson(journal) as WorkflowJournalState,
						});
						return { status: "terminal", outcome: { status: "completed", result: value } };
					}, context);
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					const message = error instanceof Error ? error.message : String(error);
					await runtime.commit(async (tx) => {
						const journal = await tx.doc(WorkflowJournalDoc, runtime.taskId);
						if (journal.status !== "blocked") journal.status = "failed";
						journal.error = message;
						await host.onSettled?.(tx, {
							taskId: runtime.taskId,
							conversationId: runtime.conversationId,
							status: "failed",
							error: message,
							journal: copyJson(journal) as WorkflowJournalState,
						});
						return { status: "terminal", outcome: { status: "failed", error: { message } } };
					}, context);
				}
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const journal = await tx.doc(WorkflowJournalDoc, runtime.taskId);
				journal.status = "aborted";
				await host.onSettled?.(tx, {
					taskId: runtime.taskId,
					conversationId: runtime.conversationId,
					status: "aborted",
					journal: copyJson(journal) as WorkflowJournalState,
				});
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});
}

async function executeWorkflow(
	input: WorkflowTaskInput,
	runtime: Runtime,
	host: WorkflowTaskHost,
	context: Context,
): Promise<WorkflowJsonValue> {
	if (typeof input.source !== "string" || Buffer.byteLength(input.source) > 512 * 1024)
		throw new Error("Workflow source exceeds the 512 KiB limit");
	if (!isWorkflowJsonValue(input.args) || Buffer.byteLength(JSON.stringify(input.args)) > 256 * 1024)
		throw new Error("Workflow arguments must be JSON within 256 KiB");
	await runtime.commit(async (tx) => {
		await bindToolEffectScope(tx, runtime.taskId);
		return undefined;
	}, context);
	await bindWorkflowJournal(
		runtime.taskId,
		runtime,
		input.source,
		{ args: input.args, agent: input.agent ?? null },
		context,
	);
	const initial = (await readWorkflowJournal(runtime.taskId, runtime, context))!;
	const replayOrder = initial.operations
		.filter((operation) => operation.status === "settled")
		.sort((a, b) => a.completionOrder! - b.completionOrder!)
		.map((operation) => operation.index);
	let replayCursor = 0;
	let operationCount = 0;
	let raceCount = 0;
	let active = 0;
	let fatal: Error | undefined;
	let admission: Promise<void> = Promise.resolve();
	const available: (() => void)[] = [];
	const ready = new Map<number, { record: WorkflowOperationRecord; resolve(value: WorkflowJsonValue): void }>();
	const controller = new AbortController();
	const signal = AbortSignal.any([runtime.signal, controller.signal]);
	const fail = (error: unknown): never => {
		fatal = error instanceof Error ? error : new Error(String(error));
		controller.abort(fatal);
		for (const wake of available.splice(0)) wake();
		throw fatal;
	};
	const deliver = () => {
		while (replayCursor < replayOrder.length) {
			const next = ready.get(replayOrder[replayCursor]!);
			if (!next) return;
			ready.delete(next.record.index);
			replayCursor++;
			next.resolve({ value: next.record.result, logicalTimeMs: next.record.logicalTimeMs! });
		}
		for (const next of [...ready.values()].sort((a, b) => a.record.completionOrder! - b.record.completionOrder!)) {
			ready.delete(next.record.index);
			next.resolve({ value: next.record.result, logicalTimeMs: next.record.logicalTimeMs! });
		}
	};
	const sandbox = new CodemodeSandbox({
		tools: [],
		globals: [
			{
				name: "workflowOperation",
				execute: async (value) => {
					try {
						if (
							!isWorkflowJsonObject(value) ||
							!Number.isSafeInteger(value.index) ||
							typeof value.callSite !== "string"
						)
							throw new WorkflowReplayDivergenceError("Invalid workflow operation identity");
						const { index, callSite, kind } = value;
						if (typeof index !== "number" || (kind !== "agent" && kind !== "phase"))
							throw new WorkflowReplayDivergenceError("Invalid workflow operation kind");
						if (index !== operationCount++ || index >= 128)
							throw new WorkflowReplayDivergenceError("Workflow operation order or limit exceeded");
						if (!isWorkflowJsonObject(value.arguments)) throw new Error("Workflow arguments must be objects");
						const args = value.arguments;
						let admitted: WorkflowOperationRecord | undefined;
						const launch = admission.then(async () => {
							signal.throwIfAborted();
							if (kind === "agent" && active >= 4) await new Promise<void>((resolve) => available.push(resolve));
							signal.throwIfAborted();
							if (kind === "agent") active++;
							admitted = (
								await admitWorkflowOperation(
									runtime.taskId,
									runtime,
									{ index, kind, callSite, arguments: args },
									async (tx) => {
										if (kind === "phase") {
											if (typeof args.label !== "string" || args.label.length > 160)
												throw new Error("phase() requires a label up to 160 characters");
											return null;
										}
										if (
											typeof args.prompt !== "string" ||
											args.prompt.length > 100_000 ||
											!isWorkflowJsonObject(args.options)
										)
											throw new Error("agent() requires a prompt and JSON options");
										return host.createChild(tx, {
											workflowTaskId: runtime.taskId,
											index,
											prompt: args.prompt,
											options: args.options,
											...(input.agent === undefined ? {} : { defaults: input.agent }),
										});
									},
									context,
								)
							).operation;
						});
						admission = launch;
						await launch;
						let record = admitted!;
						if (record.status !== "settled") {
							let result: WorkflowJsonValue = null;
							if (kind === "agent") {
								const child = await runtime.waitForTask(record.taskId!, context);
								const value = await host.readChildResult(child, context);
								if (
									!isWorkflowJsonValue(value) ||
									typeof value.ok !== "boolean" ||
									typeof value.output !== "string"
								)
									throw new Error("Agent child returned an invalid structured result");
								result = value;
							}
							record = await settleWorkflowOperation(runtime.taskId, runtime, index, result, context);
						}
						if (kind === "agent") {
							active--;
							available.shift()?.();
						}
						return await new Promise<WorkflowJsonValue>((resolve) => {
							ready.set(index, { record, resolve });
							deliver();
						});
					} catch (error) {
						return fail(error);
					}
				},
			},
			{
				name: "workflowRace",
				execute: async (value) => {
					try {
						if (
							!isWorkflowJsonObject(value) ||
							value.index !== raceCount++ ||
							typeof value.callSite !== "string" ||
							!Array.isArray(value.candidates) ||
							!value.candidates.every((id) => typeof id === "number") ||
							typeof value.winner !== "number"
						)
							throw new WorkflowReplayDivergenceError("Invalid workflow race");
						return await recordWorkflowRace(
							runtime.taskId,
							runtime,
							value.index as number,
							value.callSite,
							value.candidates as number[],
							value.winner,
							context,
						);
					} catch (error) {
						return fail(error);
					}
				},
			},
		],
		timeoutMs: Number.POSITIVE_INFINITY,
		memoryLimitBytes: 128 * 1024 * 1024,
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: getCodemodeWorkerSpecifier(),
	});
	try {
		if (initial.seed === null || initial.initialTimeMs === null || initial.logicalTimeMs === null)
			throw new Error("Workflow journal is missing its recorded JavaScript runtime seed");
		const result = await sandbox.execute(workflowSource(input, initial.seed, initial.initialTimeMs), { signal });
		if (fatal) throw fatal;
		if (!result.ok) throw new Error(result.error.message);
		if (operationCount < initial.operations.length || raceCount < initial.races.length)
			throw new WorkflowReplayDivergenceError("Workflow ended before replaying its recorded operations");
		const value = result.value === undefined ? null : result.value;
		if (!isWorkflowJsonValue(value) || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
			throw new Error("Workflow result must be JSON within 1 MiB");
		return value;
	} catch (error) {
		if (error instanceof WorkflowReplayDivergenceError && !runtime.signal.aborted) {
			await runtime.commit(async (tx) => {
				const journal = await tx.doc(WorkflowJournalDoc, runtime.taskId);
				journal.status = "blocked";
				journal.error = error.message;
			}, context);
		}
		throw error;
	} finally {
		controller.abort();
		for (const wake of available.splice(0)) wake();
		await sandbox.close();
	}
}

/** The wrapper fixes nondeterministic ambient inputs and instruments operation/race identity inside QuickJS. */
function workflowSource(input: WorkflowTaskInput, seed: number, initialTimeMs: number): string {
	return `
let logicalTimeMs = ${initialTimeMs};
const NativeDate = Date;
function WorkflowDate(...values) {
  if (new.target) return new NativeDate(...(values.length === 0 ? [logicalTimeMs] : values));
  return new NativeDate(logicalTimeMs).toString();
}
WorkflowDate.prototype = NativeDate.prototype;
Object.setPrototypeOf(WorkflowDate, NativeDate);
WorkflowDate.now = () => logicalTimeMs;
Object.defineProperty(globalThis, "Date", { value: WorkflowDate, writable: false, configurable: false });
let randomState = ${seed} >>> 0;
Object.defineProperty(Math, "random", { writable: false, configurable: false, value: () => {
  let value = (randomState += 0x6D2B79F5);
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
} });
const issued = [];
let operationIndex = 0;
let raceIndex = 0;
const callSite = () => String(new Error().stack).split("\\n").slice(2).join("\\n");
const invoke = (kind, args, site) => {
  const index = operationIndex++;
  const promise = workflowOperation({ index, kind, callSite: site, arguments: args }).then((boundary) => {
    if (typeof boundary?.logicalTimeMs !== "number" || !("value" in boundary)) throw new Error("Invalid workflow boundary clock");
    logicalTimeMs = Math.max(logicalTimeMs, boundary.logicalTimeMs);
    return boundary.value;
  });
  issued.push(promise);
  return promise;
};
const agent = (prompt, options = {}) => invoke("agent", { prompt, options }, callSite());
const phase = (label) => invoke("phase", { label }, callSite());
Object.defineProperty(Promise, "race", { configurable: false, writable: false, value: (iterable) => {
  const promises = Array.from(iterable, (value) => Promise.resolve(value));
  const candidates = promises.map((_, index) => index);
  const index = raceIndex++;
  const site = callSite();
  return new Promise((resolve, reject) => {
    let claimed = false;
    const claim = async (position) => {
      if (claimed) return;
      claimed = true;
      try {
        const boundary = await workflowRace({ index, callSite: site, candidates, winner: candidates[position] });
        if (typeof boundary?.logicalTimeMs !== "number" || typeof boundary.winner !== "number") throw new Error("Invalid workflow race clock");
        logicalTimeMs = Math.max(logicalTimeMs, boundary.logicalTimeMs);
        promises[boundary.winner].then(resolve, reject);
      } catch (error) { reject(error); }
    };
    promises.forEach((promise, position) => promise.then(() => claim(position), () => claim(position)));
  });
} });
const args = ${JSON.stringify(input.args)};
const result = await (async (args, agent, phase) => {
${input.source}
})(args, agent, phase);
await Promise.all(issued);
return result;
`;
}
