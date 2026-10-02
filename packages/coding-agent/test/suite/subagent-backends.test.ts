import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@shuv1337/shuvpi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClaudeSubagentQueryOptions, createClaudeSubagentBackend } from "../../src/core/subagents/claude.ts";
import { createCodexSubagentBackend } from "../../src/core/subagents/codex.ts";
import { SubagentManager } from "../../src/core/subagents/manager.ts";
import { createPiSubagentBackend } from "../../src/core/subagents/pi.ts";
import type { SubagentBackend, SubagentEvent, SubagentRequest } from "../../src/core/subagents/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const managers: SubagentManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function setup(backends: SubagentBackend[]) {
	const harness = await createHarness({ models: [{ id: "reasoning-fixture", reasoning: true }] });
	harnesses.push(harness);
	const manager = new SubagentManager(backends);
	managers.push(manager);
	const request: Omit<SubagentRequest, "signal"> = {
		parent: harness.session.extensionRunner.createContext(),
		cwd: harness.tempDir,
		title: "fixture",
		prompt: "hello",
	};
	return { harness, manager, request };
}
function fakeBackend() {
	const callbacks: Array<(event: SubagentEvent) => void> = [];
	const sends: Array<{ prompt: string; steer: boolean; run: number }> = [];
	const backend: SubagentBackend = {
		name: "pi",
		async create(_request, emit) {
			callbacks.push(emit);
			return {
				async send(prompt, steer, run) {
					sends.push({ prompt, steer, run });
				},
				async interrupt() {},
				async close() {},
			};
		},
	};
	return { backend, callbacks, sends };
}
describe("subagent lifecycle", () => {
	it("reserves across concurrent managers and permits steering without taking a fifth slot", async () => {
		const fake = fakeBackend();
		const { manager, request } = await setup([fake.backend]);
		const other = new SubagentManager([fake.backend]);
		managers.push(other);
		const four = await Promise.all(Array.from({ length: 4 }, () => manager.spawn("pi", request)));
		await expect(other.spawn("pi", request)).rejects.toThrow("At most 4");
		await manager.send(four[0].id, "steer");
		expect(fake.sends.at(-1)).toMatchObject({ steer: true, run: 1 });
		fake.callbacks[0]({ type: "settled", run: 1, status: "done", output: "first" });
		expect(await manager.wait(four[0].id)).toMatchObject({ status: "done", output: "first" });
		await manager.send(four[0].id, "follow up");
		fake.callbacks[0]({ type: "settled", run: 1, status: "done", output: "stale" });
		expect(manager.get(four[0].id)).toMatchObject({ status: "running", run: 2, output: "" });
		await manager.cancel(four[0].id);
		await other.spawn("pi", request);
	});
	it("holds startup reservations until cancelled backend creation has actually unwound", async () => {
		const gate = Promise.withResolvers<void>();
		let closed = 0;
		const backend: SubagentBackend = {
			name: "pi",
			async create() {
				await gate.promise;
				return {
					async send() {
						throw new Error("must not run");
					},
					async interrupt() {},
					async close() {
						closed++;
					},
				};
			},
		};
		const { manager, request } = await setup([backend]);
		const starts = Array.from({ length: 4 }, () => manager.spawn("pi", request).catch(() => undefined));
		const closing = manager.close();
		const other = new SubagentManager([fakeBackend().backend]);
		managers.push(other);
		await expect(other.spawn("pi", request)).rejects.toThrow("At most 4");
		gate.resolve();
		await Promise.all(starts);
		await closing;
		expect(closed).toBeGreaterThanOrEqual(4);
		await other.spawn("pi", request);
	});
	it("wait cancellation leaves the run active and terminal notifications are deduplicated", async () => {
		const fake = fakeBackend();
		const { manager, request } = await setup([fake.backend]);
		let delivered = 0;
		manager.onSettled(() => delivered++);
		const child = await manager.spawn("pi", request);
		const abort = new AbortController();
		const wait = manager.wait(child.id, abort.signal);
		abort.abort(new Error("wait cancelled"));
		await expect(wait).rejects.toThrow("wait cancelled");
		expect(manager.get(child.id).status).toBe("running");
		fake.callbacks[0]({ type: "settled", run: 1, status: "error", output: "", error: "fixture" });
		fake.callbacks[0]({ type: "settled", run: 1, status: "error", output: "", error: "fixture" });
		expect(delivered).toBe(1);
		expect(await manager.wait(child.id)).toMatchObject({ status: "error", error: "fixture" });
	});
});
describe("Pi SDK child", () => {
	it("inherits model and effort with an isolated transcript and excludes orchestration and prompt tools", async () => {
		const { harness, manager, request } = await setup([createPiSubagentBackend()]);
		harness.settingsManager.setProjectTrusted(true);
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "trusted-child-context-marker");
		harness.sessionManager.appendMessage({ role: "user", content: "parent private history", timestamp: Date.now() });
		harness.setResponses([
			(context, options, _state, model) => {
				expect(model.id).toBe(harness.getModel().id);
				expect(options?.reasoning).toBe("high");
				expect(JSON.stringify(context.messages)).not.toContain("parent private history");
				expect(JSON.stringify(context)).toContain("trusted-child-context-marker");
				expect(
					context.messages
						.flatMap((message) =>
							message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
						)
						.sort(),
				).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
				return fauxAssistantMessage("isolated reply");
			},
		]);
		const child = await manager.spawn("pi", { ...request, effort: "high" });
		const settled = await manager.wait(child.id);
		expect(settled.error).toBeUndefined();
		expect(settled).toMatchObject({ status: "done", output: "isolated reply" });
		expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(false);
		expect(child.sessionId).not.toBe(harness.sessionManager.getSessionId());
	});
	it("does not load alternate-directory instructions or extensions as trusted parent resources", async () => {
		const { harness, manager, request } = await setup([createPiSubagentBackend()]);
		harness.settingsManager.setProjectTrusted(true);
		const alternate = join(harness.tempDir, "alternate");
		mkdirSync(join(alternate, ".shuvpi", "extensions"), { recursive: true });
		writeFileSync(join(alternate, "AGENTS.md"), "untrusted-child-context-marker");
		writeFileSync(join(alternate, ".shuvpi", "extensions", "bad.ts"), "throw new Error('must not load');");
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context)).not.toContain("untrusted-child-context-marker");
				return fauxAssistantMessage("alternate okay");
			},
		]);
		const child = await manager.spawn("pi", { ...request, cwd: alternate });
		const settled = await manager.wait(child.id);
		expect(settled.error).toBeUndefined();
		expect(settled).toMatchObject({ status: "done", output: "alternate okay" });
	});
});
describe("Claude SDK adapter", () => {
	it("uses default permission policy, preserves session resume and reports stream errors", async () => {
		const calls: ClaudeSubagentQueryOptions[] = [];
		const backend = createClaudeSubagentBackend((input) => {
			calls.push(input);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "system", session_id: "claude-1" };
					yield { type: "assistant", message: { content: [{ type: "text", text: "reply" }] } };
					yield { type: "result", is_error: calls.length === 2, result: "reply" };
				},
				async interrupt() {},
				close() {},
			};
		});
		const { manager, request } = await setup([backend]);
		const child = await manager.spawn("claude", request);
		expect(await manager.wait(child.id)).toMatchObject({ status: "done", output: "reply", sessionId: "claude-1" });
		await manager.send(child.id, "follow up");
		expect(await manager.wait(child.id)).toMatchObject({ status: "error" });
		expect(calls[0].options).toMatchObject({
			permissionMode: "default",
			disallowedTools: ["Agent", "Task", "AskUserQuestion"],
		});
		expect(calls[1].options.resume).toBe("claude-1");
	});
	it("interrupts and closes a live SDK stream before releasing the running slot", async () => {
		const gate = Promise.withResolvers<void>();
		let interrupted = 0;
		const backend = createClaudeSubagentBackend(() => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "system", session_id: "claude-2" };
				await gate.promise;
			},
			async interrupt() {
				interrupted++;
				gate.resolve();
			},
			close() {
				gate.resolve();
			},
		}));
		const { manager, request } = await setup([backend]);
		const child = await manager.spawn("claude", request);
		expect(await manager.cancel(child.id)).toMatchObject({ status: "aborted" });
		expect(interrupted).toBe(1);
	});
});
describe("Codex app-server v2", () => {
	it("initializes, steers, interrupts, reports RPC errors and kills descendants", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const log = join(harness.tempDir, "rpc.jsonl");
		const manager = new SubagentManager([
			createCodexSubagentBackend({
				command: process.execPath,
				args: [fileURLToPath(new URL("../fixtures/codex-subagent.cjs", import.meta.url)), log],
				requestTimeoutMs: 1000,
			}),
		]);
		managers.push(manager);
		const request = {
			parent: harness.session.extensionRunner.createContext(),
			cwd: harness.tempDir,
			title: "codex",
			prompt: "hold",
			model: "fixture-model",
			effort: "high" as const,
		};
		const child = await manager.spawn("codex", request);
		await manager.send(child.id, "steer");
		expect(await manager.wait(child.id)).toMatchObject({ status: "done", output: "initial:steered" });
		await manager.send(child.id, "hold");
		expect(await manager.cancel(child.id)).toMatchObject({ status: "aborted" });
		await expect(manager.send(child.id, "error")).rejects.toThrow("fixture failure");
		const calls = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(calls.map((call) => call.method)).toContain("initialized");
		expect(calls.find((call) => call.method === "thread/start").params).toMatchObject({
			approvalPolicy: "never",
			sandbox: "read-only",
		});
		expect(calls.find((call) => call.method === "turn/steer").params.expectedTurnId).toBe("turn-1");
		const pid = Number(readFileSync(`${log}.pid`, "utf8"));
		await manager.close();
		if (process.platform === "linux")
			await vi.waitFor(() => {
				let state = "";
				try {
					state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0];
				} catch {}
				expect(["", "Z"]).toContain(state);
			});
	});
});
