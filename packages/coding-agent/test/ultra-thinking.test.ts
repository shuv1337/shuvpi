import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@shuv1337/shuvpi-ai";
import { setKeybindings } from "@shuv1337/shuvpi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidThinkingLevel, parseArgs } from "../src/cli/args.ts";
import { THINKING_LEVEL_OPTIONS } from "../src/core/defaults.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createVirtualModel } from "../src/core/virtual-models.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const temporaryRoots: string[] = [];
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("ultra thinking controls", () => {
	it("accepts CLI and persisted per-model settings without rewriting the level", async () => {
		expect(isValidThinkingLevel("ultra")).toBe(true);
		expect(parseArgs(["--thinking", "ultra"])).toMatchObject({ thinking: "ultra", diagnostics: [] });
		expect(THINKING_LEVEL_OPTIONS).toContain("ultra");
		const root = mkdtempSync(join(tmpdir(), "pi-ultra-settings-"));
		temporaryRoots.push(root);
		const settings = SettingsManager.create(root, join(root, "agent"));
		settings.setDefaultThinkingLevel("ultra");
		settings.setModelThinkingLevel("openai-codex", "gpt-daybreak-blue-latest", "ultra");
		await settings.flush();
		expect(settings.getDefaultThinkingLevel()).toBe("ultra");
		expect(settings.getModelThinkingLevel("openai-codex", "gpt-daybreak-blue-latest")).toBe("ultra");
		const reopened = SettingsManager.create(root, join(root, "agent"));
		expect(reopened.getDefaultThinkingLevel()).toBe("ultra");
		expect(reopened.getModelThinkingLevel("openai-codex", "gpt-daybreak-blue-latest")).toBe("ultra");
	});

	it("loads opt-in custom model mappings and preserves virtual model capabilities", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ultra-models-"));
		temporaryRoots.push(root);
		const path = join(root, "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: { custom: { models: [{ id: "custom-model", thinkingLevelMap: { ultra: "native-ultra" } }] } },
			}),
		);
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("custom")?.models?.[0].thinkingLevelMap?.ultra).toBe("native-ultra");
		const virtual = createVirtualModel({
			provider: "custom",
			id: "router",
			name: "Router",
			thinkingLevels: ["high", "ultra"],
		});
		expect(getSupportedThinkingLevels(virtual)).toEqual(["high", "ultra"]);
		expect(
			getSupportedThinkingLevels(createVirtualModel({ provider: "custom", id: "plain", name: "Plain" })),
		).toEqual(["off"]);
	});

	it("renders and selects ultra through configurable controls and the maximum theme color", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager({ "app.thinking.save": "ctrl+r" }));
		const select = vi.fn();
		const save = vi.fn();
		const selector = new ThinkingSelectorComponent("ultra", ["high", "ultra"], select, () => {}, save);
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("Maximum advertised reasoning");
		selector.handleInput("\r");
		selector.handleInput("\x12");
		expect(select).toHaveBeenCalledWith("ultra");
		expect(save).toHaveBeenCalledWith("ultra");
		expect(theme.getThinkingBorderColor("ultra")("border")).toBe(theme.getThinkingBorderColor("max")("border"));
	});
});
