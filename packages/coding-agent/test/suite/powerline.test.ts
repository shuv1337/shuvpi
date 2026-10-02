import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@shuv1337/shuvpi-ai/compat";
import {
	type Component,
	getKeybindings,
	setKeybindings,
	Text,
	TuiMainScreen,
	visibleWidth,
} from "@shuv1337/shuvpi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import type { TerminalInputHandler } from "../../src/core/extensions/types.ts";
import { FooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { GitStatusMonitor } from "../../src/extensions/powerline/git-status.ts";
import { createPowerlineExtension } from "../../src/extensions/powerline/index.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const disposers: Array<() => void> = [];
const directories: string[] = [];
const clipboard = vi.hoisted(() => ({ copy: vi.fn<(text: string) => Promise<void>>() }));
vi.mock("../../src/utils/clipboard.ts", () => ({
	copyToClipboard: clipboard.copy,
	readClipboardText: vi.fn(),
	readClipboardFilePaths: vi.fn(),
}));
let previousKeys = getKeybindings();
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	clipboard.copy.mockReset().mockResolvedValue();
});
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const dispose of disposers.splice(0)) dispose();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	setKeybindings(previousKeys);
});

async function setup(powerline: unknown) {
	const agentDir = mkdtempSync(join(tmpdir(), "powerline-test-"));
	directories.push(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ unrelated: 4, powerline }));
	const harness = await createHarness({
		extensionFactories: [createPowerlineExtension({ agentDir })],
		models: [
			{ id: "first", name: "First", reasoning: true },
			{ id: "second", name: "Second", reasoning: true },
		],
	});
	harnesses.push(harness);
	const terminal = new VirtualTerminal(140, 30);
	const tui = new TuiMainScreen(terminal);
	const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
	tui.setFocus(editor);
	const inputHandlers = new Set<TerminalInputHandler>();
	const data = new FooterDataProvider(harness.tempDir);
	disposers.push(() => data.dispose());
	let component: (Component & { dispose?(): void }) | undefined;
	const notify = vi.fn();
	harness.session.extensionRunner.setUIContext(
		createTestUiContext({
			notify,
			getEditorText: () => editor.getText(),
			setEditorText: (text) => editor.setText(text),
			onTerminalInput(handler) {
				inputHandlers.add(handler);
				return () => inputHandlers.delete(handler);
			},
			setFooter(factory) {
				component?.dispose?.();
				component = factory?.(tui, theme, data);
			},
		}),
		"tui",
	);
	await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
	return {
		harness,
		data,
		agentDir,
		notify,
		editor,
		tui,
		inputHandlers,
		input: (data: string) => [...inputHandlers].map((handler) => handler(data)),
		component: () => component!,
		render: (width = 200) => component!.render(width).map(stripVTControlCharacters).join("\n"),
	};
}

