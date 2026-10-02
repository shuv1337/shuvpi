import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@shuv1337/shuvpi-agent-core";
import { createModels } from "@shuv1337/shuvpi-ai";
import type { Context } from "@shuv1337/shuvpi-chord";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import {
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	type JsonObject,
	type TaskId,
	type TaskRuntime,
} from "@shuv1337/shuvpi-durable";
import { openNodeSqliteStorage } from "@shuv1337/shuvpi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	admitWorkflowOperation,
	bindWorkflowJournal,
	readWorkflowJournal,
	recordWorkflowRace,
	settleWorkflowOperation,
	WorkflowJournalDoc,
	type WorkflowJournalState,
	WorkflowReplayDivergenceError,
} from "../src/core/durable-workflows/journal.ts";
import { isWorkflowJsonObject } from "../src/core/durable-workflows/protocol.ts";
import { type CodemodeExecutionHost, executeCodemodeWithHost } from "../src/extensions/codemode/execute.ts";

interface ChildInput extends JsonObject {
	readonly value: number;
	readonly label: string;
}

interface ChildState {
	readonly phase: "run";
}

type ChildResult = ChildInput;

interface WorkflowInput extends JsonObject {
	readonly source: string;
	readonly args: JsonObject;
	readonly child: ChildInput;
	readonly divergentSource: string | null;
	readonly divergenceCase: "operation" | "result" | "race" | null;
}

interface WorkflowState {
	readonly phase: "run";
}

interface WorkflowResult extends JsonObject {
	readonly childValue: number;
	readonly childTaskId: number;
	readonly completionOrder: number;
	readonly replayedAdmission: boolean;
	readonly persistedRaceWinner: number;
	readonly journal: WorkflowJournalState | null;
}

const WorkflowChild = defineTask<ChildInput, ChildState, ChildResult>({
	name: "test.workflow-child",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: task.input } }),
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "test" } }), context);
	},
});

const WorkflowRoot = defineTask<WorkflowInput, WorkflowState, WorkflowResult>({
	name: "test.workflow-root",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => runWorkflow(task.input, runtime, context),
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "test" } }), context);
	},
});

type RootRuntime = TaskRuntime<WorkflowInput, WorkflowState, WorkflowResult, object>;
const directories: string[] = [];
const harnesses: Harness[] = [];

async function runWorkflow(input: WorkflowInput, runtime: RootRuntime, context: Context): Promise<void> {
	await bindWorkflowJournal(runtime.taskId, runtime, input.source, input.args, context);
	if (input.divergentSource !== null) {
		let diverged = false;
		try {
			await bindWorkflowJournal(runtime.taskId, runtime, input.divergentSource, input.args, context);
		} catch (error) {
			if (!(error instanceof WorkflowReplayDivergenceError)) throw error;
			diverged = true;
		}
		if (!diverged) throw new Error("Expected changed workflow source to be rejected");
		await runtime.commit(
			async () => ({
				status: "terminal",
				outcome: {
					status: "completed",
					result: {
						childValue: 0,
						childTaskId: 0,
						completionOrder: 0,
						replayedAdmission: false,
						persistedRaceWinner: -1,
						journal: (await readWorkflowJournal(runtime.taskId, runtime, context)) ?? null,
					},
				},
			}),
			context,
		);
		return;
	}

	const identity = { index: 0, kind: "agent" as const, callSite: "workflow.ts:7", arguments: input.child };
	const admission = await admitWorkflowOperation(
		runtime.taskId,
		runtime,
		identity,
		(tx) => tx.createTask(WorkflowChild, input.child, { ownership: { kind: "task", taskId: runtime.taskId } }),
		context,
	);
	if (admission.operation.taskId === null) throw new Error("Workflow operation has no child task");
	const replayed = await admitWorkflowOperation(
		runtime.taskId,
		runtime,
		{
			...identity,
			arguments: { label: input.child.label, value: input.child.value },
		},
		async () => {
			throw new Error("Replay must reuse the existing child");
		},
		context,
	);
	if (input.divergenceCase === "operation") {
		await expectReplayDivergence(() =>
			admitWorkflowOperation(
				runtime.taskId,
				runtime,
				{ ...identity, arguments: { value: input.child.value + 1 } },
				async () => {
					throw new Error("Divergent replay must not create another child");
				},
				context,
			),
		);
		await finishWithJournal(runtime, context);
		return;
	}
	const child = await runtime.waitForTask(admission.operation.taskId, context);
	if (child.state.status !== "terminal" || child.state.outcome.status !== "completed")
		throw new Error("Workflow child task did not complete");
	const childResult: unknown = child.state.outcome.result;
	if (!isWorkflowJsonObject(childResult)) throw new Error("Workflow child result is not the expected JSON object");
	const childValue = childResult.value;
	if (typeof childValue !== "number") throw new Error("Workflow child result has no numeric value");
	const settled = await settleWorkflowOperation(runtime.taskId, runtime, 0, childResult, context);
	if (input.divergenceCase === "result") {
		await expectReplayDivergence(() =>
			settleWorkflowOperation(runtime.taskId, runtime, 0, { value: childValue + 1 }, context),
		);
		await finishWithJournal(runtime, context);
		return;
	}
	await recordWorkflowRace(runtime.taskId, runtime, 0, "workflow.ts:12", [0, 1], 0, context);
	if (input.divergenceCase === "race") {
		await expectReplayDivergence(() =>
			recordWorkflowRace(runtime.taskId, runtime, 0, "workflow.ts:changed", [0, 1], 1, context),
		);
		await finishWithJournal(runtime, context);
		return;
	}
	const replayedRaceWinner = await recordWorkflowRace(
		runtime.taskId,
		runtime,
		0,
		"workflow.ts:12",
		[0, 1],
		1,
		context,
	);
	const journal = await readWorkflowJournal(runtime.taskId, runtime, context);
	await runtime.commit(
		() => ({
			status: "terminal",
			outcome: {
				status: "completed",
				result: {
					childValue,
					childTaskId: Number(admission.operation.taskId),
					completionOrder: settled.completionOrder ?? -1,
					replayedAdmission: replayed.kind === "existing",
					persistedRaceWinner: replayedRaceWinner.winner,
					journal: journal ?? null,
				},
			},
		}),
		context,
	);
}

