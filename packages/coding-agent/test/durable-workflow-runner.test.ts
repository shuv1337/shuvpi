import { createModels } from "@shuv1337/shuvpi-ai";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import { createRegistry, defineTask, Harness, MemoryStorage, type TaskId } from "@shuv1337/shuvpi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowJournalDoc, type WorkflowJournalState } from "../src/core/durable-workflows/journal.ts";
import type { WorkflowJsonValue } from "../src/core/durable-workflows/protocol.ts";
import {
	createWorkflowTask,
	type WorkflowAgentResult,
	type WorkflowChildRequest,
	type WorkflowTaskInput,
} from "../src/core/durable-workflows/runner.ts";

const context = BACKGROUND_CONTEXT;
const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(context);
});

async function setup(run: (request: WorkflowChildRequest, signal: AbortSignal) => Promise<WorkflowAgentResult>) {
	const created: WorkflowChildRequest[] = [];
	const settledJournals: WorkflowJournalState[] = [];
	const child = defineTask<WorkflowChildRequest, { phase: "run" }, WorkflowAgentResult>({
		name: "test.workflow.child",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, ctx) => {
				const result = await run(task.input, runtime.signal);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), ctx);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});
	const task = createWorkflowTask({
		createChild: async (tx, request) => {
			created.push(request);
			return tx.createTask(child, request, { ownership: { kind: "task", taskId: request.workflowTaskId } });
		},
		readChildResult: async (task) => {
			if (task.state.outcome.status !== "completed")
				return { ok: false, output: "", error: task.state.outcome.status };
			return task.state.outcome.result as WorkflowAgentResult;
		},
		onSettled: async (_tx, record) => {
			settledJournals.push(record.journal);
		},
	});
	const registry = createRegistry();
	registry.install({ name: "workflow-fixture", tasks: [task, child] });
	const reports: unknown[] = [];
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry, onReport: (error) => reports.push(error) },
		context,
	);
	harnesses.push(harness);
	const root = await harness.root(context);
	const start = async (input: WorkflowTaskInput, seed?: WorkflowJournalState) => {
		const id = await root.commit(async (tx) => {
			const id = await tx.createTask(task, input, { ownership: { kind: "conversation" } });
			if (seed) {
				const journal = await tx.doc(WorkflowJournalDoc, id);
				Object.assign(journal, structuredClone(seed), { status: "running", error: "" });
			}
			return id;
		}, context);
		harness.resume();
		return id;
	};
	const wait = async (id: TaskId<WorkflowJsonValue>) => (await harness.waitForTask(id, context)).state.outcome;
	return { harness, root, created, reports, settledJournals, start, wait };
}

