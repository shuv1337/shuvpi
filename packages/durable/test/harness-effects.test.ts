import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@shuv1337/shuvpi-ai";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import { afterEach, describe, expect, it } from "vitest";
import {
	bindToolEffectScope,
	type Conversation,
	createRegistry,
	defineTask,
	defineTool,
	Harness,
	hook,
	type JsonObject,
	MemoryStorage,
	readToolEffects,
	resolveToolEffect,
	type TaskId,
	type ToolPolicy,
	type ToolRegistration,
	ToolTask,
} from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { aborted, deferred } from "./task-support.ts";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const harnesses: Harness[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const harness of harnesses.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function open(tools: ToolRegistration[], path?: string, policies?: readonly ToolPolicy[]) {
	const registry = createRegistry();
	registry.install({ name: "tools", tools });
	const harness = await Harness.open(
		path === undefined ? new MemoryStorage() : await openNodeSqliteStorage(path),
		{ models: createModels(), registry, toolPolicies: policies },
		context,
	);
	harnesses.push(harness);
	const root = await harness.root(context);
	return { harness, root, registry };
}

async function call(harness: Harness, conversation: Conversation, name: string, args = {}, callId = "new-call") {
	const id = await conversation.commit(
		(tx) => tx.createTask(ToolTask, { name, arguments: args, callId }, { ownership: { kind: "conversation" } }),
		context,
	);
	return { id, outcome: (await harness.waitForTask(id, context)).state.outcome };
}

function tool(
	name: string,
	execute: ToolRegistration["execute"],
	extra: Partial<ToolRegistration> = {},
): ToolRegistration {
	return defineTool({ name, description: name, parameters: Type.Object({}), compatibility: "v1", execute, ...extra });
}

async function directory() {
	const path = await mkdtemp(join(tmpdir(), "durable-effects-"));
	directories.push(path);
	return path;
}

async function killOwner(
	path: string,
	effectPath: string,
	mode: "interrupt" | "commit" | "generation-safe" | "generation-unsafe",
) {
	const child = fork(fileURLToPath(new URL("./fixtures/effect-owner.ts", import.meta.url)), [path, effectPath, mode], {
		execArgv: [
			"--experimental-strip-types",
			"--import",
			fileURLToPath(new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url)),
		],
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	children.push(child);
	let stderr = "";
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Owner did not reach boundary: ${stderr}`)), 15_000);
		child.once("message", () => {
			clearTimeout(timer);
			resolve();
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Owner exited ${code}: ${stderr}`));
		});
	});
	const dead = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await dead;
	expect(child.signalCode).toBe("SIGKILL");
}

