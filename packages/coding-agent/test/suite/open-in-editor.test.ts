import childProcess from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@shuv1337/shuvpi-ai/compat";
import { setKeybindings, TuiMainScreen, visibleWidth } from "@shuv1337/shuvpi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../src/config.ts";
import type { TerminalInputHandler } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { createOpenInEditorExtension } from "../../src/extensions/open-in-editor/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
beforeEach(() => {
	initTheme("dark");
	vi.stubEnv("TMUX", "");
	vi.stubEnv("ZELLIJ", "");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	vi.unstubAllEnvs();
	setKeybindings(new KeybindingsManager());
});

async function setup() {
	const harness = await createHarness({ extensionFactories: [createOpenInEditorExtension()] });
	harnesses.push(harness);
	const agentDir = join(harness.tempDir, "agent");
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	await mkdir(agentDir);
	const notify = vi.fn();
	harness.session.extensionRunner.setUIContext(createTestUiContext({ notify }), "tui");
	const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
		pid: 1,
		status: 0,
		signal: null,
		output: [],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
	});
	syncBuiltinESMExports();
	return { harness, agentDir, notify, spawn };
}

describe("optional referenced-file editor", () => {
	it("opens extensionless files and dotfiles with positions and includes them in native tool history", async () => {
		const { harness, spawn } = await setup();
		for (const filename of ["README", "Dockerfile", ".gitignore"]) {
			await writeFile(join(harness.tempDir, filename), "fixture");
			await harness.session.extensionRunner.runCommand("open", `${filename}:12:3`);
			expect(spawn).toHaveBeenLastCalledWith(
				"code",
				["-g", `${join(harness.tempDir, filename)}:12:3`],
				expect.any(Object),
			);
			harness.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: filename })));
		}
		await mkdir(join(harness.tempDir, "sources"));
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		const command = harness.session.extensionRunner.getCommand("open")!;
		const completions = (await command.getArgumentCompletions?.("")) ?? [];
		expect(
			completions
				.filter((item) => item.description === "session file")
				.map((item) => item.value)
				.sort(),
		).toEqual([".gitignore", "Dockerfile", "README"]);
		expect(completions.map((item) => item.value)).toContain("sources/");
		expect((await command.getArgumentCompletions?.("sou"))?.map((item) => item.value)).toContain("sources/");
	});

	it("recognizes an explicitly configured GUI executable path without requiring a multiplexer", async () => {
		const { harness, agentDir, spawn } = await setup();
		const executable = join(harness.tempDir, "Editor Tools", "code");
		await writeFile(join(agentDir, "pi-open-in-editor.json"), JSON.stringify({ editor: executable }));
		await harness.session.extensionRunner.runCommand("open", "./file.ts:7:2");
		expect(spawn).toHaveBeenLastCalledWith(
			executable,
			["-g", `${join(harness.tempDir, "file.ts")}:7:2`],
			expect.objectContaining({ stdio: "ignore" }),
		);
	});

	it("passes quoted file paths with line/column as literal argv and never asks the model", async () => {
		const { harness, spawn } = await setup();
		const filename = "a file; dollar$.ts";
		await writeFile(join(harness.tempDir, filename), "hello");
		harness.setResponses([fauxAssistantMessage("must stay queued")]);
		await harness.session.extensionRunner.runCommand("open", `"${filename}":12:3`);
		expect(spawn).toHaveBeenCalledWith(
			"code",
			["-g", `${join(harness.tempDir, filename)}:12:3`],
			expect.objectContaining({ stdio: "ignore" }),
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages).toEqual([]);
	});

	it("loads project over extension over main config and uses literal tmux/zellij argv", async () => {
		const { harness, agentDir, spawn, notify } = await setup();
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ openInEditor: { editor: "zed" } }));
		await writeFile(join(agentDir, "pi-open-in-editor.json"), JSON.stringify({ editor: "cursor" }));
		await mkdir(join(harness.tempDir, CONFIG_DIR_NAME));
		const config = join(harness.tempDir, CONFIG_DIR_NAME, "pi-open-in-editor.json");
		await writeFile(config, JSON.stringify({ editor: "nvim" }));
		vi.stubEnv("TMUX", "fixture");
		await harness.session.extensionRunner.runCommand("open", "./source.ts:5");
		expect(spawn).toHaveBeenLastCalledWith(
			"tmux",
			["split-window", "-h", "nvim", "+5", join(harness.tempDir, "source.ts")],
			expect.any(Object),
		);
		vi.stubEnv("TMUX", "");
		vi.stubEnv("ZELLIJ", "fixture");
		await harness.session.extensionRunner.runCommand("open", "./source.ts:7");
		expect(spawn).toHaveBeenLastCalledWith(
			"zellij",
			["action", "new-pane", "--", "nvim", "+7", join(harness.tempDir, "source.ts")],
			expect.any(Object),
		);
		await writeFile(config, JSON.stringify({ editor: "auto" }));
		vi.stubEnv("VISUAL", "/fixture/path/nvim");
		await harness.session.extensionRunner.runCommand("open", "./source.ts:9");
		expect(spawn).toHaveBeenLastCalledWith(
			"zellij",
			["action", "new-pane", "--", "/fixture/path/nvim", "+9", join(harness.tempDir, "source.ts")],
			expect.any(Object),
		);
		vi.stubEnv("ZELLIJ", "");
		spawn.mockClear();
		await harness.session.extensionRunner.runCommand("open", "./source.ts");
		expect(spawn).not.toHaveBeenCalled();
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("No multiplexer detected"), "error");
	});

	it("collects stored native tool calls and tool-result paths, with symlink deduplication and completion", async () => {
		const { harness, spawn } = await setup();
		const file = join(harness.tempDir, "file with spaces.ts");
		await writeFile(file, "file");
		await symlink(file, join(harness.tempDir, "alias.ts"));
		harness.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: file, offset: 13 })));
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "read1",
			content: [{ type: "text", text: "See `./alias.ts:13`" }],
			isError: false,
			timestamp: Date.now(),
		});
		let rendered = "";
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) => {
					let selected: T | undefined;
					const component = await factory(
						new TuiMainScreen(new VirtualTerminal(24, 12)),
						theme,
						new KeybindingsManager(),
						(value) => {
							selected = value as T;
						},
					);
					for (const width of [1, 7, 24, 80]) {
						const lines = component.render(width);
						expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
						expect(lines.length).toBeLessThanOrEqual(12);
					}
					rendered = component.render(80).join("\n");
					component.handleInput?.("\r");
					return selected as T;
				},
			}),
			"tui",
		);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		const command = harness.session.extensionRunner.getCommand("open")!;
		const completions = (await command.getArgumentCompletions?.("")) ?? [];
		const sessionPaths = completions.filter((item) => item.description === "session file");
		expect(sessionPaths).toHaveLength(1);
		expect(sessionPaths[0].value).toMatch(/:13$/);
		await harness.session.extensionRunner.runCommand("open");
		expect(rendered).toContain("(1/1)");
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0][1]?.[1]).toContain(":13");
	});

	it("supports reconfigured shortcut and cleans up its terminal listener", async () => {
		const { harness } = await setup();
		await writeFile(join(harness.tempDir, "file.ts"), "file");
		harness.sessionManager.appendMessage(fauxAssistantMessage("See ./file.ts"));
		setKeybindings(new KeybindingsManager({ "app.openEditor": "ctrl+k" }));
		let listener: TerminalInputHandler | undefined;
		const unsubscribe = vi.fn();
		const custom = vi.fn();
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				custom: async <T>() => {
					custom();
					return undefined as T;
				},
				onTerminalInput: (handler) => {
					listener = handler;
					return unsubscribe;
				},
			}),
			"tui",
		);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect(listener?.("\u001b[111;6u")).toBeUndefined();
		expect(listener?.("\u000b")).toEqual({ consume: true });
		await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce());
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("asks before opening a missing picked path and reports launcher failure", async () => {
		const { harness, spawn, notify } = await setup();
		harness.sessionManager.appendMessage(fauxAssistantMessage("See ./missing.ts"));
		const confirm = vi.fn(async () => false);
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				notify,
				confirm,
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) => {
					let selected: T | undefined;
					const component = await factory(
						new TuiMainScreen(new VirtualTerminal()),
						theme,
						new KeybindingsManager(),
						(value) => {
							selected = value as T;
						},
					);
					component.handleInput?.("\r");
					return selected as T;
				},
			}),
			"tui",
		);
		await harness.session.extensionRunner.runCommand("open");
		expect(confirm).toHaveBeenCalledOnce();
		expect(spawn).not.toHaveBeenCalled();
		spawn.mockReturnValue({
			pid: 1,
			status: 1,
			signal: null,
			output: [],
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
		});
		await harness.session.extensionRunner.runCommand("open", "./missing.ts");
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Failed to open in VS Code"), "error");
	});
});
