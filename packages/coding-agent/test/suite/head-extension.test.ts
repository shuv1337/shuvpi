import { fauxAssistantMessage, fauxThinking } from "@shuv1337/shuvpi-ai/compat";
import { TuiMainScreen, visibleWidth } from "@shuv1337/shuvpi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { createHeadExtension, HeadViewer } from "../../src/extensions/head/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("optional last response viewer", () => {
	beforeEach(() => initTheme("dark"));
	it("handles an empty branch and displays assistant text without thinking", async () => {
		const harness = await createHarness({ extensionFactories: [createHeadExtension()] });
		harnesses.push(harness);
		const notify = vi.fn();
		let rendered = "";
		const keys = new KeybindingsManager();
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				notify,
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) => {
					const component = await factory(new TuiMainScreen(new VirtualTerminal(80, 24)), theme, keys, () => {});
					rendered = component.render(80).join("\n");
					component.handleInput?.("q");
					return undefined as T;
				},
			}),
			"tui",
		);
		await harness.session.extensionRunner.runCommand("head");
		expect(notify).toHaveBeenCalledWith("No assistant response found", "warning");
		harness.sessionManager.appendMessage(fauxAssistantMessage("old answer"));
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxThinking("hidden thoughts"), { type: "text", text: "latest answer" }]),
		);
		harness.setResponses([fauxAssistantMessage("must stay queued")]);
		await harness.session.extensionRunner.runCommand("head");
		expect(rendered).toContain("latest answer");
		expect(rendered).not.toContain("hidden thoughts");
		expect(rendered).not.toContain("old answer");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("scrolls a long answer, clamps after resize, and respects changed or unbound shortcuts", () => {
		const terminal = { rows: 10 };
		const close = vi.fn();
		const requestRender = vi.fn();
		const keys = new KeybindingsManager({
			"app.head.close": "x",
			"app.head.down": [],
			"app.head.bottom": "z",
		});
		const viewer = new HeadViewer(
			Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n"),
			"entry1234",
			{ terminal, requestRender },
			theme,
			keys,
			close,
		);
		const first = viewer.render(80).join("\n");
		expect(first).toContain("line 0");
		viewer.handleInput("j");
		expect(viewer.render(80).join("\n")).toBe(first);
		viewer.handleInput("z");
		expect(viewer.render(80).join("\n")).toContain("line 59");
		terminal.rows = 20;
		for (const width of [24, 7, 1]) {
			const lines = viewer.render(width);
			expect(lines.length).toBeLessThanOrEqual(20);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		viewer.handleInput("g");
		expect(viewer.render(80).join("\n")).toContain("line 0");
		viewer.handleInput("q");
		expect(close).not.toHaveBeenCalled();
		viewer.handleInput("x");
		expect(close).toHaveBeenCalledOnce();
		terminal.rows = 1;
		expect(viewer.render(24)).toHaveLength(1);
		expect(viewer.render(0)).toEqual([]);
	});
});
