import { type Keybinding, setKeybindings, visibleWidth } from "@shuv1337/shuvpi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface ModelState {
	id: string;
	name: string;
	enabled: boolean;
}

function getMarkerStates(selector: ScopedModelsSelectorComponent, models: ModelState[]): boolean[] {
	const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
	return models.map((model) => {
		const line = lines.find((candidate) => candidate.includes(`${model.id} [`));
		if (!line) throw new Error(`Expected rendered row for ${model.id}`);
		return line.slice(2).startsWith("✓ ");
	});
}

describe("scoped models selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	async function createSelector(models: ModelState[]) {
		harness = await createHarness({ models });
		const provider = harness.models[0].provider;
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: models.filter((model) => model.enabled).map((model) => `${provider}/${model.id}`),
			},
			{
				onChange: (enabledModelIds) => {
					for (const model of models) {
						model.enabled = enabledModelIds === null || enabledModelIds.includes(`${provider}/${model.id}`);
					}
				},
				onPersist: () => {},
				onCancel: () => {},
			},
		);
		return selector;
	}

	it("marks every model after enabling all", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: false },
			{ id: "model-c", name: "Model C", enabled: false },
		];
		const selector = await createSelector(models);

		selector.handleInput("\x01");

		expect(models.map((model) => model.enabled)).toEqual([true, true, true]);
		expect(getMarkerStates(selector, models)).toEqual([true, true, true]);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("all enabled");
	});

	it("disables only the selected model after enabling all", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: false },
			{ id: "model-c", name: "Model C", enabled: false },
		];
		const selector = await createSelector(models);

		selector.handleInput("\x01");
		selector.handleInput("\r");

		expect(models.map((model) => model.enabled)).toEqual([false, true, true]);
		expect(getMarkerStates(selector, models)).toEqual([false, true, true]);
	});

	it("enables only the selected model after clearing all", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: true },
			{ id: "model-c", name: "Model C", enabled: true },
		];
		const selector = await createSelector(models);

		selector.handleInput("\x18");
		expect(models.map((model) => model.enabled)).toEqual([false, false, false]);
		expect(getMarkerStates(selector, models)).toEqual([false, false, false]);

		selector.handleInput("\r");
		expect(models.map((model) => model.enabled)).toEqual([true, false, false]);
		expect(getMarkerStates(selector, models)).toEqual([true, false, false]);
	});

	it("restores the all-enabled state after re-enabling the last disabled model", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: false },
			{ id: "model-c", name: "Model C", enabled: false },
		];
		const selector = await createSelector(models);

		selector.handleInput("\x01"); // enable all -> null
		selector.handleInput("\r"); // disable model-a; enabled models re-sort first: [b, c, a]
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B"); // move selection back to model-a
		selector.handleInput("\r"); // re-enable model-a

		expect(models.map((model) => model.enabled)).toEqual([true, true, true]);
		expect(getMarkerStates(selector, models)).toEqual([true, true, true]);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("all enabled");
	});

	it.each([24, 80])("omits every disabled action hint at width %i", async (width) => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.confirm": [],
				"app.models.enableAll": [],
				"app.models.clearAll": [],
				"app.models.toggleProvider": [],
				"app.models.reorderUp": [],
				"app.models.reorderDown": [],
				"app.models.save": [],
			}),
		);
		const selector = await createSelector([{ id: "model-a", name: "Model A", enabled: true }]);
		const lines = selector.render(width);
		const text = stripAnsi(lines.join(" ")).replace(/\s+/gu, " ");
		expect(text).toContain("Session-only.");
		expect(text).not.toMatch(/toggle| clear| provider|reorder|save to settings| save/u);
		expect(text).not.toContain("·");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it.each([
		["tui.select.confirm", "toggle"],
		["app.models.enableAll", "all"],
		["app.models.clearAll", "clear"],
		["app.models.toggleProvider", "provider"],
		["app.models.save", "save"],
	] satisfies [Keybinding, string][])("shows the configured %s shortcut", async (action, label) => {
		setKeybindings(
			new KeybindingsManager({ [action]: "ctrl+y", "app.models.reorderUp": [], "app.models.reorderDown": "ctrl+r" }),
		);
		const selector = await createSelector([{ id: "model-a", name: "Model A", enabled: true }]);
		const text = stripAnsi(selector.render(80).join(" ")).replace(/\s+/gu, " ");
		expect(text).toContain(`Ctrl+Y ${label}`);
		expect(text).toContain("Ctrl+R reorder");
		expect(text).not.toContain("/Ctrl+R");
	});
});
