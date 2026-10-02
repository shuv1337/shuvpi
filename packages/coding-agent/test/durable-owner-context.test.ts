import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@shuv1337/shuvpi-ai";
import { getCurrentTools } from "@shuv1337/shuvpi-ai/utils/transcript";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import {
	configure,
	createRegistry,
	defineTool,
	Harness,
	type JsonObject,
	MemoryStorage,
	type ToolPolicy,
} from "@shuv1337/shuvpi-durable";
import { openNodeSqliteStorage } from "@shuv1337/shuvpi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import {
	isWorkflowAgentContext,
	WorkflowCapabilitiesDoc,
	WorkflowOwnerContext,
} from "../src/core/durable-workflows/owner-context.ts";
import { installWorkflowMcp } from "../src/core/durable-workflows/owner-mcp.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

function directory() {
	const path = mkdtempSync(join(tmpdir(), "shuvpi-owner-context-"));
	cleanup.push(async () => rmSync(path, { recursive: true, force: true }));
	return path;
}

async function setup(exposure: "direct" | "codemode" = "direct", policies: ToolPolicy[] = [], projectTrusted = false) {
	const cwd = directory();
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".shuvpi"));
	const callsFile = join(cwd, "calls.jsonl");
	writeFileSync(callsFile, "");
	const server = {
		command: process.execPath,
		args: [
			"--experimental-strip-types",
			new URL("./fixtures/durable-mcp-server.ts", import.meta.url).pathname,
			callsFile,
		],
		exposure,
	};
	const config = {
		mcpServers: {
			fixture: server,
			disabled: { command: "must-not-launch", enabled: false },
			hidden: { command: "must-not-launch", exposure: "hidden" },
		},
	};
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(config));
	const projectConfigPath = join(cwd, ".shuvpi", "mcp.json");
	writeFileSync(
		projectConfigPath,
		JSON.stringify({
			mcpServers: projectTrusted
				? { project: server, fixture: server }
				: { hostile: { command: "must-not-launch" }, fixture: { command: "must-not-launch" } },
		}),
	);
	const registry = createRegistry();
	const mcp = await installWorkflowMcp(registry, { cwd, agentDir, projectTrusted });
	cleanup.push(mcp.close);
	const defaults = { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "high" as const };
	const owner = new WorkflowOwnerContext(registry, defaults, [mcp.policy, ...policies]);
	const input = owner.prepareInput({ source: "return 1;", args: {} });
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		new MemoryStorage(),
		{ registry, models, toolPolicies: owner.toolPolicies },
		context,
	);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: defaults });
	await harness.commit(async (tx) => {
		const tools = await owner.bind(tx, root.id, input.agent);
		await configure(tx, root.id, { ...defaults, tools });
	}, context);
	harness.resume();
	let ordinal = 0;
	const run = async (name: string, args: JsonObject) => {
		const id = `owner-${++ordinal}`;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await submission.wait(context);
		const entries = await root.entries({}, 1000, undefined, context);
		const result = entries.items
			.flatMap((entry) => entry.model ?? [])
			.find((message) => message.role === "toolResult" && message.toolCallId === id);
		if (!result || result.role !== "toolResult") throw new Error("No owner tool result");
		return result;
	};
	return {
		owner,
		registry,
		harness,
		root,
		faux,
		input,
		run,
		config,
		agentDir,
		projectConfigPath,
		calls: () => readFileSync(callsFile, "utf8"),
	};
}

