import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@shuv1337/shuvpi-ai/compat";
import { type AutocompleteProvider, TuiMainScreen, visibleWidth } from "@shuv1337/shuvpi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AutocompleteProviderFactory } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { SlashCommandInfo } from "../../src/core/slash-commands.ts";
import { expandSkillMentions, withSkillAutocomplete } from "../../src/extensions/skill-browser/dollar.ts";
import { createSkillBrowserExtension } from "../../src/extensions/skill-browser/index.ts";
import {
	loadSkillCatalog,
	loadSkillConfig,
	readSkillBlock,
	saveSkillConfig,
} from "../../src/extensions/skill-browser/model.ts";
import { loadSkillBrowserStyles, SkillPicker } from "../../src/extensions/skill-browser/ui.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getUserTexts, type Harness } from "./harness.ts";

const directories: string[] = [];
const harnesses: Harness[] = [];
function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "skill-browser-"));
	directories.push(agentDir);
	const root = join(agentDir, "custom");
	const writeSkill = (path: string, text: string) => {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
		return full;
	};
	writeSkill(
		"alpha/SKILL.md",
		"---\nname: alpha\ndescription: First useful workflow\n---\nALPHA BODY\n\nKeep this paragraph.",
	);
	writeSkill("dev/tools/beta/SKILL.md", "---\nname: beta\ndescription: Second workflow\n---\nBETA BODY");
	writeSkill("loose.md", "LOOSE BODY");
	writeSkill("README.md", "Not a skill");
	writeFileSync(
		join(agentDir, "skill-browser.json"),
		JSON.stringify({ paths: [root], favorites: ["beta"], other: "preserved" }),
	);
	return { agentDir, root, writeSkill };
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => initTheme("dark"));