describe("durable workflow journal", () => {
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT);
		for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
	});

	it("commits child admission, ordered result, and Promise.race winner in real SQLite-backed Harness state", async () => {
		const { harness, workflowId } = await openWorkflowHarness({
			source: "async function main() { return 17; }",
			args: { query: "hello" },
			child: { value: 17, label: "stable" },
			divergentSource: null,
			divergenceCase: null,
		});
		const settled = await harness.waitForTask(workflowId, BACKGROUND_CONTEXT);
		expect(settled.state.outcome).toMatchObject({
			status: "completed",
			result: {
				childValue: 17,
				completionOrder: 0,
				replayedAdmission: true,
				persistedRaceWinner: 0,
			},
		});
		const journal = await harness.snapshot(WorkflowJournalDoc, workflowId, BACKGROUND_CONTEXT);
		expect(journal).toBeUndefined(); // Task-scoped docs retire atomically when their owning task becomes terminal.
		const outcome = settled.state.outcome;
		if (outcome.status !== "completed") throw new Error("Workflow task did not complete");
		expect(outcome.result.journal?.operations).toHaveLength(1);
		expect(outcome.result.journal?.operations[0]).toMatchObject({
			status: "settled",
			completionOrder: 0,
			result: { value: 17 },
		});
		expect(outcome.result.journal?.races).toMatchObject([
			{ index: 0, callSite: "workflow.ts:12", candidates: [0, 1], winner: 0, logicalTimeMs: expect.any(Number) },
		]);
	});

	it("blocks changed source and arguments before admitting a child effect", async () => {
		const { harness, workflowId } = await openWorkflowHarness({
			source: "return 1",
			args: { query: "original" },
			child: { value: 99, label: "changed" },
			divergentSource: "return 2",
			divergenceCase: null,
		});
		await expect(harness.waitForTask(workflowId, BACKGROUND_CONTEXT)).resolves.toMatchObject({
			state: { outcome: { status: "completed" } },
		});
		const outcome = (await harness.waitForTask(workflowId, BACKGROUND_CONTEXT)).state.outcome;
		if (outcome.status !== "completed") throw new Error("Workflow task did not complete");
		expect(outcome.result.journal).toMatchObject({
			status: "blocked",
			error: expect.stringMatching(/source or arguments changed/u),
			operations: [],
		});
	});

	it("runs real QuickJS Promise.race and reuses the persisted winner for downstream arguments", async () => {
		const persistedChildren = new Map<number, { index: number }>();
		const raceProposals: number[] = [];
		const downstreamValues: number[] = [];
		let persistedWinner: number | undefined;
		let callOrdinal = 0;
		const tool = (name: string, outputSchema: AgentTool["outputSchema"]): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			outputSchema,
			execute: async () => {
				throw new Error("Host dispatch is used by this test");
			},
		});
		const tools = [
			tool("child", Type.Object({ index: Type.Number() })),
			tool("record_race", Type.Object({ index: Type.Number() })),
			tool("downstream", Type.Object({ value: Type.Number() })),
		];
		const host: CodemodeExecutionHost = {
			tools,
			executeTool: async (name, args) => {
				if (!isWorkflowJsonObject(args)) throw new Error("Tool arguments must be a JSON object");
				const objectArgs = args;
				let value: { index: number } | { value: number };
				if (name === "child") {
					const index = objectArgs.index;
					if (typeof index !== "number") throw new Error("Missing child index");
					const existing = persistedChildren.get(index);
					if (existing) value = existing;
					else {
						await new Promise((resolve) => setTimeout(resolve, index === 0 ? 30 : 1));
						const childValue = { index };
						value = childValue;
						persistedChildren.set(index, childValue);
					}
				} else if (name === "record_race") {
					const proposed = objectArgs.index;
					if (typeof proposed !== "number") throw new Error("Missing race winner");
					raceProposals.push(proposed);
					persistedWinner ??= proposed;
					value = { index: persistedWinner };
				} else if (name === "downstream") {
					const downstream = objectArgs.value;
					if (typeof downstream !== "number") throw new Error("Missing downstream value");
					downstreamValues.push(downstream);
					value = { value: downstream };
				} else throw new Error(`Unexpected tool ${name}`);
				const id = `quickjs-${++callOrdinal}`;
				return {
					toolCall: { type: "toolCall", id, name, arguments: objectArgs },
					isError: false,
					result: {
						content: [{ type: "text", text: JSON.stringify(value) }],
						details: {},
						structuredContent: value,
					},
				};
			},
			readStore: () => ({}),
			writeStore: () => undefined,
		};
		const source = `
			const actual = await Promise.race([tools.child({index: 0}), tools.child({index: 1})]);
			const selected = await tools.record_race({index: actual.index});
			const result = await tools.downstream({value: selected.index});
			return result.value;
		`;
		const first = await executeCodemodeWithHost("workflow-first", { code: source }, undefined, undefined, host);
		const replay = await executeCodemodeWithHost("workflow-replay", { code: source }, undefined, undefined, host);
		expect(first.isError).toBeUndefined();
		expect(replay.isError).toBeUndefined();
		expect(raceProposals).toEqual([1, 0]);
		expect(persistedWinner).toBe(1);
		expect(downstreamValues).toEqual([1, 1]);
	});

	it.each(["operation", "result", "race"] as const)(
		"persists %s replay divergence as blocked",
		async (divergenceCase) => {
			const { harness, workflowId } = await openWorkflowHarness({
				source: "return 1",
				args: { query: "same" },
				child: { value: 17, label: "stable" },
				divergentSource: null,
				divergenceCase,
			});
			const settled = await harness.waitForTask(workflowId, BACKGROUND_CONTEXT);
			if (settled.state.status !== "terminal" || settled.state.outcome.status !== "completed")
				throw new Error("Divergence fixture did not finish");
			expect(settled.state.outcome.result.journal).toMatchObject({ status: "blocked" });
			expect(settled.state.outcome.result.journal?.error).not.toBe("");
		},
	);
});

