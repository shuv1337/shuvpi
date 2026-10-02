import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@shuv1337/shuvpi-ai";
import { validateToolArguments } from "@shuv1337/shuvpi-ai/utils/validation";
import { type Context, copyJson, type JsonValue } from "@shuv1337/shuvpi-chord";
import { awaitWithContext } from "@shuv1337/shuvpi-chord/context";
import { overlap } from "@shuv1337/shuvpi-chord/delta";
import { defineDoc, defineDocFamily } from "../documents.ts";
import { AssistantEntry, ToolResultEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, utf8ByteLength } from "../truncate.ts";
import type {
	ConversationId,
	EntryId,
	JsonObject,
	Session,
	Task,
	TaskId,
	TaskOptions,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { assignJson } from "./json.ts";
import { clearProgress, finishSlot, LiveDoc, type ToolSlot, toolSlot } from "./live.ts";
import { boundOutput, OutputBuffer, type OutputLimits, Progress } from "./output.ts";
import type {
	HookApi,
	ToolControl,
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolHooks,
	ToolRegistration,
} from "./types.ts";
import { recordUsage } from "./usage.ts";

/** Critical authorization runs at execution, including a compatible recovery. A rejection vetoes execution. */
export type ToolPolicy = {
	readonly id: string;
	readonly compatibility: string;
	authorize(call: ToolCall, context: Context, api: HookApi): void | Promise<void>;
};

export type ToolEffect = {
	taskId: TaskId;
	callId: string;
	tool: string;
	status: "pending" | "resolved";
	disposition?: "completed" | "reconciled" | "abandoned";
	reason?: string;
};

export type ToolEffectsState = {
	effects: Record<string, ToolEffect>;
	blocked?: { taskId: TaskId; reason: string };
};

/** Effect intents survive task completion and are never copied by a conversation fork. */
export const ToolEffectsDoc = defineDocFamily<ToolEffectsState, null>({
	kind: "pi.tool-effects",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ effects: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

const EffectScopesDoc = defineDoc<{ tasks: Record<string, string> }>({
	kind: "pi.tool-effect-scopes",
	version: 1,
	scope: "session",
	initial: () => ({ tasks: {} }),
});

/** Bind a workflow root in its creation commit. A binding cannot subsequently change. */
export async function bindToolEffectScope(tx: Tx, rootTaskId: TaskId, scope = `task:${rootTaskId}`): Promise<string> {
	if (scope.trim() === "") throw new Error("Tool effect scope must not be empty");
	const scopes = await tx.doc(EffectScopesDoc);
	const previous = scopes.tasks[String(rootTaskId)];
	if (previous !== undefined && previous !== scope)
		throw new Error(`Task ${rootTaskId} already has effect scope ${previous}`);
	scopes.tasks[String(rootTaskId)] = scope;
	return scope;
}

/** Resolve immutable ownership before acquiring documents, respecting table read-before-write rules. */
export async function toolEffectScope(tx: Tx, conversationId: ConversationId, taskId: TaskId): Promise<string> {
	const owners: TaskId[] = [];
	let task: TaskId | undefined = taskId;
	let conversation = conversationId;
	const seen = new Set<TaskId>();
	while (true) {
		if (task !== undefined) {
			if (seen.has(task)) throw new Error("Cyclic tool effect ownership");
			seen.add(task);
			owners.push(task);
			const record = await tx.task(task);
			if (record === undefined) throw new Error(`Missing effect owner task ${task}`);
			conversation = record.conversationId;
			task = record.owner;
			if (task !== undefined) continue;
		}
		const record = await tx.conversation(conversation);
		if (record === undefined) throw new Error(`Missing effect conversation ${conversation}`);
		if (record.owner === undefined) break;
		task = record.owner.taskId;
	}
	const scopes = await tx.doc(EffectScopesDoc);
	for (const owner of owners) {
		const scope = scopes.tasks[String(owner)];
		if (scope !== undefined) return scope;
	}
	return `conversation:${conversation}`;
}

/** Read the durable barrier and audit trail without creating it. */
export function readToolEffects(
	session: Session,
	scope: string,
	context: Context,
): Promise<Readonly<ToolEffectsState> | undefined> {
	return session.snapshot(ToolEffectsDoc, scope, context);
}

/** Record an explicit human/application disposition. Never changes or replays the interrupted tool task. */
export async function resolveToolEffect(
	session: Session,
	scope: string,
	taskId: TaskId,
	disposition: "reconciled" | "abandoned",
	reason: string,
	context: Context,
): Promise<void> {
	if (reason.trim() === "") throw new Error("Effect reconciliation requires a reason");
	await session.commit(async (tx) => {
		const task = await tx.task(taskId);
		if (task !== undefined && task.state.status !== "terminal")
			throw new Error(`Effect task ${taskId} is still live`);
		const state = await tx.doc(ToolEffectsDoc, scope, null);
		const effect = state.effects[String(taskId)];
		if (effect === undefined) throw new Error(`Unknown tool effect ${taskId} in ${scope}`);
		if (effect.status === "resolved") {
			if (effect.disposition === disposition && effect.reason === reason) return;
			throw new Error(`Tool effect ${taskId} is already resolved`);
		}
		effect.status = "resolved";
		effect.disposition = disposition;
		effect.reason = reason;
		const pending = Object.values(state.effects).find((item) => item.status === "pending");
		if (pending === undefined) delete state.blocked;
		else state.blocked = { taskId: pending.taskId, reason: "Unresolved tool effect" };
	}, context);
}

/** One Harness owns this set. Persisted intent without a live execution is ambiguous after any reopen. */
export class ToolBoundary {
	readonly active = new Set<TaskId>();
	readonly policies: readonly ToolPolicy[];

	constructor(policies: readonly ToolPolicy[] = []) {
		if (new Set(policies.map((policy) => policy.id)).size !== policies.length)
			throw new Error("Duplicate critical tool policy");
		this.policies = [...policies];
	}

	compatibility(tool: ToolRegistration): string {
		for (const id of tool.requiredPolicies ?? []) {
			if (!this.policies.some((policy) => policy.id === id))
				throw new Error(`Required tool policy ${id} is missing`);
		}
		return canonical({
			name: tool.name,
			implementation: tool.compatibility ?? null,
			schema: JSON.parse(JSON.stringify(tool.parameters)) as JsonValue,
			effect: tool.effect ?? "mutation",
			replay: tool.replay ?? "unsafe",
			requiredPolicies: [...(tool.requiredPolicies ?? [])].sort(),
			policies: this.policies
				.map(({ id, compatibility }) => ({ id, compatibility }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		});
	}

	async authorize(call: ToolCall, context: Context, api: HookApi): Promise<void> {
		for (const policy of this.policies) await policy.authorize(call, context, api);
		context.abortSignal?.throwIfAborted();
	}

	async blocked(tx: Tx, scope: string, except?: TaskId): Promise<boolean> {
		const state = await tx.doc(ToolEffectsDoc, scope, null);
		const pending = Object.values(state.effects).find(
			(effect) => effect.status === "pending" && effect.taskId !== except && !this.active.has(effect.taskId),
		);
		if (pending === undefined) {
			delete state.blocked;
			return false;
		}
		state.blocked = { taskId: pending.taskId, reason: "Unresolved tool effect" };
		return true;
	}
}

function canonical(value: JsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
		.join(",")}}`;
}

export type ToolTaskInput =
	| { assistant: EntryId; callId: string }
	| { name: string; arguments: JsonObject; callId: string };

export type ToolTaskCheckpoint =
	| { phase: "call" }
	/** Durable intent: the final arguments and the replay policy recorded before execution. */
	| {
			phase: "execute";
			arguments: JsonObject;
			replay: "safe" | "unsafe";
			compatibility: string;
			scope: string;
			effect: "read" | "mutation";
	  };

export type ToolTaskResult = {
	entryId: EntryId;
	control?: ToolControl;
	result?: ToolExecutionResult;
	/** A dispatch/recovery barrier requiring host action, distinct from ordinary tool failure. */
	blocked?: "policy_blocked" | "recovery_blocked" | "unresolved_effect";
};

const NestedCallsDoc = defineDoc<{ calls: { name: string; arguments: JsonObject; taskId: TaskId<ToolTaskResult> }[] }>({
	kind: "pi.nested-tool-calls",
	version: 1,
	scope: "task",
	initial: () => ({ calls: [] }),
});

type Runtime = TaskRuntime<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>;
type Content = (TextContent | ImageContent)[];

/**
 * Built-in tool task: resolves the called tool among its phase agent's tools, validates, runs `beforeTool`, records intent,
 * executes, runs `afterTool`, and appends the result, all in one `call` handler so nothing separates resolution from
 * settlement. `execute` is reached only by recovery and applies the replay rule.
 */
export const ToolTask = defineTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>({
	name: "pi.tool",
	version: 2,
	initial: () => ({ phase: "call" }),
	phases: {
		call: async (task, runtime, context) => {
			const call = await readCall(runtime, task.input, context);
			const tool = (await runtime.agent(context)).tools.find((each) => each.name === call.name);
			if (tool === undefined) {
				const error = harnessError("tool_unavailable", `Tool ${call.name} is not available`);
				return settle(runtime, call, COMPLETED, () => error, context);
			}
			const prepared = prepare(tool, call.arguments as JsonObject);
			const checked = "error" in prepared ? prepared : validate(tool, call, prepared.args);
			if ("error" in checked) return settle(runtime, call, COMPLETED, () => invalid(checked.error), context);
			let args = checked.args;
			let block: string | undefined;
			await runtime.hooks.each("beforeTool", async (hook) => {
				if (block !== undefined) return;
				try {
					const decision = await hook({ ...call, arguments: args }, runtime, context);
					if (decision?.block !== undefined) block = decision.block;
					else if (decision?.arguments !== undefined) args = decision.arguments;
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					block = errorText(error);
				}
			});
			if (block !== undefined) {
				const blocked = harnessError("blocked", `Tool call blocked: ${block}`);
				return settle(runtime, call, COMPLETED, () => blocked, context);
			}
			const validated = validate(tool, call, args);
			if ("error" in validated) return settle(runtime, call, COMPLETED, () => invalid(validated.error), context);
			const final = validated.args;
			let compatibility: string;
			try {
				compatibility = runtime.toolBoundary.compatibility(tool);
				await runtime.toolBoundary.authorize({ ...call, arguments: final }, context, runtime);
			} catch (error) {
				if (runtime.signal.aborted) throw error;
				return settle(runtime, call, COMPLETED, () => harnessError("policy_blocked", errorText(error)), context);
			}
			let blocked = false;
			runtime.toolBoundary.active.add(runtime.taskId);
			try {
				await runtime.commit(async (tx) => {
					const scope = await toolEffectScope(tx, runtime.conversationId, runtime.taskId);
					const effect = tool.effect ?? "mutation";
					if (effect === "mutation" && (await runtime.toolBoundary.blocked(tx, scope))) {
						blocked = true;
						return undefined;
					}
					if (effect === "mutation") {
						const effects = await tx.doc(ToolEffectsDoc, scope, null);
						effects.effects[String(runtime.taskId)] = {
							taskId: runtime.taskId,
							callId: call.id,
							tool: call.name,
							status: "pending",
						};
					}
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot !== undefined) slot.status = "running";
					const intent = {
						phase: "execute",
						arguments: final,
						replay: tool.replay ?? "unsafe",
						compatibility,
						scope,
						effect,
					} as const;
					return { status: "running", checkpoint: intent };
				}, context);
				if (blocked)
					return settle(
						runtime,
						call,
						COMPLETED,
						() => harnessError("unresolved_effect", "Mutating execution is blocked by an unresolved tool effect"),
						context,
					);
				await run(runtime, call, tool, final, context);
			} finally {
				runtime.toolBoundary.active.delete(runtime.taskId);
			}
		},
		/** Recovery after intent: rerun only when the stored and the current policy both say `safe`. */
		execute: async (task, runtime, context) => {
			const { arguments: args, replay } = task.state.checkpoint;
			const call = await readCall(runtime, task.input, context);
			const tool = (await runtime.agent(context)).tools.find((each) => each.name === call.name);
			let compatible = false;
			let reason = "Tool implementation is unavailable or incompatible";
			try {
				compatible =
					tool !== undefined && runtime.toolBoundary.compatibility(tool) === task.state.checkpoint.compatibility;
				if (replay === "safe" && (tool?.compatibility === undefined || tool.compatibility.trim() === "")) {
					compatible = false;
					reason = "Safe recovery requires an explicit tool compatibility identity";
				}
			} catch (error) {
				reason = errorText(error);
			}
			if (replay === "safe" && tool?.replay === "safe" && compatible) {
				const checked = validate(tool, call, args);
				if ("error" in checked)
					return settle(
						runtime,
						call,
						{ status: "failed", message: checked.error },
						() => harnessError("recovery_blocked", checked.error),
						context,
					);
				let blocked = false;
				// The rerun reports from scratch; clear what the interrupted attempt published.
				await runtime.commit(async (tx) => {
					blocked =
						task.state.checkpoint.effect === "mutation" &&
						(await runtime.toolBoundary.blocked(tx, task.state.checkpoint.scope, runtime.taskId));
					if (blocked) return undefined;
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot !== undefined) clearProgress(slot);
					return undefined;
				}, context);
				if (blocked)
					return settle(
						runtime,
						call,
						{ status: "failed", message: "Unresolved tool effect" },
						() => harnessError("unresolved_effect", "Mutating recovery is blocked by an unresolved tool effect"),
						context,
					);
				runtime.toolBoundary.active.add(runtime.taskId);
				try {
					return await run(runtime, call, tool, checked.args, context, true);
				} finally {
					runtime.toolBoundary.active.delete(runtime.taskId);
				}
			}
			const message = compatible
				? `Tool ${call.name} was interrupted and may have partially run`
				: `Tool ${call.name} recovery blocked: ${reason}`;
			// `failed` records cancellation intent, so the call's owned conversations, left unsupervised, are aborted.
			const ending = { status: "failed", message } as const;
			await settle(
				runtime,
				call,
				ending,
				(slot) => fromSlot(slot, compatible ? "interrupted" : "recovery_blocked", message),
				context,
			);
		},
	},
	abort: async (task, runtime, context) => {
		const call = await readCall(runtime, task.input, context);
		const message = `Tool ${call.name} was aborted`;
		await settle(runtime, call, { status: "aborted" }, (slot) => fromSlot(slot, "aborted", message), context);
	},
});

/** The tool call `callId` of the assistant entry. */
async function readCall(runtime: Runtime, input: ToolTaskInput, context: Context): Promise<ToolCall> {
	if ("name" in input) return { type: "toolCall", id: input.callId, name: input.name, arguments: input.arguments };
	const entry = await runtime.entry(AssistantEntry, input.assistant, context);
	const message = entry?.model?.[0];
	const call =
		message?.role === "assistant"
			? message.content.find(
					(content): content is ToolCall => content.type === "toolCall" && content.id === input.callId,
				)
			: undefined;
	if (call === undefined) throw new Error(`Entry ${input.assistant} has no tool call ${input.callId}`);
	return call;
}

/** Arguments, or why they are invalid. */
type Checked = { readonly args: JsonObject } | { readonly error: string };

/** The call's arguments as repaired by the tool; a throwing repair makes them invalid. */
function prepare(tool: ToolRegistration, args: JsonObject): Checked {
	if (tool.prepareArguments === undefined) return { args };
	try {
		return { args: tool.prepareArguments(args) as JsonObject };
	} catch (error) {
		return { error: errorText(error) };
	}
}

/** Arguments validated and coerced against the implementation's schema. */
function validate(tool: ToolRegistration, call: ToolCall, args: JsonObject): Checked {
	try {
		return { args: validateToolArguments(tool, { ...call, arguments: args }) as JsonObject };
	} catch (error) {
		return { error: errorText(error) };
	}
}

function invalid(message: string): ToolExecutionResult {
	return harnessError("invalid_arguments", message);
}

/** What a running tool reported through its api: output, the last details, and diagnostics. */
type Reported = {
	readonly output: OutputBuffer;
	readonly limits: OutputLimits;
	readonly diagnostics: ToolDiagnostic[];
	details: JsonValue | undefined;
};

/** Execute with the resolved implementation, then settle its result. */
async function run(
	runtime: Runtime,
	call: ToolCall,
	tool: ToolRegistration,
	args: JsonObject,
	context: Context,
	recovering = false,
): Promise<void> {
	const limits: OutputLimits = {
		maxBytes: tool.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: tool.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
		retain: tool.outputLimits?.retain ?? "head",
	};
	const reported: Reported = { output: new OutputBuffer(limits), limits, diagnostics: [], details: undefined };
	const progress = publishProgress(runtime, reported, context);
	let ended = false;
	let nestedIndex = 0;
	let executionBlock: ToolTaskResult["blocked"];
	const assertLive = (): void => {
		if (ended) throw new Error(`Tool call ${call.id} has settled`);
	};
	const api: Omit<ToolExecutionApi, "env"> = {
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId: call.id,
		callTool: async (name, args, nestedContext) => {
			assertLive();
			const index = nestedIndex++;
			let id: TaskId<ToolTaskResult> | undefined;
			await runtime.commit(async (tx) => {
				const calls = (await tx.doc(NestedCallsDoc, runtime.taskId)).calls;
				const previous = calls[index];
				if (previous !== undefined) {
					if (previous.name !== name || JSON.stringify(previous.arguments) !== JSON.stringify(args))
						throw new Error(`Nested tool call ${index} diverged during replay`);
					id = previous.taskId;
				} else {
					if (calls.length !== index) throw new Error("Nested tool call order diverged");
					id = await tx.createTask(
						ToolTask,
						{ name, arguments: args, callId: `nested:${runtime.taskId}:${index}` },
						{ ownership: { kind: "task", taskId: runtime.taskId } },
					);
					calls.push({ name, arguments: args, taskId: id });
				}
				return undefined;
			}, nestedContext);
			const outcome = (await runtime.waitForTask(id!, nestedContext)).state.outcome;
			if (outcome.status === "completed" || outcome.status === "failed" || outcome.status === "aborted") {
				executionBlock ??= outcome.result?.blocked;
				if (outcome.result?.result !== undefined) return outcome.result.result;
			}
			return harnessError("nested_tool_failed", `Nested tool ${name} ended ${outcome.status}`);
		},
		registry: runtime.registry,
		agent: runtime.agent,
		output: (chunk) => {
			assertLive();
			if (reported.output.push(chunk)) progress.mark();
		},
		diagnostic: (diagnostic) => {
			assertLive();
			reported.diagnostics.push(copyJson(diagnostic, { omitUndefinedProperties: true }) as ToolDiagnostic);
			progress.mark();
		},
		details: async (value, detailsContext) => {
			assertLive();
			detailsContext.abortSignal?.throwIfAborted();
			reported.details = copyJson(value, { omitUndefinedProperties: true });
			const committed = progress.markAndWait();
			// Cancelling the wait leaves the update in place; the commit's own outcome stays observed.
			committed.catch(() => {});
			return awaitWithContext(committed, detailsContext);
		},
		commit: async (change, commitContext) => {
			let result: Awaited<ReturnType<typeof change>> | undefined;
			await runtime.commit(async (tx) => {
				result = await change(tx);
				return undefined;
			}, commitContext);
			return result as Awaited<ReturnType<typeof change>>;
		},
		memo: runtime.memo,
		createTask: async <I, S extends { phase: string }, R, H extends object>(
			task: Task<I, S, R, H>,
			input: I,
			options: Omit<TaskOptions, "conversationId">,
			taskContext: Context,
		): Promise<TaskId<R>> => {
			let id: TaskId<R> | undefined;
			await runtime.commit(async (tx) => {
				id = await tx.createTask(task, input, options);
				return undefined;
			}, taskContext);
			return id!;
		},
		getTask: runtime.getTask,
		waitForTask: runtime.waitForTask,
		conversation: runtime.conversation,
		snapshot: runtime.snapshot,
		snapshotAsOf: runtime.snapshotAsOf,
		watchDoc: runtime.watchDoc,
	};

	let result: ToolExecutionResult;
	let ending = COMPLETED;
	let enteredExecution = false;
	let authorizing = false;
	try {
		// Built for this call, so a rerun after recovery gets the conversation's environment at that time.
		const env = await runtime.env(context);
		authorizing = true;
		await runtime.toolBoundary.authorize({ ...call, arguments: args }, context, runtime);
		authorizing = false;
		let blocked = false;
		await runtime.commit(async (tx, current) => {
			const checkpoint = current.state.checkpoint;
			if (checkpoint.phase === "execute" && checkpoint.effect === "mutation") {
				blocked = await runtime.toolBoundary.blocked(tx, checkpoint.scope, runtime.taskId);
			}
			return undefined;
		}, context);
		if (blocked) {
			executionBlock = "unresolved_effect";
			result = harnessError("unresolved_effect", "Mutating dispatch is blocked by an unresolved tool effect");
			ending = { status: "failed", message: "Unresolved tool effect" };
		} else {
			enteredExecution = true;
			result = await tool.execute(args, { ...api, env }, context);
		}
	} catch (error) {
		if (runtime.signal.aborted) {
			ended = true;
			for (const waiter of await progress.stop()) waiter.reject(error);
			throw error;
		}
		if (authorizing) executionBlock = "policy_blocked";
		result = {
			isError: true,
			diagnostics: [toolDiagnostic(authorizing ? "policy_blocked" : "tool_error", errorText(error))],
		};
		// A throw, from `execute()` or from building the environment, ends the task `failed`, which cancels what the call owned; it no longer supervises it. The error text
		// is already in the result entry.
		ending = { status: "failed", message: `Tool ${call.name} threw` };
	}
	ended = true;
	reported.output.end();
	// Details still waiting for a progress commit settle with the terminal commit, the final flush.
	const pending = await progress.stop();
	try {
		const settled = await finalResult(runtime, call, result, reported, context);
		await settle(runtime, call, ending, () => settled, context, !enteredExecution && !recovering, executionBlock);
	} catch (error) {
		for (const waiter of pending) waiter.reject(error);
		throw error;
	}
	for (const waiter of pending) waiter.resolve();
}

/**
 * Throttled commits of what the tool reported into its `pi.live.tools` slot, each writing only what changed since the
 * last one.
 */
function publishProgress(runtime: Runtime, reported: Reported, context: Context): Progress {
	let written = { text: "", details: undefined as JsonValue | undefined, diagnostics: 0 };
	return new Progress(
		async () => {
			// Capture everything synchronously: the tool keeps reporting while the commit is in flight.
			const snapshot = reported.output.snapshot();
			const current = { text: snapshot.text, details: reported.details, diagnostics: reported.diagnostics.length };
			const added = reported.diagnostics.slice(written.diagnostics, current.diagnostics);
			const detailsChanged = current.details !== written.details;
			// What the commit writes, as Chord diffs the string: an append, a trim plus an append of what follows the shared
			// part, or the whole window when its bounded overlap search finds nothing.
			let bytes = 0;
			if (snapshot.text !== written.text) {
				const shared = snapshot.text.startsWith(written.text)
					? written.text.length
					: overlap(written.text, snapshot.text, 65_536);
				bytes += utf8ByteLength(snapshot.text.slice(shared));
			}
			if (detailsChanged) bytes += utf8ByteLength(JSON.stringify(current.details ?? null));
			if (added.length > 0) bytes += utf8ByteLength(JSON.stringify(added));
			await runtime.commit(async (tx) => {
				const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (slot === undefined) return undefined;
				// REMINDER: assign `output` as one string field. Chord then diffs it into an append, or a trim plus an
				// append for a sliding tail; replacing the slot object would record the whole window on every commit.
				if ((slot.output ?? "") !== snapshot.text) slot.output = snapshot.text;
				if (snapshot.droppedBytes > 0) slot.droppedBytes = snapshot.droppedBytes;
				if (snapshot.droppedLines > 0) slot.droppedLines = snapshot.droppedLines;
				// Diff details leaf by leaf and append new diagnostics, so each commit writes only what changed.
				if (detailsChanged && current.details !== undefined) {
					assignJson(slot as unknown as Record<string, JsonValue>, "details", current.details);
				}
				if (added.length > 0) {
					if (slot.diagnostics === undefined) slot.diagnostics = [];
					for (const diagnostic of added) slot.diagnostics.push(diagnostic);
				}
				return undefined;
			}, context);
			written = current;
			return bytes;
		},
		(error) => {
			// Rejections after an abort mark or close are expected; the committed state stays consistent.
			if (!runtime.signal.aborted) runtime.report(error);
		},
	);
}

/**
 * The settled result: the tool's result with the retained output and last details as fallbacks, its diagnostics after
 * those reported through the api, `afterTool` applied, and explicit text bounded, with the Harness's truncation
 * diagnostic last.
 */
async function finalResult(
	runtime: Runtime,
	call: ToolCall,
	result: ToolExecutionResult,
	reported: Reported,
	context: Context,
): Promise<ToolExecutionResult> {
	const harness: ToolDiagnostic[] = [];
	const retained = result.content === undefined ? reported.output.snapshot() : undefined;
	const content: Content =
		retained === undefined ? result.content! : retained.text === "" ? [] : [{ type: "text", text: retained.text }];
	let final: ToolExecutionResult = {
		...result,
		content,
		details: result.details === undefined ? reported.details : result.details,
		diagnostics: [...reported.diagnostics, ...(result.diagnostics ?? [])],
	};
	await runtime.hooks.each("afterTool", async (hook) => {
		final = (await hook(call, final, runtime, context)) ?? final;
	});
	// The retained output's truncation applies only while afterTool kept that content.
	if (retained !== undefined && retained.droppedBytes > 0 && final.content === content) {
		harness.push(truncated(retained, reported.limits.retain));
	}
	const bounded = boundContent(final.content ?? [], reported.limits);
	if (bounded.droppedBytes > 0) harness.push(truncated(bounded, reported.limits.retain));
	return { ...final, content: bounded.content, diagnostics: [...(final.diagnostics ?? []), ...harness] };
}

/**
 * Commit the tool's terminal state: append its result entry, mark its slot done, and complete or end aborted with the
 * entry ID. `build` receives the slot so interruption and abort can report the durable partial output.
 */
async function settle(
	runtime: Runtime,
	call: ToolCall,
	ending: Ending,
	build: (slot: Readonly<ToolSlot> | undefined) => ToolExecutionResult,
	context: Context,
	noEffect = false,
	authoritativeBlock?: ToolTaskResult["blocked"],
): Promise<void> {
	await runtime.commit(async (tx, current) => {
		const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
		const result = build(slot);
		const nested = "name" in current.input;
		const entry = nested
			? await tx.appendEntry(runtime.conversationId, {
					kind: "pi.nested-tool-result",
					data: copyJson(result as JsonValue, { omitUndefinedProperties: true }),
				})
			: await appendToolResult(tx, runtime.conversationId, call, result, runtime.now());
		if (current.state.checkpoint.phase === "execute" && current.state.checkpoint.effect === "mutation") {
			const effects = await tx.doc(ToolEffectsDoc, current.state.checkpoint.scope, null);
			const effect = effects.effects[String(runtime.taskId)];
			if (effect !== undefined && (ending.status === "completed" || noEffect)) {
				effect.status = "resolved";
				effect.disposition = "completed";
			} else if (effect?.status === "pending") {
				effects.blocked = {
					taskId: runtime.taskId,
					reason: ending.status === "failed" ? ending.message : "Tool execution aborted",
				};
			}
		}
		if (slot !== undefined) finishSlot(slot, entry.id);
		const entryId = entry.id;
		const code =
			authoritativeBlock ??
			result.diagnostics?.find(
				(diagnostic) =>
					diagnostic.code === "policy_blocked" ||
					diagnostic.code === "recovery_blocked" ||
					diagnostic.code === "unresolved_effect",
			)?.code;
		const barrier: Pick<ToolTaskResult, "blocked"> =
			code === "policy_blocked" || code === "recovery_blocked" || code === "unresolved_effect"
				? { blocked: code }
				: {};
		const nestedResult = nested
			? { result: copyJson(result as JsonValue, { omitUndefinedProperties: true }) as ToolExecutionResult }
			: {};
		if (ending.status === "aborted")
			return {
				status: "terminal",
				outcome: { status: "aborted", result: { entryId, ...nestedResult, ...barrier } },
			};
		if (ending.status === "failed") {
			const error = { message: ending.message };
			return {
				status: "terminal",
				outcome: { status: "failed", error, result: { entryId, ...nestedResult, ...barrier } },
			};
		}
		// Tools build control objects freely; drop keys set to undefined so the task result is strict JSON.
		const control =
			result.control === undefined
				? {}
				: { control: copyJson(result.control as JsonValue, { omitUndefinedProperties: true }) as ToolControl };
		return {
			status: "terminal",
			outcome: { status: "completed", result: { entryId, ...control, ...nestedResult, ...barrier } },
		};
	}, context);
}

/**
 * How a tool task ends; the result entry is appended either way. `failed` (execution threw or was interrupted)
 * records cancellation intent for the conversations the call owns; a result with `isError` still completes.
 */
type Ending = { readonly status: "completed" | "aborted" } | { readonly status: "failed"; readonly message: string };

const COMPLETED: Ending = { status: "completed" };

/** An error result from the slot's durable partial output, details, and diagnostics. */
function fromSlot(slot: Readonly<ToolSlot> | undefined, code: string, message: string): ToolExecutionResult {
	const diagnostics = [...(slot?.diagnostics ?? [])];
	const droppedBytes = slot?.droppedBytes ?? 0;
	if (droppedBytes > 0) diagnostics.push(truncated({ droppedBytes, droppedLines: slot?.droppedLines ?? 0 }));
	diagnostics.push(toolDiagnostic(code, message));
	return {
		content: slot?.output === undefined || slot.output === "" ? [] : [{ type: "text", text: slot.output }],
		isError: true,
		...(slot?.details === undefined ? {} : { details: slot.details }),
		diagnostics,
	};
}

/** An error result the Harness writes itself: no content and one `error` diagnostic with `code`. */
export function harnessError(code: string, message: string): ToolExecutionResult {
	return { content: [], isError: true, diagnostics: [toolDiagnostic(code, message)] };
}

function toolDiagnostic(code: string, message: string): ToolDiagnostic {
	return { severity: "error", code, message };
}

/** The Harness's truncation diagnostic; `retain` is unknown when rebuilt from a slot after recovery. */
function truncated(
	dropped: { readonly droppedLines: number; readonly droppedBytes: number },
	retain?: "head" | "tail",
): ToolDiagnostic {
	const kept = retain === undefined ? "" : ` to its ${retain === "head" ? "beginning" : "end"}`;
	return {
		severity: "warn",
		code: "truncated",
		message: `Output truncated${kept}: ${dropped.droppedLines} lines, ${dropped.droppedBytes} bytes dropped`,
	};
}

/**
 * Append a `pi.tool-result` entry. The content ends with the rendered diagnostics, so the stored message is exactly
 * what the model sees; `data` keeps the structured list. A result's usage is added to `pi.usage` in the same commit.
 */
export async function appendToolResult(
	tx: Tx,
	conversationId: ConversationId,
	call: ToolCall,
	result: ToolExecutionResult,
	timestamp: number,
): Promise<TypedEntry<{ diagnostics: ToolDiagnostic[] }>> {
	const diagnostics = [...(result.diagnostics ?? [])];
	const content: Content = [...(result.content ?? [])];
	if (diagnostics.length > 0) content.push({ type: "text", text: renderDiagnostics(diagnostics) });
	const message = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		...(result.details === undefined ? {} : { details: result.details }),
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		isError: result.isError ?? false,
		timestamp,
	} as ToolResultMessage;
	if (result.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, result.usage);
	return tx.appendEntry(ToolResultEntry, conversationId, { model: [message], data: { diagnostics } });
}

function renderDiagnostics(diagnostics: readonly ToolDiagnostic[]): string {
	return `<harness>\n${diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.message}`).join("\n")}\n</harness>`;
}

/**
 * Bound the text of result content. When the joined text exceeds the limits, the text items are replaced by one bounded
 * item at the position of the first (head) or last (tail) text item; other content is kept.
 */
function boundContent(
	content: Content,
	limits: OutputLimits,
): { content: Content; droppedBytes: number; droppedLines: number } {
	const texts = content.filter((item): item is TextContent => item.type === "text");
	const bounded = boundOutput(texts.map((item) => item.text).join(""), limits);
	if (bounded.droppedBytes === 0) return { content, droppedBytes: 0, droppedLines: 0 };
	const keep = limits.retain === "head" ? texts[0] : texts.at(-1);
	const result: Content = [];
	for (const item of content) {
		if (item.type !== "text") result.push(item);
		else if (item === keep) result.push({ ...item, text: bounded.text });
	}
	return { content: result, droppedBytes: bounded.droppedBytes, droppedLines: bounded.droppedLines };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
