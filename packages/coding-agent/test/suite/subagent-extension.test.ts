import { fauxAssistantMessage, fauxToolCall } from "@shuv1337/shuvpi-ai";
import { TuiMainScreen, visibleWidth } from "@shuv1337/shuvpi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { SubagentBackend, SubagentEvent } from "../../src/core/subagents/types.ts";
import claudeExtension from "../../src/extensions/subagents/claude.ts";
import { createSubagentsExtension } from "../../src/extensions/subagents/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
});
async function setup() {
	let callback: ((event: SubagentEvent) => void) | undefined;
	const sends: Array<{ prompt: string; steer: boolean; run: number }> = [];
	const close = vi.fn();
	const interrupt = vi.fn();
	const backend: SubagentBackend = {
		name: "pi",
		async create(_request, emit) {
			callback = emit;
			return {
				async send(prompt, steer, run) {
					sends.push({ prompt, steer, run });
				},
				async interrupt() {
					interrupt();
				},
				async close() {
					close();
				},
			};
		},
	};
	const harness = await createHarness({ extensionFactories: [createSubagentsExtension({ backends: [backend] })] });
	harnesses.push(harness);
	return {
		harness,
		sends,
		close,
		interrupt,
		emit: (event: SubagentEvent) => {
			if (!callback) throw new Error("Missing child");
			callback(event);
		},
	};
}
describe("optional subagent extension", () => {
	it("imports the concrete Claude SDK entry without starting a provider", () => {
		expect(typeof claudeExtension).toBe("function");
	});
	it("delivers one completion during a busy parent turn", async () => {
		const fixture = await setup();
		const { harness } = fixture;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent_spawn", { prompt: "child", title: "fixture" })], {
				stopReason: "toolUse",
			}),
			() => {
				fixture.emit({ type: "settled", run: 1, status: "done", output: "child done" });
				fixture.emit({ type: "settled", run: 1, status: "done", output: "duplicate" });
				return fauxAssistantMessage("parent done");
			},
			fauxAssistantMessage("received child"),
		]);
		await harness.session.prompt("start child");
		const receipts = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-result");
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ details: { status: "done", output: "child done" } });
	});
	it("suppresses old callbacks through real reload and uses a fresh manager", async () => {
		const fixture = await setup();
		const { harness } = fixture;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent_spawn", { prompt: "hold" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("running"),
		]);
		await harness.session.prompt("start child");
		await harness.session.reload();
		expect(fixture.close).toHaveBeenCalled();
		fixture.emit({ type: "settled", run: 1, status: "done", output: "stale" });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
		const notify = vi.fn();
		harness.session.extensionRunner.setUIContext(createTestUiContext({ notify }), "tui");
		await harness.session.extensionRunner.runCommand("subagents");
		expect(notify).toHaveBeenCalledWith("No subagents", "info");
	});
	it("shows a narrow transcript, steers, cancels and returns input to the parent", async () => {
		initTheme("dark");
		const fixture = await setup();
		const { harness } = fixture;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent_spawn", { prompt: "hold", title: "child" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("running"),
			fauxAssistantMessage("cancel received"),
		]);
		await harness.session.prompt("start child");
		fixture.emit({ type: "text", run: 1, text: `\u001b[31m${"child text ".repeat(80)}\u001b[0m` });
		const actions = ["Transcript", "Send message", "Cancel"];
		const done = vi.fn();
		const rendered: string[][] = [];
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				select: async (title, choices) =>
					title === "Subagents" ? (actions.length ? choices[0] : undefined) : actions.shift(),
				input: async () => "steer child",
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) => {
					for (const [width, rows] of [
						[7, 3],
						[22, 8],
						[80, 24],
					]) {
						const tui = new TuiMainScreen(new VirtualTerminal(width, rows));
						const component = await factory(
							tui,
							theme,
							new KeybindingsManager({ "tui.select.cancel": "x" }),
							done,
						);
						rendered.push(component.render(width));
						component.handleInput?.("\u001b[6~");
						component.handleInput?.("x");
						tui.stop();
					}
					return undefined as T;
				},
			}),
			"tui",
		);
		await harness.session.extensionRunner.runCommand("subagents");
		await harness.session.agent.waitForIdle();
		expect(rendered[0].every((line) => visibleWidth(line) <= 7)).toBe(true);
		expect(rendered[1].every((line) => visibleWidth(line) <= 22)).toBe(true);
		expect(done).toHaveBeenCalledTimes(3);
		expect(fixture.sends.at(-1)).toMatchObject({ prompt: "steer child", steer: true, run: 1 });
		expect(fixture.interrupt).toHaveBeenCalledOnce();
	});
});