describe("durable tool execution boundary", () => {
	it.each(["generation-safe", "generation-unsafe"] as const)(
		"recovers a real killed %s generation in scheduler order",
		async (mode) => {
			const dir = await directory();
			const path = join(dir, "store.sqlite");
			const count = join(dir, "effects.txt");
			await killOwner(path, count, mode);
			const models = createModels();
			const faux = fauxProvider();
			models.setProvider(faux.provider);
			faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
			const registry = createRegistry();
			let executions = 0;
			registry.install({
				name: "effects",
				tools: [
					tool(
						"mutate",
						async () => {
							executions++;
							await writeFile(count, "effect\n");
							return {};
						},
						{ replay: mode === "generation-safe" ? "safe" : "unsafe" },
					),
				],
			});
			const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
			harnesses.push(harness);
			const pending = (await harness.inspect(context)).submissions[0]!;
			const submission = (await harness.submission(pending.id, context))!;
			harness.resume();
			const result = await submission.wait(context);
			expect(result.status).toBe(mode === "generation-safe" ? "done" : "unanswered");
			expect(executions).toBe(mode === "generation-safe" ? 1 : 0);
			expect(faux.state.callCount).toBe(mode === "generation-safe" ? 1 : 0);
			expect(await readFile(count, "utf8")).toBe("effect\n");
		},
	);

	it("keeps policy block metadata when afterTool replaces every diagnostic", async () => {
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", {}, { id: "policy" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("must not run")]),
		]);
		const registry = createRegistry();
		let executed = false;
		registry.install({
			name: "tools",
			tools: [
				tool(
					"read",
					async () => {
						executed = true;
						return {};
					},
					{ effect: "read" },
				),
			],
			hooks: [
				hook(ToolTask, { afterTool: () => ({ content: [{ type: "text", text: "rewritten" }], diagnostics: [] }) }),
			],
		});
		let authorizations = 0;
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models,
				registry,
				toolPolicies: [
					{
						id: "trust",
						compatibility: "1",
						authorize: () => {
							if (++authorizations === 2) throw new Error("revoked");
						},
					},
				],
			},
			context,
		);
		harnesses.push(harness);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect(await (await root.submit({ type: "input", content: "read" }, context)).wait(context)).toMatchObject({
			status: "unanswered",
			reason: "tool_policy_blocked",
		});
		expect(executed).toBe(false);
		expect(faux.state.callCount).toBe(1);
	});

	it("rechecks the barrier after asynchronous environment preparation", async () => {
		const failed = deferred();
		const firstEntered = deferred();
		const preparing = deferred();
		const prepared = deferred();
		let secondRuns = 0;
		let environments = 0;
		const registry = createRegistry();
		registry.install({
			name: "tools",
			tools: [
				tool("first", async () => {
					firstEntered.resolve();
					await failed.promise;
					throw new Error("uncertain");
				}),
				tool("second", async () => {
					secondRuns++;
					return {};
				}),
			],
		});
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: createModels(),
				registry,
				env: async () => {
					if (++environments === 2) {
						preparing.resolve();
						await prepared.promise;
					}
					return undefined;
				},
			},
			context,
		);
		harnesses.push(harness);
		const root = await harness.root(context);
		const first = call(harness, root, "first");
		await firstEntered.promise;
		const second = call(harness, root, "second");
		await preparing.promise;
		failed.resolve();
		await first;
		prepared.resolve();
		expect((await second).outcome).toMatchObject({ result: { blocked: "unresolved_effect" } });
		expect(secondRuns).toBe(0);
	});

	it("blocks nested mutations but leaves another ownerless branch independent", async () => {
		let effects = 0;
		const { harness, root } = await open([
			tool("uncertain", async () => {
				throw new Error("uncertain");
			}),
			tool("mutate", async () => {
				effects++;
				return {};
			}),
			tool("outer", async (_args, api, ctx) => api.callTool("mutate", {}, ctx), { effect: "read" }),
		]);
		await call(harness, root, "uncertain");
		expect((await call(harness, root, "outer")).outcome).toMatchObject({ result: { blocked: "unresolved_effect" } });
		const anchor = await root.commit((tx) => tx.appendEntry(root.id, { kind: "anchor" }), context);
		const forked = await root.fork(anchor.id, { ownership: { kind: "ownerless" } }, context);
		await call(harness, forked, "mutate");
		expect(effects).toBe(1);
	});

	it("blocks new call IDs after SIGKILL after effect, permits reads, and requires explicit recorded reconciliation", async () => {
		const dir = await directory();
		const path = join(dir, "store.sqlite");
		const count = join(dir, "effects.txt");
		await killOwner(path, count, "interrupt");
		let repeated = 0;
		const { harness, root } = await open(
			[
				tool("mutate", async () => {
					repeated++;
					return {};
				}),
				tool("read", async () => ({ structuredContent: { read: true } }), { effect: "read" }),
			],
			path,
		);
		await harness.waitForIdle(context);
		const scope = `conversation:${root.id}`;
		const state = await readToolEffects(harness, scope, context);
		expect(state?.blocked).toBeDefined();
		const effect = Object.values(state!.effects)[0]!;
		expect((await call(harness, root, "mutate")).outcome).toMatchObject({
			result: { result: { isError: true, diagnostics: [{ code: "unresolved_effect" }] } },
		});
		expect((await call(harness, root, "read")).outcome).toMatchObject({
			result: { result: { structuredContent: { read: true } } },
		});
		expect(repeated).toBe(0);
		expect(await readFile(count, "utf8")).toBe("effect\n");
		await resolveToolEffect(
			harness,
			scope,
			effect.taskId,
			"reconciled",
			"Verified external effect completed",
			context,
		);
		await call(harness, root, "mutate", {}, "explicit-new-operation");
		expect(repeated).toBe(1);
		expect((await readToolEffects(harness, scope, context))?.effects[String(effect.taskId)]).toMatchObject({
			status: "resolved",
			disposition: "reconciled",
		});
	});

	it("does not replay a result committed before SIGKILL", async () => {
		const dir = await directory();
		const path = join(dir, "store.sqlite");
		const count = join(dir, "effects.txt");
		await killOwner(path, count, "commit");
		let repeated = 0;
		const { harness, root } = await open(
			[
				tool("mutate", async () => {
					repeated++;
					return {};
				}),
			],
			path,
		);
		await harness.waitForIdle(context);
		expect(repeated).toBe(0);
		expect(await readFile(count, "utf8")).toBe("effect\n");
		expect(
			Object.values((await readToolEffects(harness, `conversation:${root.id}`, context))!.effects)[0]!.disposition,
		).toBe("completed");
	});

	it("uses identical validation, veto and structured results for nested dispatch", async () => {
		let executions = 0;
		let veto = false;
		const { harness, root } = await open(
			[
				tool("outer", async (args, api, ctx) => api.callTool("inner", args as JsonObject, ctx), {
					effect: "mutation",
					parameters: Type.Object({ value: Type.Unknown() }),
				}),
				tool(
					"inner",
					async () => {
						executions++;
						return { content: [{ type: "text", text: "ok" }], structuredContent: { full: "result" } };
					},
					{ parameters: Type.Object({ value: Type.Number() }) },
				),
			],
			undefined,
			[
				{
					id: "trust",
					compatibility: "1",
					authorize: (called) => {
						if (veto && called.name === "inner") throw new Error("veto");
					},
				},
			],
		);
		expect((await call(harness, root, "outer", { value: 3 })).outcome).toMatchObject({
			result: { result: { structuredContent: { full: "result" } } },
		});
		expect((await call(harness, root, "outer", { value: "invalid" })).outcome).toMatchObject({
			result: { result: { isError: true } },
		});
		veto = true;
		expect((await call(harness, root, "outer", { value: 4 })).outcome).toMatchObject({
			result: { result: { diagnostics: [{ code: "policy_blocked" }] } },
		});
		expect(executions).toBe(1);
	});

	it.each([
		"schema",
		"missing-policy",
		"policy-version",
		"authorization",
		"missing-implementation",
		"implementation",
	] as const)("blocks safe recovery after %s changes", async (change) => {
		const dir = await directory();
		const path = join(dir, "store.sqlite");
		const started = deferred();
		let runs = 0;
		let allowed = true;
		const policy: ToolPolicy = {
			id: "trust",
			compatibility: "1",
			authorize: () => {
				if (!allowed) throw new Error("revoked");
			},
		};
		const original = tool(
			"safe",
			async (_args, _api, ctx) => {
				runs++;
				started.resolve();
				await aborted(ctx.abortSignal!);
				return {};
			},
			{ replay: "safe", requiredPolicies: ["trust"] },
		);
		let opened = await open([original], path, [policy]);
		const id = await opened.root.commit(
			(tx) =>
				tx.createTask(
					ToolTask,
					{ name: "safe", arguments: {}, callId: "safe" },
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		opened.harness.resume();
		await started.promise;
		await opened.harness.close(context);
		harnesses.splice(harnesses.indexOf(opened.harness), 1);
		if (change === "authorization") allowed = false;
		opened = await open(
			[
				{
					...original,
					compatibility:
						change === "missing-implementation"
							? undefined
							: change === "implementation"
								? "v2"
								: original.compatibility,
					...(change === "schema" ? { parameters: Type.Object({ added: Type.String() }) } : {}),
					execute: async () => {
						runs++;
						return {};
					},
				},
			],
			path,
			change === "missing-policy" ? [] : [{ ...policy, compatibility: change === "policy-version" ? "2" : "1" }],
		);
		const outcome = (await opened.harness.waitForTask(id, context)).state.outcome;
		expect(outcome.status).toBe("failed");
		expect(runs).toBe(1);
		expect((await readToolEffects(opened.harness, `conversation:${opened.root.id}`, context))?.blocked).toBeDefined();
	});

	it("inherits a bound workflow scope across sibling conversations and rejects rebinding", async () => {
		const { harness, root } = await open([
			tool("mutate", async () => {
				throw new Error("uncertain");
			}),
		]);
		const rootTask = defineTask<Record<string, never>, { phase: "wait" }, null>({
			name: "workflow",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, _runtime, ctx) => {
					await aborted(ctx.abortSignal!);
				},
			},
			abort: async (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		let task!: TaskId;
		await root.commit(async (tx) => {
			task = await tx.createTask(rootTask, {}, { ownership: { kind: "conversation" } });
			await bindToolEffectScope(tx, task);
		}, context);
		await expect(root.commit((tx) => bindToolEffectScope(tx, task, "different"), context)).rejects.toThrow(
			"already has effect scope",
		);
		const first = await harness.createConversation({ ownership: { kind: "task", taskId: task } }, context);
		const second = await harness.createConversation({ ownership: { kind: "task", taskId: task } }, context);
		await call(harness, first, "mutate");
		expect((await call(harness, second, "mutate")).outcome).toMatchObject({
			result: { result: { diagnostics: [{ code: "unresolved_effect" }] } },
		});
		expect((await readToolEffects(harness, `task:${task}`, context))?.blocked).toBeDefined();
	});
});