describe("core skill browser", () => {
	it("merges auto and custom skills deterministically, follows symlinks without cycles, and reports missing paths", () => {
		const { agentDir, root, writeSkill } = fixture();
		const auto = writeSkill("auto.md", "AUTO BODY");
		writeSkill("container/SKILL.md", "---\nname: container\n---\nParent");
		writeSkill("container/nested/SKILL.md", "---\nname: nested\n---\nChild");
		symlinkSync(root, join(root, "cycle"));
		symlinkSync(join(root, "alpha"), join(root, "alias"));
		symlinkSync(join(root, "absent"), join(root, "broken"));
		saveSkillConfig(agentDir, { paths: [root, join(root, "missing")] });
		const commands: SlashCommandInfo[] = [
			{
				name: "skill:alpha",
				description: "Auto wins",
				source: "skill",
				sourceInfo: { path: auto, source: "fixture", scope: "user", origin: "top-level" },
			},
		];
		const { skills, warnings } = loadSkillCatalog(agentDir, root, commands);
		expect(skills[0]?.name).toBe("beta");
		expect(skills.map((skill) => skill.name)).toEqual(["beta", "alpha", "container", "loose", "nested"]);
		expect(skills.find((skill) => skill.name === "alpha")).toMatchObject({
			origin: "auto",
			description: "Auto wins",
			filePath: auto,
		});
		expect(skills.find((skill) => skill.name === "beta")?.category).toBe("dev/tools");
		expect(warnings.join("\n")).toContain("Duplicate skill alpha");
		expect(warnings.join("\n")).toContain("missing");
	});

	it("saves favorites without discarding custom paths, defaults, or unknown fields and rejects invalid config writes", () => {
		const { agentDir, root } = fixture();
		saveSkillConfig(agentDir, { defaultActive: ["alpha"] });
		saveSkillConfig(agentDir, { favorites: ["alpha"] });
		expect(JSON.parse(readFileSync(join(agentDir, "skill-browser.json"), "utf8"))).toEqual({
			paths: [root],
			favorites: ["alpha"],
			defaultActive: ["alpha"],
			other: "preserved",
		});
		writeFileSync(join(agentDir, "skill-browser.json"), "{broken");
		expect(() => saveSkillConfig(agentDir, { favorites: [] })).toThrow();
		expect(readFileSync(join(agentDir, "skill-browser.json"), "utf8")).toBe("{broken");
		expect(loadSkillCatalog(agentDir, root, []).warnings).toHaveLength(1);
	});

	it("searches descriptions and categories, persists favorite actions, and fits narrow terminals", () => {
		const { agentDir, root } = fixture();
		const { skills, config } = loadSkillCatalog(agentDir, root, []);
		const terminal = { rows: 9 };
		const confirm = vi.fn();
		const cancel = vi.fn();
		const keys = new KeybindingsManager({ "app.skillBrowser.favorite": "ctrl+y" });
		const picker = new SkillPicker(
			{
				skills,
				favorites: config.favorites,
				onFavorite: (name) => {
					saveSkillConfig(agentDir, { favorites: [name] });
					return [name];
				},
				onConfirm: confirm,
				onCancel: cancel,
			},
			{ terminal, requestRender: vi.fn() },
			theme,
			keys,
		);
		picker.handleInput("First useful");
		expect(picker.render(80).join("\n")).toContain("alpha");
		expect(picker.render(80).join("\n")).not.toContain("beta");
		picker.handleInput("\x19");
		expect(loadSkillConfig(agentDir).favorites).toEqual(["alpha"]);
		picker.handleInput("\r");
		expect(confirm).toHaveBeenCalledWith(["alpha"]);
		for (const width of [30, 7, 1]) {
			const lines = picker.render(width);
			expect(lines.length).toBeLessThanOrEqual(terminal.rows);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		terminal.rows = 1;
		expect(picker.render(10)).toHaveLength(1);
		expect(picker.render(0)).toEqual([]);
		picker.handleInput("\x1b");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("loads theme resources with validated ANSI colors", () => {
		const { agentDir } = fixture();
		const path = join(agentDir, "extensions", "skill-browser", "theme.json");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ title: "1;34", hint: "90" }));
		expect(loadSkillBrowserStyles(agentDir)).toEqual({ title: "1;34", hint: "90" });
		writeFileSync(path, JSON.stringify({ title: "\x1b]52;unsafe" }));
		expect(() => loadSkillBrowserStyles(agentDir)).toThrow("Invalid skill browser theme color");
	});

	it("opens /skill without starting a turn, appends a mention, and leaves active skills optional", async () => {
		const { agentDir } = fixture();
		const harness = await createHarness({ extensionFactories: [createSkillBrowserExtension({ agentDir })] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		const setEditorText = vi.fn();
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				getEditorText: () => "Review this",
				setEditorText,
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) => {
					let result: unknown;
					const component = await factory(
						new TuiMainScreen(new VirtualTerminal(80, 24)),
						theme,
						new KeybindingsManager(),
						(value) => {
							result = value;
						},
					);
					component.handleInput?.("\r");
					return result as T;
				},
			}),
			"tui",
		);
		harness.setResponses([fauxAssistantMessage("unused")]);
		await harness.session.extensionRunner.runCommand("skill");
		expect(setEditorText).toHaveBeenCalledWith("Review this $beta ");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.session.extensionRunner.getRegisteredCommands().some((command) => command.name === "active-skills"),
		).toBe(false);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "active-skills"),
		).toBe(false);
	});

	it("invokes /skill <name> once with the full body and user arguments", async () => {
		const { agentDir } = fixture();
		const harness = await createHarness({ extensionFactories: [createSkillBrowserExtension({ agentDir })] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.extensionRunner.runCommand("skill", "alpha Review this function");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		expect(getUserTexts(harness)[0]).toContain("ALPHA BODY\n\nKeep this paragraph.");
		expect(getUserTexts(harness)[0]).toContain("Review this function");
		expect(getUserTexts(harness)[0]?.match(/<skill /g)).toHaveLength(1);
	});
});

