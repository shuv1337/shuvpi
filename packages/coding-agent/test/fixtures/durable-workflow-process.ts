import { join } from "node:path";
import { createModels } from "@shuv1337/shuvpi-ai";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import { createRegistry, defineDoc, defineTask, Harness, type JsonObject, type TaskId } from "@shuv1337/shuvpi-durable";
import { openNodeSqliteStorage } from "@shuv1337/shuvpi-durable/storage/sqlite/node";
import { WorkflowJournalDoc } from "../../src/core/durable-workflows/journal.ts";
import { startWorkflowOwner } from "../../src/core/durable-workflows/owner.ts";
import { isWorkflowJsonObject, type WorkflowJsonValue } from "../../src/core/durable-workflows/protocol.ts";
import { createWorkflowTask, type WorkflowAgentResult } from "../../src/core/durable-workflows/runner.ts";

const [directory, boundary] = process.argv.slice(2);
if (!directory) throw new Error("Missing state directory");
const context = BACKGROUND_CONTEXT;
interface Ledger extends JsonObject {
	root: TaskId | null;
	children: Array<{ id: TaskId; prompt: string; completed: boolean }>;
}
const LedgerDoc = defineDoc<Ledger>({
	kind: "test.workflow.process",
	version: 1,
	scope: "session",
	initial: () => ({ root: null, children: [] }),
});
const Child = defineTask<{ prompt: string }, { phase: "run" }, WorkflowAgentResult>({
	name: "test.workflow.process.child",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) => {
			if (boundary === "child-running" && task.input.prompt === "seed") {
				process.send?.({ event: "boundary", childId: runtime.taskId });
				await new Promise<void>(() => {});
			}
			if (task.input.prompt === "slow") await new Promise((resolve) => setTimeout(resolve, 60));
			await runtime.commit(async (tx) => {
				const ledger = await tx.doc(LedgerDoc);
				const child = ledger.children.find((value) => value.id === runtime.taskId);
				if (!child || child.completed) throw new Error("Child completion duplicated or absent");
				child.completed = true;
				return {
					status: "terminal",
					outcome: {
						status: "completed",
						result: { ok: true, output: task.input.prompt, structured: { count: 2 } },
					},
				};
			}, ctx);
		},
	},
	abort: async (_task, runtime, ctx) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});

const Workflow = createWorkflowTask({
	createChild: async (tx, request) => {
		const id = await tx.createTask(
			Child,
			{ prompt: request.prompt },
			{
				ownership: { kind: "task", taskId: request.workflowTaskId },
			},
		);
		const ledger = await tx.doc(LedgerDoc);
		ledger.children.push({ id, prompt: request.prompt, completed: false });
		return id;
	},
	readChildResult: async (task) => {
		if (boundary === "child-settled" && isWorkflowJsonObject(task.input) && task.input.prompt === "seed") {
			process.send?.({ event: "boundary", childId: task.id });
			await new Promise<void>(() => {});
		}
		const outcome = task.state.outcome;
		if (outcome.status !== "completed" || !isWorkflowJsonObject(outcome.result))
			throw new Error("Expected completed fixture child");
		if (typeof outcome.result.ok !== "boolean" || typeof outcome.result.output !== "string")
			throw new Error("Invalid child result");
		return { ok: outcome.result.ok, output: outcome.result.output, structured: outcome.result.structured };
	},
});
let harness: Harness | undefined;
const owner = await startWorkflowOwner({
	socketPath: join(directory, "owner.sock"),
	handle: async (operation): Promise<WorkflowJsonValue> => {
		if (!harness || operation.type !== "snapshot") throw new Error("Owner not initialized or unknown operation");
		const ledger = await harness.snapshot(LedgerDoc, context);
		if (!ledger || ledger.root === null) throw new Error("Missing fixture ledger");
		const journal = await harness.snapshot(WorkflowJournalDoc, ledger.root, context);
		return { ledger, journal: journal ?? null };
	},
});
const registry = createRegistry();
registry.install({ name: "workflow-process", tasks: [Workflow, Child] });
harness = await Harness.open(
	await openNodeSqliteStorage(join(directory, "workflow.sqlite")),
	{
		models: createModels(),
		registry,
	},
	context,
);
const conversation = await harness.root(context);
const existing = await harness.snapshot(LedgerDoc, context);
const workflowId =
	existing?.root ??
	(await conversation.commit(async (tx) => {
		const id = await tx.createTask(
			Workflow,
			{
				source: `
await phase("choose");
const seed = await agent("seed");
const repeats = await Promise.all(Array.from({ length: seed.structured.count }, () => agent("same")));
const winner = await Promise.race([agent("slow"), agent("fast")]);
const selected = await agent("selected:" + winner.output);
return { values: repeats.map((value) => value.output), selected: selected.output };`,
				args: {},
			},
			{ ownership: { kind: "conversation" } },
		);
		const ledger = await tx.doc(LedgerDoc);
		ledger.root = id;
		return id;
	}, context));
process.send?.({ event: "ready", workflowId });
const settled = await harness.waitForTask(workflowId, context);
const ledger = await harness.snapshot(LedgerDoc, context);
process.send?.({ event: "complete", workflowId, outcome: settled.state.outcome, ledger });
await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
await harness.close(context);
await owner.close();