describe("core powerline footer", () => {
	it.each(["off", "branch"])("does not scan Git worktree counters after tools when polling is %s", async (polling) => {
		const refresh = vi.spyOn(GitStatusMonitor.prototype, "refresh").mockResolvedValue();
		try {
			const { harness } = await setup({ git: { polling } });
			expect(refresh).not.toHaveBeenCalled();
			writeFileSync(join(harness.tempDir, "fixture"), "fixture content");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: "fixture" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("read complete"),
			]);
			await harness.session.prompt("read fixture");
			expect(refresh).not.toHaveBeenCalled();
		} finally {
			refresh.mockRestore();
		}
	});

	it("copies and cuts complete Unicode drafts only after clipboard success, preserving newer edits", async () => {
		const { editor, input, notify } = await setup({ git: { polling: "off" } });
		const text = "日本語 café\nsecond line";
		editor.setText(text);
		expect(input("\x1b\x03")).toEqual([{ consume: true }]);
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Copied draft", "info"));
		expect(clipboard.copy).toHaveBeenLastCalledWith(text);
		expect(editor.getText()).toBe(text);
		clipboard.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
		input("\x1b\x18");
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Error: Clipboard unavailable", "error"));
		expect(editor.getText()).toBe(text);
		let release = () => {};
		clipboard.copy.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		input("\x1b\x18");
		editor.setText("new draft");
		release();
		await Promise.resolve();
		expect(editor.getText()).toBe("new draft");
		input("\x1b\x18");
		await vi.waitFor(() => expect(editor.getText()).toBe(""));
		const copied = clipboard.copy.mock.calls.length;
		input("\x1b\x18");
		expect(clipboard.copy).toHaveBeenCalledTimes(copied);
		expect(notify).toHaveBeenCalledWith("Editor is empty", "info");
	});

	it("honors changed and unbound keys, ignores overlays and removes input listeners on reload/shutdown", async () => {
		const { editor, tui, input, inputHandlers, harness } = await setup({ git: { polling: "off" } });
		editor.setText("draft");
		setKeybindings(new KeybindingsManager({ "app.editor.copyDraft": "ctrl+alt+y", "app.editor.cutDraft": [] }));
		expect(input("\x1b\x03")).toEqual([undefined]);
		expect(input("\x1b\x18")).toEqual([undefined]);
		expect(input("\x1b\x19")).toEqual([{ consume: true }]);
		await Promise.resolve();
		expect(clipboard.copy).toHaveBeenCalledTimes(1);
		tui.setFocus(new Text("overlay"));
		expect(input("\x1b\x19")).toEqual([undefined]);
		expect(clipboard.copy).toHaveBeenCalledTimes(1);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		expect(inputHandlers.size).toBe(1);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(inputHandlers.size).toBe(0);
	});

	it("shows a bounded last-user-prompt line from the current branch and honors its setting", async () => {
		const { harness, component, render, agentDir } = await setup({ git: { polling: "off" } });
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt(`café\n${"日本語 ".repeat(100)}`);
		expect(render()).toContain("↳ café 日本語");
		for (const width of [80, 24, 13, 7, 1]) {
			const lines = component().render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			if (width <= 12) expect(lines.join("\n")).not.toContain("↳");
		}
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ showLastPrompt: false }));
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		expect(render()).not.toContain("↳");
	});
	it("shows live usage once, keeps tool costs, reacts to thinking/models and extension statuses, and bounds ANSI widths", async () => {
		const { harness, data, render, component } = await setup({
			preset: "full",
			git: { polling: "off" },
			layout: {
				left: [
					"model",
					"thinking",
					"token_in",
					"token_out",
					"cache_read",
					"cache_write",
					"cost",
					"context_pct",
					"extension_statuses",
				],
				right: [],
			},
		});
		data.setExtensionStatus("fixture", "queued\nwaiting");
		data.setExtensionStatus("notice", `[notice] ${"long ".repeat(40)}`);
		const message = fauxAssistantMessage("answer");
		message.usage = {
			input: 100,
			output: 20,
			cacheRead: 50,
			cacheWrite: 10,
			totalTokens: 180,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.01, total: 0.36 },
		};
		await harness.session.extensionRunner.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "start", partial: message },
		});
		expect(render()).toContain("100");
		expect(render()).toContain("$0.36");
		expect(render()).toContain("queued waiting");
		harness.sessionManager.appendMessage(message);
		expect(render()).toContain("$0.36");
		expect(render()).not.toContain("$0.72");
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "image",
			toolCallId: "image1",
			content: [],
			isError: false,
			timestamp: Date.now(),
			usage: message.usage,
		});
		expect(render()).toContain("$0.72");
		harness.session.setThinkingLevel("high");
		expect(render()).toContain("think:high");
		await harness.session.setModel(harness.models[1]);
		expect(render()).toContain("Second");
		for (const width of [80, 24, 7, 1])
			expect(
				component()
					.render(width)
					.every((line) => visibleWidth(line) <= width),
			).toBe(true);
		expect(component().render(0)).toEqual([]);
		data.setExtensionStatus("fixture", undefined);
		expect(render()).not.toContain("queued");
	});

	it("supports custom and disabled segments, project overrides, persisted presets, and safe malformed settings", async () => {
		const { harness, data, render, agentDir, notify } = await setup({
			preset: "minimal",
			git: { polling: "off" },
			customItems: {
				queue: { statusKey: "jobs", prefix: "Jobs", position: "left" },
			},
			disabledSegments: ["path"],
			layout: { left: ["custom:queue", "model"], right: [], secondary: [] },
		});
		data.setExtensionStatus("jobs", "2 running");
		expect(render()).toContain("Jobs");
		expect(render().match(/2 running/g)).toHaveLength(1);
		const projectDir = join(harness.tempDir, CONFIG_DIR_NAME);
		mkdirSync(projectDir);
		const projectPath = join(projectDir, "settings.json");
		writeFileSync(
			projectPath,
			JSON.stringify({ powerline: { preset: "ascii", git: { polling: "off" } }, other: "kept" }),
		);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		await harness.session.extensionRunner.runCommand("powerline", "compact");
		expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({
			powerline: { preset: "compact", git: { polling: "off" } },
			other: "kept",
		});
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).powerline.preset).toBe("minimal");
		writeFileSync(projectPath, "{broken");
		await harness.session.extensionRunner.runCommand("powerline", "full");
		expect(readFileSync(projectPath, "utf8")).toBe("{broken");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("could not be saved"), "warning");
		await harness.session.extensionRunner.runCommand("powerline");
		expect(() => render()).toThrow();
		await harness.session.extensionRunner.runCommand("powerline");
		expect(render()).toContain("Jobs");
	});

	it("does not scan a long session again for each editor frame", async () => {
		const { harness, render } = await setup({ preset: "full", git: { polling: "off" } });
		const getEntries = vi.spyOn(harness.sessionManager, "getEntries");
		render();
		const initial = getEntries.mock.calls.length;
		for (let i = 0; i < 20; i++) render();
		expect(getEntries.mock.calls.length).toBe(initial);
		harness.sessionManager.appendMessage(fauxAssistantMessage("next"));
		render();
		expect(getEntries.mock.calls.length).toBeGreaterThan(initial);
	});

	it("refreshes actual worktree status without losing leading spaces or miscounting rename paths", async () => {
		const repo = mkdtempSync(join(tmpdir(), "powerline-git-"));
		directories.push(repo);
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git(["init", "-b", "fixture"]);
		writeFileSync(join(repo, "file"), "one");
		git(["add", "file"]);
		git([
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"fixture",
		]);
		const changed = vi.fn();
		const monitor = new GitStatusMonitor(repo, changed);
		disposers.push(() => monitor.dispose());
		writeFileSync(join(repo, "file"), "two");
		await monitor.refresh();
		expect(monitor.get("fixture")).toEqual({ branch: "fixture", staged: 0, unstaged: 1, untracked: 0 });
		writeFileSync(join(repo, "file"), "one");
		git(["add", "file"]);
		git(["mv", "file", "renamed\nfile"]);
		writeFileSync(join(repo, "new"), "new");
		await monitor.refresh();
		expect(monitor.get("fixture")).toEqual({ branch: "fixture", staged: 1, unstaged: 0, untracked: 1 });
		monitor.dispose();
		await monitor.refresh();
		expect(changed).toHaveBeenCalledTimes(2);
	});
});