describe("dollar skill input", () => {
	it("expands unique known mentions with nested category lookup, preserves original text, and handles missing files", () => {
		const { agentDir, root } = fixture();
		const { skills } = loadSkillCatalog(agentDir, root, []);
		const text = "Use $alpha then ($dev/tools/beta), $alpha and $unknown. email$alpha stays literal.";
		const warn = vi.fn();
		const expanded = expandSkillMentions(text, skills, warn);
		expect(expanded.match(/<skill /g)).toHaveLength(2);
		expect(expanded).toContain(readSkillBlock(skills.find((skill) => skill.name === "alpha")!));
		expect(expanded.endsWith(text)).toBe(true);
		expect(expanded).not.toContain("description: First");
		rmSync(skills.find((skill) => skill.name === "alpha")!.filePath);
		expect(expandSkillMentions("$alpha", skills, warn)).toBe("$alpha");
		expect(warn).toHaveBeenCalledOnce();
	});

	it("composes with existing slash/file providers and preserves exact editor lines and cursor", async () => {
		const { agentDir, root } = fixture();
		const current: AutocompleteProvider = {
			triggerCharacters: ["@", "#"],
			getSuggestions: vi.fn(async () => ({ prefix: "@", items: [{ value: "@file", label: "file" }] })),
			applyCompletion: vi.fn(() => ({ lines: ["fallback"], cursorLine: 0, cursorCol: 8 })),
			shouldTriggerFileCompletion: vi.fn(() => true),
		};
		const provider = withSkillAutocomplete(current, () => loadSkillCatalog(agentDir, root, []).skills);
		expect(provider.triggerCharacters).toEqual(["@", "#", "$"]);
		const options = { signal: new AbortController().signal };
		const suggestions = await provider.getSuggestions(["Before", "Use $dev/tools/b"], 1, 16, options);
		expect(suggestions?.items[0]?.value).toBe("$beta");
		const lines = ["Before", "Use $al suffix", "After"];
		expect(provider.applyCompletion(lines, 1, 7, { value: "$alpha", label: "alpha" }, "$al")).toEqual({
			lines: ["Before", "Use $alpha suffix", "After"],
			cursorLine: 1,
			cursorCol: 11,
		});
		expect(lines).toEqual(["Before", "Use $al suffix", "After"]);
		expect(provider.shouldTriggerFileCompletion?.(["$al"], 0, 3)).toBe(false);
		await provider.getSuggestions(["/command $al"], 0, 12, options);
		expect(current.getSuggestions).toHaveBeenCalledWith(["/command $al"], 0, 12, options);
		await provider.getSuggestions(["@file"], 0, 5, options);
		expect(current.getSuggestions).toHaveBeenCalledTimes(2);
		provider.applyCompletion(["@"], 0, 1, { value: "@file", label: "file" }, "@");
		expect(current.applyCompletion).toHaveBeenCalledOnce();
	});

	it("registers an autocomplete wrapper without replacing the editor and skips extension/slash input", async () => {
		const { agentDir } = fixture();
		const harness = await createHarness({ extensionFactories: [createSkillBrowserExtension({ agentDir })] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		const wrappers: AutocompleteProviderFactory[] = [];
		const setEditorComponent = vi.fn();
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({ addAutocompleteProvider: (factory) => wrappers.push(factory), setEditorComponent }),
			"tui",
		);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		expect(wrappers).toHaveLength(1);
		expect(setEditorComponent).not.toHaveBeenCalled();
		const images = [{ type: "image" as const, data: "fixture", mimeType: "image/png" }];
		const input = await harness.session.extensionRunner.emitInput("Use $alpha twice $alpha", images, "interactive");
		expect(input.action).toBe("transform");
		if (input.action !== "transform") throw new Error("Expected expansion");
		expect(input.text.match(/<skill /g)).toHaveLength(1);
		expect(input.images).toEqual(images);
		for (const [text, source] of [
			["$alpha", "extension"],
			["/command $alpha", "interactive"],
			["  /command $alpha", "rpc"],
		] as const) {
			const result = await harness.session.extensionRunner.emitInput(text, undefined, source);
			expect(result).toMatchObject({ action: "continue" });
		}
	});
});
