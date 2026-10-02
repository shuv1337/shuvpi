import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	type AutocompleteProvider,
	type Component,
	CURSOR_MARKER,
	getKeybindings,
	setKeybindings,
	TuiMainScreen,
	visibleWidth,
} from "@shuv1337/shuvpi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { EditorFactory, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { BashModeEditor } from "../../src/extensions/bash-mode/editor.ts";
import { createBashModeExtension } from "../../src/extensions/bash-mode/index.ts";
import { withSkillAutocomplete } from "../../src/extensions/skill-browser/dollar.ts";
import type { BrowserSkill } from "../../src/extensions/skill-browser/model.ts";
import { getEditorTheme, initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
const originalKeys = getKeybindings();
beforeEach(() => initTheme("dark"));
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	setKeybindings(originalKeys);
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

async function setup(configuredKeys = new KeybindingsManager()) {
	const directory = mkdtempSync(join(tmpdir(), "bash-mode-ui-"));
	directories.push(directory);
	setKeybindings(configuredKeys);
	const harness = await createHarness({
		extensionFactories: [
			createBashModeExtension({
				shellPath: "/bin/bash",
				agentDir: directory,
				historyPath: null,
				environment: { PATH: process.env.PATH, BASH_ENV: "/dev/null", HISTFILE: join(directory, "history") },
			}),
		],
	});
	harnesses.push(harness);
	const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
	let editor: BashModeEditor | undefined;
	let editorFactory: EditorFactory | undefined;
	let widget: Component | undefined;
	let status: string | undefined;
	const notify = vi.fn();
	const submit = vi.fn();
	const baseProvider: AutocompleteProvider = {
		getSuggestions: vi.fn(async () => null),
		applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
	};
	const ui = createTestUiContext({
		notify,
		setStatus(_key, text) {
			status = text;
		},
		getEditorComponent: () => editorFactory,
		setEditorComponent(factory) {
			editorFactory = factory;
			editor = factory?.(tui, getEditorTheme(), configuredKeys) as BashModeEditor | undefined;
			if (editor) {
				editor.onSubmit = submit;
				editor.setAutocompleteProvider(baseProvider);
				editor.focused = true;
			}
		},
		setWidget: ((_key, content) => {
			widget = typeof content === "function" ? content(tui, theme) : undefined;
		}) as ExtensionUIContext["setWidget"],
	});
	harness.session.extensionRunner.setUIContext(ui, "tui");
	await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
	return {
		harness,
		tui,
		notify,
		submit,
		directory,
		baseProvider,
		editor: () => editor!,
		status: () => status,
		text: (width = 80) => widget?.render(width).map(stripVTControlCharacters).join("\n") ?? "",
		widget: () => widget!,
	};
}

describe.skipIf(process.platform === "win32")("optional sticky bash editor", () => {
	it("runs persistent commands without a model request, then resets and leaves one-off bash to the native host", async () => {
		const ui = await setup();
		const nested = join(ui.harness.tempDir, "nested");
		mkdirSync(nested);
		await ui.harness.session.extensionRunner.runCommand("bash-mode", "on");
		ui.editor().setText("cd nested; export UI05_FIXTURE=retained; printf no-newline");
		ui.editor().handleInput("\r");
		await vi.waitFor(() => expect(ui.status()).toContain(`ready · ${nested}`));
		expect(ui.text()).toContain("no-newline");
		ui.editor().setText(`printf 'STATE:%s:%s' "$UI05_FIXTURE" "$PWD"`);
		ui.editor().handleInput("\r");
		await vi.waitFor(() => expect(ui.text()).toContain(`STATE:retained:${nested}`));
		expect(ui.submit).not.toHaveBeenCalled();
		expect(ui.harness.eventsOfType("agent_start")).toHaveLength(0);
		await ui.harness.session.extensionRunner.runCommand("bash-reset");
		expect(ui.text()).toBe("");
		expect(ui.status()).toContain(`ready · ${ui.harness.tempDir}`);
		ui.editor().setText(`printf 'RESET:%s' "${"$"}{UI05_FIXTURE-unset}"`);
		ui.editor().handleInput("\r");
		await vi.waitFor(() => expect(ui.text()).toContain("RESET:unset"));
		await ui.harness.session.extensionRunner.runCommand("bash-mode", "off");
		ui.editor().setText("!printf one-off");
		ui.editor().handleInput("\r");
		expect(ui.submit).toHaveBeenCalledWith("!printf one-off");
		expect(ui.status()).toBeUndefined();
	});

	it("recalls shell history, restores the draft, accepts path ghosts, and keeps configured shortcuts", async () => {
		const keys = new KeybindingsManager({ "app.bashMode.toggle": "ctrl+y" });
		const ui = await setup(keys);
		ui.editor().handleInput("\u0019");
		await vi.waitFor(() => expect(ui.status()).toContain("ready"));
		ui.editor().setText("printf history-value");
		ui.editor().handleInput("\r");
		await vi.waitFor(() => expect(ui.text()).toContain("history-value"));
		await vi.waitFor(() => expect(ui.status()).toContain("ready"));
		ui.editor().setText("printf h");
		ui.editor().handleInput("\u001b[A");
		expect(ui.editor().getText()).toBe("printf history-value");
		ui.editor().handleInput("\u001b[B");
		expect(ui.editor().getText()).toBe("printf h");
		writeFileSync(join(ui.harness.tempDir, "sample-file.txt"), "fixture");
		ui.editor().setText("cat samp");
		ui.editor().refreshGhost();
		await vi.waitFor(() =>
			expect(
				ui
					.editor()
					.render(80)
					.map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")))
					.join("\n"),
			).toContain("sample-file.txt"),
		);
		expect(ui.editor().render(80).join("\n")).toContain(CURSOR_MARKER);
		ui.editor().handleInput("\t");
		expect(ui.editor().getText()).toBe("cat sample-file.txt");
		for (const width of [80, 22, 7, 1]) {
			expect(
				ui
					.editor()
					.render(width)
					.every((line) => visibleWidth(line) <= width),
				`editor width ${width}: ${JSON.stringify(ui.editor().render(width).map(visibleWidth))}`,
			).toBe(true);
			expect(
				ui
					.widget()
					.render(width)
					.every((line) => visibleWidth(line) <= width),
			).toBe(true);
		}
		ui.editor().handleInput("\u0019");
		await vi.waitFor(() => expect(ui.status()).toBeUndefined());
	});

	it("composes skill completion through the actual custom editor and replaces the chain cleanly", async () => {
		const ui = await setup(new KeybindingsManager({ "app.bashMode.toggle": [] }));
		const skill = (name: string): BrowserSkill => ({
			name,
			description: `${name} description`,
			category: "fixtures",
			filePath: "/fixture",
			directory: "/",
			origin: "auto",
		});
		ui.editor().setAutocompleteProvider(withSkillAutocomplete(ui.baseProvider, () => [skill("first")]));
		ui.editor().handleInput("$");
		ui.editor().handleInput("f");
		await vi.waitFor(() => expect(ui.editor().render(80).join("\n")).toContain("first description"));
		ui.editor().setAutocompleteProvider(withSkillAutocomplete(ui.baseProvider, () => [skill("second")]));
		ui.editor().setText("");
		ui.editor().handleInput("$");
		ui.editor().handleInput("s");
		await vi.waitFor(() => expect(ui.editor().render(80).join("\n")).toContain("second description"));
		expect(ui.editor().render(80).join("\n")).not.toContain("first description");
		ui.editor().handleInput("\u001b");
		ui.editor().setText("!git stat");
		ui.editor().refreshGhost();
		await vi.waitFor(() =>
			expect(
				ui
					.editor()
					.render(80)
					.map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")))
					.join("\n"),
			).toContain("!git status"),
		);
		ui.editor().handleInput("\t");
		expect(ui.editor().getText()).toBe("!git status");
		ui.editor().handleInput("\u001b[98;6u");
		expect(ui.status()).toBeUndefined();
	});

	it("interrupts running work and replaces the shell/editor cleanly on session shutdown/reload", async () => {
		const ui = await setup();
		await ui.harness.session.extensionRunner.runCommand("bash-mode", "on");
		ui.editor().setText("printf READY; sleep 30");
		ui.editor().handleInput("\r");
		await vi.waitFor(() => expect(ui.text()).toContain("READY"));
		await vi.waitFor(() => expect(ui.status()).toContain("running"));
		ui.editor().handleInput("\u001b");
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Interrupt or finish"), "warning");
		ui.editor().handleInput("\u0003");
		await vi.waitFor(() => expect(ui.status()).toContain("ready"));
		ui.editor().setText("sleep 30");
		ui.editor().handleInput("\r");
		await vi.waitFor(() => expect(ui.status()).toContain("running"));
		const previous = ui.editor();
		await ui.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		expect(ui.status()).toBeUndefined();
		await ui.harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		expect(ui.editor()).not.toBe(previous);
		await ui.harness.session.extensionRunner.runCommand("bash-mode", "on");
		expect(ui.status()).toContain("ready");
		expect(ui.text()).toBe("");
	});
});
