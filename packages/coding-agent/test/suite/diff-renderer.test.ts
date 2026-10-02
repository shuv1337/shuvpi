import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@shuv1337/shuvpi-ai/compat";
import { TuiMainScreen, visibleWidth } from "@shuv1337/shuvpi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { createDiffRendererExtension } from "../../src/extensions/diff-renderer/index.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
beforeEach(() => initTheme("dark"));
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("optional edit diff renderer", () => {
	it.each([
		["CJK", "界", "語"],
		["emoji", "👩‍💻", "🧑‍🔬"],
		["emoji sharing a UTF-16 prefix", "😀", "😃"],
		["combining characters", "e\u0301", "a\u0308"],
		["changed combining marks", "e\u0301", "e\u0300"],
	])("preserves every %s grapheme when split diff cells wrap", async (_name, oldToken, newToken) => {
		const harness = await createHarness({ extensionFactories: [createDiffRendererExtension()] });
		harnesses.push(harness);
		const path = "unicode.unknown";
		const oldText = oldToken.repeat(100);
		const newText = newToken.repeat(100);
		await writeFile(join(harness.tempDir, path), `${oldText}\n`);
		const args = { path, edits: [{ oldText, newText }] };
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", args), { stopReason: "toolUse" }),
			fauxAssistantMessage("edited"),
		]);
		await harness.session.prompt("edit Unicode line");
		const result = getToolResult(harness, "edit");
		expect(result.isError).toBe(false);
		const definition = harness.session.extensionRunner
			.getAllRegisteredTools()
			.find((tool) => tool.definition.name === "edit")!.definition;
		const component = new ToolExecutionComponent(
			"edit",
			result.toolCallId,
			args,
			{},
			definition,
			new TuiMainScreen(new VirtualTerminal()),
			harness.tempDir,
		);
		component.updateResult(result, false);
		for (const width of [79, 84, 100, 120]) {
			const lines = component.render(width);
			const rendered = stripVTControlCharacters(Buffer.from(lines.join("\n"), "utf8").toString("utf8"));
			expect(rendered).not.toContain("�");
			expect(rendered.split(oldToken).length - 1).toBe(100);
			expect(rendered.split(newToken).length - 1).toBe(100);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("renders incomplete arguments and a streaming result", async () => {
		const harness = await createHarness({ extensionFactories: [createDiffRendererExtension()] });
		harnesses.push(harness);
		const definition = harness.session.extensionRunner
			.getAllRegisteredTools()
			.find((tool) => tool.definition.name === "edit")!.definition;
		const component = new ToolExecutionComponent(
			"edit",
			"partial",
			{},
			{},
			definition,
			new TuiMainScreen(new VirtualTerminal()),
			harness.tempDir,
		);
		expect(component.render(24).join("\n")).toContain("edit");
		component.updateResult({ content: [], details: undefined, isError: false }, true);
		expect(component.render(48).join("\n")).toContain("Applying edit");
	});
	it.each(["with spaces.ts", "unknown.filetype"])(
		"uses native edit execution and renders %s at wide and narrow widths",
		async (path) => {
			const harness = await createHarness({ extensionFactories: [createDiffRendererExtension()] });
			harnesses.push(harness);
			await writeFile(join(harness.tempDir, path), 'const value = "before";\nconst keep = "界";\n');
			const args = { path, edits: JSON.stringify([{ oldText: "before", newText: "after" }]) };
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("edit", args), { stopReason: "toolUse" }),
				fauxAssistantMessage("edited"),
			]);
			await harness.session.prompt("make the edit");
			expect(await readFile(join(harness.tempDir, path), "utf8")).toBe(
				'const value = "after";\nconst keep = "界";\n',
			);
			const result = getToolResult(harness, "edit");
			expect(result.isError).toBe(false);
			const definition = harness.session.extensionRunner
				.getAllRegisteredTools()
				.find((tool) => tool.definition.name === "edit")!.definition;
			const component = new ToolExecutionComponent(
				"edit",
				result.toolCallId,
				args,
				{},
				definition,
				new TuiMainScreen(new VirtualTerminal()),
				harness.tempDir,
			);
			component.updateResult(result, false);
			const wide = component.render(120).join("\n");
			expect(wide).toContain("before");
			expect(wide).toContain("after");
			expect(wide).toContain("old");
			expect(wide).toContain("new");
			for (const width of [120, 48, 24]) {
				const lines = component.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
			expect(component.render(48).join("\n")).toContain("after");
		},
	);

	it("renders failures from isError even when the message has no error prefix", async () => {
		const harness = await createHarness({ extensionFactories: [createDiffRendererExtension()] });
		harnesses.push(harness);
		const args = { path: "missing file.txt", edits: [{ oldText: "before", newText: "after" }] };
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", args), { stopReason: "toolUse" }),
			fauxAssistantMessage("failed"),
		]);
		await harness.session.prompt("attempt edit");
		const result = getToolResult(harness, "edit");
		expect(result.isError).toBe(true);
		const definition = harness.session.extensionRunner
			.getAllRegisteredTools()
			.find((tool) => tool.definition.name === "edit")!.definition;
		const component = new ToolExecutionComponent(
			"edit",
			result.toolCallId,
			args,
			{},
			definition,
			new TuiMainScreen(new VirtualTerminal()),
			harness.tempDir,
		);
		component.updateResult(result, false);
		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("Could not edit file");
		expect(rendered).not.toContain("Edit applied");
	});
});