describe("production QuickJS WorkflowTask", () => {
	it("executes generated result-dependent fanout, caps four children, and retains structured output/options", async () => {
		let active = 0;
		let peak = 0;
		const setupRun = await setup(async ({ prompt, options }) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			active--;
			const structured: WorkflowJsonValue =
				prompt === "plan" ? { items: [1, 2, 3, 4, 5, 6, 7] } : { prompt, options };
			return {
				ok: true,
				output: prompt,
				structured,
			};
		});
		const input = {
			source: `phase("plan");
const plan = await agent("plan", {schema:{type:"object"}});
phase("fanout");
const results = await Promise.all(plan.structured.items.map((n) => agent("item-"+n, {effort:"high",label:String(n)})));
return results.map((r) => r.structured);`,
			args: null,
		};
		const id = await setupRun.start(input);
		const outcome = await setupRun.wait(id);
		expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
		expect(outcome.result).toHaveLength(7);
		expect(peak).toBe(4);
		expect(setupRun.created).toHaveLength(8);
		expect(setupRun.created[1]?.options).toEqual({ effort: "high", label: "1" });
		expect(await setupRun.harness.snapshot(WorkflowJournalDoc, id, context)).toBeUndefined();
		expect(setupRun.reports).toEqual([]);
	});

	it("replays out-of-order completion, a race and repeated identical prompts without launching new children", async () => {
		let started = 0;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const setupRun = await setup(async ({ prompt }) => {
			const ordinal = started++;
			if (prompt === "barrier") {
				entered.resolve();
				await release.promise;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, ordinal === 0 ? 30 : 1));
			return { ok: true, output: prompt, structured: { ordinal } };
		});
		const input = {
			source: `const a = agent("same"); const b = agent("same");
const winner = await Promise.race([a.then(value => value),b.then(value => value)]);
const next = await agent("winner-"+winner.structured.ordinal);
await Promise.all([a,b]);
await agent("barrier");
return {winner, next, all: await Promise.all([a,b])};`,
			args: null,
		};
		const first = await setupRun.start(input);
		await entered.promise;
		const journal = (await setupRun.harness.snapshot(WorkflowJournalDoc, first, context))!;
		release.resolve();
		const original = await setupRun.wait(first);
		expect(original.status, JSON.stringify(original)).toBe("completed");
		expect(journal.operations[1]!.completionOrder).toBeLessThan(journal.operations[0]!.completionOrder!);
		expect(journal.races[0]?.winner).toBe(1);
		const replay = await setupRun.start(input, journal);
		expect(await setupRun.wait(replay)).toEqual(original);
		expect(started).toBe(4);
		expect(setupRun.created).toHaveLength(4);
	});

	it("blocks call-site divergence before creating a new child, even when generated code catches errors", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const setupRun = await setup(async ({ prompt }) => {
			if (prompt === "barrier") {
				entered.resolve();
				await release.promise;
			}
			return { ok: true, output: prompt };
		});
		const input = {
			source: `try { await agent("same"); } catch {} await agent("barrier"); return await agent("must-not-add");`,
			args: null,
		};
		const first = await setupRun.start(input);
		await entered.promise;
		const journal = (await setupRun.harness.snapshot(WorkflowJournalDoc, first, context))!;
		release.resolve();
		expect((await setupRun.wait(first)).status).toBe("completed");
		const changed = structuredClone(journal);
		changed.operations[0] = { ...changed.operations[0]!, callSite: "different" };
		const replay = await setupRun.start(input, changed);
		expect(await setupRun.wait(replay)).toMatchObject({
			status: "failed",
			error: { message: expect.stringContaining("changed during replay") },
		});
		expect(setupRun.created).toHaveLength(3);
	});

	it.each(["fetch('https://example.invalid')", "process.env"])(
		"does not expose host capabilities: %s",
		async (expression) => {
			const setupRun = await setup(async () => ({ ok: true, output: "unexpected" }));
			const id = await setupRun.start({
				source: `const value = ${expression}; await agent(String(value));`,
				args: null,
			});
			expect((await setupRun.wait(id)).status).toBe("failed");
			expect(setupRun.created).toEqual([]);
		},
	);

	it("replays recorded logical Date and seeded Math.random across journal restart", async () => {
		const setupRun = await setup(async ({ prompt }) => ({ ok: true, output: prompt }));
		const input = {
			source: `const before = { now: Date.now(), random: Math.random() };
const explicitDate = new Date(0).getTime();
const result = await agent("clock-boundary");
return { before, explicitDate, after: { now: Date.now(), random: Math.random() }, result };`,
			args: null,
		};
		const originalId = await setupRun.start(input);
		const originalOutcome = await setupRun.wait(originalId);
		expect(originalOutcome.status).toBe("completed");
		const [journal] = setupRun.settledJournals;
		expect(journal).toBeDefined();
		expect(journal?.seed).toEqual(expect.any(Number));
		expect(journal?.initialTimeMs).toEqual(expect.any(Number));
		expect(journal?.operations[0]?.logicalTimeMs).toEqual(expect.any(Number));

		const replayId = await setupRun.start(input, journal);
		const replayOutcome = await setupRun.wait(replayId);
		expect(replayOutcome).toEqual(originalOutcome);
		expect(setupRun.created).toHaveLength(1);
	});

	it("returns failed agent outcomes as values for generated branching", async () => {
		const setupRun = await setup(async ({ prompt }) =>
			prompt === "fail" ? { ok: false, output: "", error: "fixture failure" } : { ok: true, output: prompt },
		);
		const id = await setupRun.start({
			source: `const result = await agent("fail"); return await agent(result.ok ? "wrong" : result.error);`,
			args: null,
		});
		expect(await setupRun.wait(id)).toMatchObject({
			status: "completed",
			result: { ok: true, output: "fixture failure" },
		});
	});

	it("journals races involving derived rejection and immediately resolved values", async () => {
		const setupRun = await setup(async () => ({ ok: true, output: "agent" }));
		const id = await setupRun.start({
			source: `
const immediate = await Promise.race([Promise.resolve("ready"), agent("slow")]);
let rejected;
try { await Promise.race([agent("reject").then(() => { throw new Error("derived"); })]); }
catch (error) { rejected = error.message; }
return {immediate,rejected};`,
			args: null,
		});
		expect(await setupRun.wait(id)).toMatchObject({
			status: "completed",
			result: { immediate: "ready", rejected: "derived" },
		});
	});

	it("aborts the owned subtree and never admits queued children after cancellation", async () => {
		let started = 0;
		let aborted = 0;
		const setupRun = await setup(async (_request, signal) => {
			started++;
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted++;
						reject(new Error("fixture cancelled"));
					},
					{ once: true },
				);
			});
			return { ok: true, output: "unexpected" };
		});
		const id = await setupRun.start({
			source: "return await Promise.all([1,2,3,4,5,6,7].map(n => agent(String(n))));",
			args: null,
		});
		await vi.waitFor(() => expect(started).toBe(4));
		await setupRun.root.abort(context);
		expect((await setupRun.wait(id)).status).toBe("aborted");
		expect(aborted).toBe(4);
		expect(setupRun.created).toHaveLength(4);
	});
});
