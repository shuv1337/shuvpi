import { fauxAssistantMessage, fauxToolCall } from "@shuv1337/shuvpi-ai/compat";
import { setKeybindings, TuiMainScreen, visibleWidth } from "@shuv1337/shuvpi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import {
	createQuestionnaireExtension,
	Questionnaire,
	type QuestionnaireParams,
	type QuestionnaireResult,
} from "../../src/extensions/questionnaire/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	setKeybindings(new KeybindingsManager());
});
const options = [
	{ value: "a", label: "Alpha", description: "First option" },
	{ value: "b", label: "Beta", description: "Second option" },
];
const down = "\u001b[B";
const enter = "\r";
const cancelKey = "\u001b";
const pageDown = "\u001b[6~";
const pageUp = "\u001b[5~";

describe("ask_user questionnaire", () => {
	it("returns normalized single, multi and text answers through the real tool path", async () => {
		const harness = await createHarness({ extensionFactories: [createQuestionnaireExtension()] });
		harnesses.push(harness);
		const params: QuestionnaireParams = {
			title: "Plan",
			questions: [
				{ id: "one", prompt: "Choose one", type: "single", options },
				{ id: "many", prompt: "Choose two", type: "multi", options, min: 2, max: 2 },
				{ id: "notes", prompt: "Notes", type: "text" },
			],
		};
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) => {
					let answer: T | undefined;
					const component = await factory(
						new TuiMainScreen(new VirtualTerminal()),
						theme,
						new KeybindingsManager(),
						(value) => {
							answer = value as T;
						},
					);
					for (const key of [down, enter, " ", down, " ", enter, "hello", enter]) component.handleInput?.(key);
					return answer as T;
				},
			}),
			"tui",
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_user", params), { stopReason: "toolUse" }),
			fauxAssistantMessage("got answers"),
		]);
		await harness.session.prompt("ask me");
		const result = getToolResult(harness, "ask_user");
		expect(result.isError).toBe(false);
		expect(result.details).toEqual({
			title: "Plan",
			cancelled: false,
			answers: [
				{ id: "one", type: "single", value: "b", label: "Beta" },
				{
					id: "many",
					type: "multi",
					values: [
						{ value: "a", label: "Alpha" },
						{ value: "b", label: "Beta" },
					],
				},
				{ id: "notes", type: "text", value: "hello" },
			],
		});
	});

	it("keeps selections when navigating back, enforces limits and collects custom choices", () => {
		const done = vi.fn<(result: QuestionnaireResult) => void>();
		const component = new Questionnaire(
			{
				questions: [
					{ id: "one", prompt: "One", type: "single", options, allowOther: true },
					{ id: "many", prompt: "Many", type: "multi", options, min: 1, max: 1, allowOther: true },
					{ id: "text", prompt: "Text", type: "text", multiline: true },
				],
			},
			new TuiMainScreen(new VirtualTerminal()),
			theme,
			new KeybindingsManager(),
			done,
		);
		for (const key of [down, down, enter, "custom", enter, enter]) component.handleInput(key);
		expect(component.render(80).join("\n")).toContain("Select at least 1");
		for (const key of [" ", down, " "]) component.handleInput(key);
		expect(component.render(80).join("\n")).toContain("Select at most 1");
		for (const key of [cancelKey, enter]) component.handleInput(key);
		expect(component.render(80).join("\n")).toContain("[x] Alpha");
		for (const key of ["\u001b[A", " ", down, down, " ", "custom multi", enter, enter]) component.handleInput(key);
		component.handleInput("\u001b[200~first\nsecond\u001b[201~");
		component.handleInput(enter);
		expect(done).toHaveBeenCalledOnce();
		expect(done.mock.calls[0][0]).toEqual({
			cancelled: false,
			answers: [
				{ id: "one", type: "single", value: "custom", label: "custom", wasCustom: true },
				{ id: "many", type: "multi", values: [{ value: "custom multi", label: "custom multi", wasCustom: true }] },
				{ id: "text", type: "text", value: "first\nsecond" },
			],
		});
	});

	it("exposes all long context and option details with a bounded narrow viewport", () => {
		const component = new Questionnaire(
			{
				questions: [
					{
						id: "long",
						type: "single",
						prompt: "A long question",
						context: `${"context ".repeat(200)}context-last`,
						options: [
							{
								value: "a",
								label: "A",
								description: `${"description ".repeat(70)}description-last`,
								details: `${"detail ".repeat(200)}details-last`,
							},
						],
					},
				],
			},
			new TuiMainScreen(new VirtualTerminal(24, 12)),
			theme,
			new KeybindingsManager(),
			() => {},
		);
		let combined = "";
		for (let index = 0; index < 150; index++) {
			const lines = component.render(24);
			expect(lines.length).toBeLessThanOrEqual(12);
			expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
			combined += `${lines.join("\n")}\n`;
			component.handleInput(pageDown);
		}
		expect(combined).toContain("context-last");
		expect(combined).toContain("description-last");
		expect(combined).toContain("details-last");
		for (let index = 0; index < 150; index++) component.handleInput(pageUp);
		expect(component.render(24).join("\n")).toContain("A long question");
		for (const width of [1, 2, 7])
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("honors rebound and unbound choice keys and ignores input after cancellation", () => {
		const done = vi.fn();
		const keys = new KeybindingsManager({ "app.questionnaire.toggle": "x", "tui.select.down": [] });
		const component = new Questionnaire(
			{ questions: [{ id: "multi", type: "multi", prompt: "Select", options }] },
			new TuiMainScreen(new VirtualTerminal()),
			theme,
			keys,
			done,
		);
		component.handleInput(" ");
		component.handleInput(down);
		expect(component.render(80).join("\n")).toContain("> [ ] Alpha");
		component.handleInput("x");
		expect(component.render(80).join("\n")).toContain("> [x] Alpha");
		component.handleInput(cancelKey);
		component.handleInput(enter);
		component.cancel();
		expect(done).toHaveBeenCalledOnce();
		expect(done.mock.calls[0][0].cancelled).toBe(true);
	});

	it("rejects headless use and impossible forms without opening a dialog", async () => {
		const harness = await createHarness({ extensionFactories: [createQuestionnaireExtension()] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ask_user", { questions: [{ id: "q", type: "text", prompt: "Question" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("no UI"),
		]);
		await harness.session.prompt("ask");
		expect(getToolResult(harness, "ask_user").isError).toBe(true);
		expect(JSON.stringify(getToolResult(harness, "ask_user").content)).toContain("interactive UI");
		const custom = vi.fn();
		harness.session.extensionRunner.setUIContext(createTestUiContext({ custom }), "tui");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ask_user", {
					questions: [{ id: "q", type: "multi", prompt: "Question", options, min: 2, max: 1 }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("bad form"),
		]);
		await harness.session.prompt("ask again");
		expect(getToolResult(harness, "ask_user").isError).toBe(true);
		expect(JSON.stringify(getToolResult(harness, "ask_user").content)).toContain("impossible selection limits");
		expect(custom).not.toHaveBeenCalled();
	});

	it("closes an open dialog when the tool is aborted", async () => {
		const harness = await createHarness({ extensionFactories: [createQuestionnaireExtension()] });
		harnesses.push(harness);
		let entered!: () => void;
		const opened = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const close = vi.fn();
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) =>
					new Promise<T>((resolve, reject) => {
						Promise.resolve(
							factory(new TuiMainScreen(new VirtualTerminal()), theme, new KeybindingsManager(), (value) => {
								close(value);
								resolve(value as T);
							}),
						).then(entered, reject);
					}),
			}),
			"tui",
		);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ask_user", { questions: [{ id: "q", type: "text", prompt: "Question" }] }),
				{ stopReason: "toolUse" },
			),
		]);
		const prompt = harness.session.prompt("ask");
		await opened;
		await harness.session.abort();
		await prompt;
		expect(close).toHaveBeenCalledOnce();
		expect(close.mock.calls[0][0]).toMatchObject({ cancelled: true });
	});
});