describe("detached workflow owner context", () => {
	it("includes trusted project MCP and keeps its configuration scope authoritative during dispatch", async () => {
		const state = await setup("direct", [], true);
		expect(state.input.agent!.tools).toEqual(["codemode", "mcp__fixture__echo", "mcp__project__echo"]);
		expect((await state.run("mcp__project__echo", { text: "trusted-project" })).isError).toBe(false);
		expect(
			(await state.run("codemode", { code: 'return await tools.mcp__fixture__echo({text:"trusted-override"});' }))
				.isError,
		).toBe(false);
		writeFileSync(state.projectConfigPath, JSON.stringify({ mcpServers: {} }));
		expect((await state.run("mcp__project__echo", { text: "revoked-project" })).isError).toBe(true);
		// Identical global configuration cannot silently replace the captured trusted-project authority.
		expect((await state.run("mcp__fixture__echo", { text: "changed-scope" })).isError).toBe(true);
		expect(state.calls()).toBe('{"text":"trusted-project"}\n{"text":"trusted-override"}\n');
	});

	it("loads only authorized global MCP and uses one Harness for direct and sandbox dispatch", async () => {
		const state = await setup();
		expect(state.input.agent).toMatchObject({
			model: { provider: "faux", modelId: "faux-1" },
			effort: "high",
			tools: ["codemode", "mcp__fixture__echo"],
		});
		expect((await state.run("mcp__fixture__echo", { text: "direct" })).structuredContent).toMatchObject({
			structuredContent: { echo: "direct" },
		});
		const nested = await state.run("codemode", {
			code: 'const r = await tools.mcp__fixture__echo({text:"nested"}); return r.structuredContent.echo;',
		});
		expect(nested.isError).toBe(false);
		expect(state.calls()).toBe('{"text":"direct"}\n{"text":"nested"}\n');
		const mcp = state.registry
			.snapshot()
			.tools()
			.find(({ tool }) => tool.name === "mcp__fixture__echo")!.tool;
		expect(mcp).toMatchObject({ effect: "mutation", replay: "unsafe" });
		expect(await state.harness.snapshot(WorkflowCapabilitiesDoc, state.root.id, context)).toEqual({
			capabilities: state.input.agent!.capabilities,
		});
	});

	it("rejects missing policy callbacks, forged capabilities, unavailable tools, and captures a narrowed per-run snapshot", async () => {
		const state = await setup();
		expect(() =>
			state.owner.prepareInput({
				source: "return 1;",
				args: {},
				agent: { requiredPolicies: [{ id: "interactive-approval", compatibility: "1" }] },
			}),
		).toThrow(/missing or incompatible/);
		expect(() => state.owner.prepareInput({ ...state.input })).toThrow(/caller-supplied capabilities/);
		expect(() =>
			state.owner.prepareInput({ source: "return 1;", args: {}, agent: { tools: ["mcp__hostile__echo"] } }),
		).toThrow(/unavailable/);
		const narrowed = state.owner.prepareInput({
			source: "return 1;",
			args: {},
			agent: { tools: ["codemode"], model: { provider: "other", modelId: "other-model" }, effort: "low" },
		});
		expect(narrowed.agent).toMatchObject({
			tools: ["codemode"],
			model: { provider: "other", modelId: "other-model" },
			effort: "low",
			capabilities: { tools: [{ name: "codemode" }] },
		});
		expect(state.input.agent!.tools).toEqual(["codemode", "mcp__fixture__echo"]);
		expect(isWorkflowAgentContext(narrowed.agent)).toBe(true);
		expect(isWorkflowAgentContext(narrowed.agent, false)).toBe(false);
		const codemode = state.registry
			.snapshot()
			.tools()
			.find(({ tool }) => tool.name === "codemode")!.tool;
		for (const tools of [
			[codemode],
			{
				remove: state.registry
					.snapshot()
					.tools()
					.filter(({ tool }) => tool.name !== "codemode")
					.map(({ tool }) => tool),
			},
		]) {
			const limited = new WorkflowOwnerContext(state.registry, { tools });
			expect(limited.prepareInput({ source: "return 1;", args: {} }).agent!.tools).toEqual(["codemode"]);
			expect(() =>
				limited.prepareInput({ source: "return 1;", args: {}, agent: { tools: ["mcp__fixture__echo"] } }),
			).toThrow(/unavailable/);
		}
		expect(state.calls()).toBe("");
	});

	it("keeps codemode-only tools discoverable without declaring them as direct model tools", async () => {
		const state = await setup("codemode");
		const nested = await state.run("codemode", {
			code: 'const matches = searchTools("echo"); const r = await tools.mcp__fixture__echo({text:"discovered"}); return {matches, result:r.structuredContent};',
		});
		expect(nested.isError).toBe(false);
		const entries = await state.root.entries({}, 1000, undefined, context);
		const messages = entries.items.toReversed().flatMap((entry) => entry.model ?? []);
		expect(getCurrentTools(messages).map((tool) => tool.name)).toEqual(["codemode"]);
		expect(JSON.stringify(messages)).toContain("describeNamespace()");
		expect(state.calls()).toContain("discovered");
	});

	it("checks required policy callbacks on direct and nested dispatch", async () => {
		const calls: string[] = [];
		const state = await setup("direct", [
			{
				id: "approval",
				compatibility: "1",
				authorize(call, _context, api) {
					if (call.name !== "mcp__fixture__echo") return;
					calls.push(`${api.conversationId}:${call.arguments.text}`);
					throw new Error("headless approval denied");
				},
			},
		]);
		expect((await state.run("mcp__fixture__echo", { text: "direct" })).isError).toBe(true);
		expect((await state.run("codemode", { code: 'await tools.mcp__fixture__echo({text:"nested"});' })).isError).toBe(
			true,
		);
		expect(calls).toEqual([`${state.root.id}:direct`, `${state.root.id}:nested`]);
		expect(state.calls()).toBe("");
	});

	it("blocks config revocation and changed implementations before the remote effect", async () => {
		const state = await setup();
		writeFileSync(join(state.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
		expect((await state.run("mcp__fixture__echo", { text: "revoked" })).isError).toBe(true);
		expect(
			(await state.run("codemode", { code: 'await tools.mcp__fixture__echo({text:"revoked-nested"});' })).isError,
		).toBe(true);
		writeFileSync(join(state.agentDir, "mcp.json"), JSON.stringify(state.config));
		const extension = state.registry.snapshot().extension("coding-agent.workflow-mcp")!;
		state.registry.install({
			...extension,
			tools: extension.tools!.map((tool) => ({ ...tool, compatibility: "different-implementation" })),
		});
		expect((await state.run("mcp__fixture__echo", { text: "changed" })).isError).toBe(true);
		expect(state.calls()).toBe("");
	});

	it("preserves the captured callback identity and reruns authorization after SQLite reopen", async () => {
		for (const change of ["same", "deny", "changed", "missing"] as const) {
			const cwd = directory();
			const path = join(cwd, "owner.sqlite");
			const registry = createRegistry();
			const started = Promise.withResolvers<void>();
			let executions = 0;
			let denied = false;
			registry.install({
				name: "safe-fixture",
				tools: [
					defineTool({
						name: "safe_read",
						description: "Fixture read",
						parameters: Type.Object({}),
						effect: "read",
						replay: "safe",
						compatibility: "1",
						async execute(_args, _api, context) {
							executions++;
							if (executions === 1) {
								started.resolve();
								await new Promise((_resolve, reject) =>
									context.abortSignal!.addEventListener("abort", () => reject(context.abortSignal!.reason), {
										once: true,
									}),
								);
							}
							return { content: [{ type: "text", text: "read" }] };
						},
					}),
				],
			});
			const policy = {
				id: "headless",
				compatibility: "1",
				authorize() {
					if (denied) throw new Error("revoked");
				},
			};
			const defaults = { model: { provider: "faux", modelId: "faux-1" } };
			let owner = new WorkflowOwnerContext(registry, defaults, [policy]);
			const input = owner.prepareInput({ source: "return 1;", args: {} });
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("safe_read", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			let harness = await Harness.open(
				await openNodeSqliteStorage(path),
				{ registry, models, toolPolicies: owner.toolPolicies },
				context,
			);
			cleanup.push(() => harness.close(context));
			const root = await harness.root(context, { agent: defaults });
			await harness.commit(async (tx) => {
				const tools = await owner.bind(tx, root.id, input.agent);
				await configure(tx, root.id, { ...defaults, tools });
			}, context);
			harness.resume();
			const submitted = await root.submit({ type: "input", content: "go" }, context);
			await started.promise;
			await harness.close(context);
			denied = change === "deny";
			owner = new WorkflowOwnerContext(
				registry,
				defaults,
				change === "missing" ? [] : [{ ...policy, compatibility: change === "changed" ? "2" : "1" }],
			);
			harness = await Harness.open(
				await openNodeSqliteStorage(path),
				{ registry, models, toolPolicies: owner.toolPolicies },
				context,
			);
			harness.resume();
			const settled = await (await harness.submission(submitted.id, context))!.wait(context);
			expect(settled.status).toBe(change === "same" ? "done" : "unanswered");
			expect(executions).toBe(change === "same" ? 2 : 1);
			await harness.close(context);
		}
	});
});