async function expectReplayDivergence(operation: () => Promise<unknown>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		if (error instanceof WorkflowReplayDivergenceError) return;
		throw error;
	}
	throw new Error("Expected workflow replay divergence");
}

async function finishWithJournal(runtime: RootRuntime, context: Context): Promise<void> {
	const journal = await readWorkflowJournal(runtime.taskId, runtime, context);
	await runtime.commit(
		() => ({
			status: "terminal",
			outcome: {
				status: "completed",
				result: {
					childValue: 0,
					childTaskId: 0,
					completionOrder: 0,
					replayedAdmission: true,
					persistedRaceWinner: -1,
					journal: journal ?? null,
				},
			},
		}),
		context,
	);
}

async function openWorkflowHarness(
	input: WorkflowInput,
): Promise<{ harness: Harness; workflowId: TaskId<WorkflowResult> }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-workflow-journal-"));
	directories.push(directory);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "workflow-test", tasks: [WorkflowChild, WorkflowRoot] }));
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "workflow.sqlite")),
		{
			models: createModels(),
			registry,
		},
		BACKGROUND_CONTEXT,
	);
	harnesses.push(harness);
	const conversation = await harness.root(BACKGROUND_CONTEXT);
	const workflowId = await conversation.commit(
		(tx) => tx.createTask(WorkflowRoot, input, { ownership: { kind: "conversation" } }),
		BACKGROUND_CONTEXT,
	);
	return { harness, workflowId };
}
