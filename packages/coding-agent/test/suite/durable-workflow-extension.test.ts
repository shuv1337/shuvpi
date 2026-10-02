import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@shuv1337/shuvpi-ai/compat";
import { TuiMainScreen, visibleWidth } from "@shuv1337/shuvpi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createWorkflowExtension } from "../../src/extensions/workflow/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { type CreateTestExtensionsResultInput, userMsg } from "../utilities.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const mocked = vi.hoisted(() => ({
	connect: vi.fn(),
	drain: vi.fn(),
	start: vi.fn(),
	status: vi.fn(),
	list: vi.fn(),
	cancel: vi.fn(),
}));

vi.mock("../../src/core/durable-workflows/connection.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/durable-workflows/connection.ts")>();
	return {
		...actual,
		connectDurableWorkflows: mocked.connect,
		drainWorkflowReceipts: mocked.drain,
	};
});

const harnesses: Harness[] = [];
const directories: string[] = [];
let previousAgentDir: string | undefined;

beforeEach(() => {
	initTheme("dark");
	previousAgentDir = process.env.SHUVPI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-workflow-agent-"));
	directories.push(agentDir);
	process.env.SHUVPI_CODING_AGENT_DIR = agentDir;
	mocked.start.mockReset();
	mocked.status.mockReset();
	mocked.list.mockReset();
	mocked.cancel.mockReset();
	mocked.drain.mockReset();
	mocked.connect.mockReset();
	mocked.connect.mockImplementation(async () => ({
		start: mocked.start,
		status: mocked.status,
		list: mocked.list,
		cancel: mocked.cancel,
	}));
	mocked.drain.mockResolvedValue({ persisted: 1, pending: 0, reasons: [] });
	mocked.start.mockResolvedValue({ runId: "workflow-1", taskId: 1, created: true });
	mocked.status.mockResolvedValue({
		runId: "workflow-1",
		taskId: 1,
		status: "completed",
		result: { answer: 42 },
		error: null,
		journal: { operations: [] },
	});
	mocked.list.mockResolvedValue([]);
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	if (previousAgentDir === undefined) delete process.env.SHUVPI_CODING_AGENT_DIR;
	else process.env.SHUVPI_CODING_AGENT_DIR = previousAgentDir;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function makeHarness(
	initialActiveToolNames?: string[],
	extraExtensions: Array<ExtensionFactory | CreateTestExtensionsResultInput> = [],
): Promise<Harness> {
	const directory = mkdtempSync(join(tmpdir(), "pi-workflow-session-"));
	directories.push(directory);
	const { SessionManager } = await import("../../src/core/session-manager.ts");
	const sessionManager = SessionManager.create(directory, directory);
	const harness = await createHarness({
		extensionFactories: [createWorkflowExtension(), ...extraExtensions],
		sessionManager,
		...(initialActiveToolNames === undefined ? {} : { initialActiveToolNames }),
	});
	harnesses.push(harness);
	harness.sessionManager.appendMessage(userMsg("Run a workflow"));
	return harness;
}

describe("durable workflow integration", () => {
	it("registers the model-callable tool and returns foreground output after durable settlement", async () => {
		expect(builtInExtensions.some((extension) => extension.name === "workflow")).toBe(true);
		const harness = await makeHarness();
		mocked.status.mockResolvedValueOnce({
			runId: "workflow-1",
			taskId: 1,
			status: "completed",
			result: { answer: 42 },
			error: null,
			journal: { operations: [{ index: 0, kind: "agent", status: "settled" }] },
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("workflow", { script: "return await agent('answer')", args: { topic: "life" } }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt("Use the workflow tool");
		const result = getToolResult(harness, "workflow");
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([
			{ type: "text", text: '{"runId":"workflow-1","status":"completed","result":{"answer":42},"error":null}' },
		]);
		expect(mocked.start).toHaveBeenCalledWith(
			expect.objectContaining({
				input: {
					source: "return await agent('answer')",
					args: { topic: "life" },
					agent: expect.objectContaining({ tools: ["read", "bash", "edit", "write"] }),
				},
				route: "foreground",
			}),
		);
		expect(mocked.drain).toHaveBeenCalledOnce();
	});

	it("captures the active tool allowlist for slash-command workflows", async () => {
		const harness = await makeHarness();
		await harness.session.extensionRunner.runCommand("workflow", "run background return 1;");
		expect(mocked.start).toHaveBeenCalledWith(
			expect.objectContaining({
				input: {
					source: "return 1;",
					args: null,
					agent: expect.objectContaining({ tools: ["read", "bash", "edit", "write"] }),
				},
				route: "background",
			}),
		);
	});

	it("keeps a restricted active-tool set on generated child agents", async () => {
		const harness = await makeHarness(["read"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", { script: "return await agent('answer')" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt("Use the workflow tool");
		expect(mocked.start).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({ agent: expect.objectContaining({ tools: ["read"] }) }),
			}),
		);
	});

	it("fails closed when interactive tool-call hooks guard active built-in tools", async () => {
		const harness = await makeHarness(undefined, [
			(pi) => {
				pi.on("tool_call", () => undefined);
			},
		]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", { script: "return 1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt("Use the workflow tool");

		const result = getToolResult(harness, "workflow");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("interactive tool_call hooks are not inherited"),
			}),
		]);
		expect(mocked.start).not.toHaveBeenCalled();
	});

	it("rejects MCP-only tools with interactive hooks before connecting to the owner", async () => {
		const fixtureTool: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "mcp__fixture__echo",
				label: "fixture echo",
				description: "Fixture MCP tool.",
				parameters: Type.Object({}),
				defaultActive: true,
				execute: async () => ({ content: [], details: undefined }),
			});
		};
		const hookExtension: ExtensionFactory = (pi) => {
			pi.on("tool_call", () => undefined);
		};
		const harness = await makeHarness(["mcp__fixture__echo"], [fixtureTool, hookExtension]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", { script: "return await agent('answer')" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt("Use the workflow tool");

		const result = getToolResult(harness, "workflow");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("mcp__fixture__echo"),
			}),
		]);
		expect(mocked.connect).not.toHaveBeenCalled();
		expect(mocked.start).not.toHaveBeenCalled();
	});

	it("allows the built-in MCP hook because the workflow owner applies its native policy", async () => {
		const builtinMcp: CreateTestExtensionsResultInput = {
			path: "builtin:mcp",
			factory: (pi) => {
				pi.on("tool_call", () => undefined);
			},
		};
		const harness = await makeHarness(["read"], [builtinMcp]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", { script: "return await agent('answer')" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt("Use the workflow tool");

		expect(getToolResult(harness, "workflow").isError).toBe(false);
		expect(mocked.start).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({ agent: expect.objectContaining({ tools: ["read"] }) }),
			}),
		);
	});

	it("admits a background run and returns without waiting for settlement", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("workflow", { script: "return await agent('long job')", background: true }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("Run this asynchronously");
		const result = getToolResult(harness, "workflow");
		expect(result.isError).toBe(false);
		expect(result.content.find((part) => part.type === "text")?.text).toContain(
			"Started background workflow workflow-1",
		);
		expect(mocked.start).toHaveBeenCalledWith(expect.objectContaining({ route: "background" }));
		expect(mocked.status).not.toHaveBeenCalled();
		expect(mocked.drain).not.toHaveBeenCalled();
	});

	it("keeps polling a fresh persisted-session path after its JSONL is first created", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-workflow-fresh-session-"));
		directories.push(directory);
		const { SessionManager } = await import("../../src/core/session-manager.ts");
		const sessionManager = SessionManager.create(directory, directory);
		const harness = await createHarness({ extensionFactories: [createWorkflowExtension()], sessionManager });
		harnesses.push(harness);
		expect(harness.session.extensionRunner.hasHandlers("session_start")).toBe(true);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);

		sessionManager.appendMessage(userMsg("Create the JSONL file"));
		expect(existsSync(sessionFile!)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 5100));
		expect(mocked.drain).toHaveBeenCalledOnce();
	});

	it("renders a narrow, scrollable dashboard and closes through configured keys", async () => {
		const harness = await makeHarness();
		mocked.list
			.mockResolvedValueOnce([
				{
					runId: "workflow-1",
					taskId: 1,
					status: "running",
					result: null,
					error: null,
					journal: {
						operations: Array.from({ length: 20 }, (_, index) => ({ index, kind: "agent", status: "running" })),
					},
				},
			])
			.mockResolvedValue([
				{
					runId: "workflow-1",
					taskId: 1,
					status: "completed",
					result: { output: "done" },
					error: null,
					journal: { operations: [{ index: 0, kind: "agent", status: "settled", result: { ok: true } }] },
				},
			]);
		const close = vi.fn();
		const keys = new KeybindingsManager({ "app.head.close": "x" });
		let rendered: string[][] = [];
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) => {
					const component = await factory(new TuiMainScreen(new VirtualTerminal(22, 8)), theme, keys, close);
					rendered = [component.render(22)];
					await new Promise((resolve) => setTimeout(resolve, 1050));
					rendered.push(component.render(22), component.render(7));
					component.handleInput?.("x");
					return undefined as T;
				},
			}),
			"tui",
		);
		await harness.session.extensionRunner.runCommand("workflow", "list");
		expect(rendered[0]?.join("\n")).toContain("running");
		expect(rendered[1]?.join("\n")).toContain("completed");
		expect(rendered[2]?.every((line) => visibleWidth(line) <= 7)).toBe(true);
		expect(close).toHaveBeenCalledOnce();
	});
});
