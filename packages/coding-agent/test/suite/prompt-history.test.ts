import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@shuv1337/shuvpi-ai/compat";
import { getKeybindings, setKeybindings } from "@shuv1337/shuvpi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, TerminalInputHandler } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createPromptHistoryExtension } from "../../src/extensions/prompt-history/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
const initialKeys = getKeybindings();
afterEach(async () => {
	setKeybindings(initialKeys);
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup(blockSave = false) {
	const directory = mkdtempSync(join(tmpdir(), "prompt-history-test-"));
	directories.push(directory);
	const agentDir = join(directory, "agent");
	if (blockSave) writeFileSync(agentDir, "blocked");
	else mkdirSync(agentDir);
	const sessions = join(directory, "sessions");
	const sessionManager = SessionManager.create(directory, sessions);
	const harness = await createHarness({
		sessionManager,
		extensionFactories: [createPromptHistoryExtension({ agentDir })],
	});
	harnesses.push(harness);
	let text = "";
	let input: TerminalInputHandler | undefined;
	let choose: ExtensionUIContext["select"] = async () => undefined;
	const notify = vi.fn();
	const status = vi.fn();
	const unsubscribe = vi.fn();
	harness.session.extensionRunner.setUIContext(
		createTestUiContext({
			notify,
			setStatus: status,
			getEditorText: () => text,
			setEditorText: (value) => {
				text = value;
			},
			select: (title, options, opts) => choose(title, options, opts),
			onTerminalInput: (callback) => {
				input = callback;
				return unsubscribe;
			},
		}),
		"tui",
	);
	await harness.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
	return {
		harness,
		directory,
		agentDir,
		sessions,
		notify,
		status,
		unsubscribe,
		set: (value: string) => {
			text = value;
		},
		get: () => text,
		choose: (fn: ExtensionUIContext["select"]) => {
			choose = fn;
		},
		input: (value: string) => input?.(value),
	};
}

describe("optional prompt stash and project history", () => {
	it("restores at the end of a real faux turn, preserves a newer draft, and reloads persisted history", async () => {
		const ui = await setup();
		ui.set("draft\nwith details");
		await ui.harness.session.extensionRunner.runCommand("stash");
		expect(ui.get()).toBe("");
		ui.harness.setResponses([fauxAssistantMessage("done")]);
		await ui.harness.session.prompt("work");
		expect(ui.get()).toBe("draft\nwith details");
		await ui.harness.session.extensionRunner.runCommand("stash");
		ui.set("newer draft");
		ui.harness.setResponses([fauxAssistantMessage("done again")]);
		await ui.harness.session.prompt("more work");
		expect(ui.get()).toBe("newer draft");
		ui.set("");
		await ui.harness.session.extensionRunner.runCommand("stash");
		expect(ui.get()).toBe("draft\nwith details");
		await ui.harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		ui.set("");
		ui.choose(async (title, choices) => (title === "Prompt history" ? "Stashed prompts" : choices[0]));
		await ui.harness.session.extensionRunner.runCommand("stash-history");
		expect(ui.get()).toBe("draft\nwith details");
		expect(
			JSON.parse(readFileSync(join(ui.agentDir, "powerline-footer", "stash-history.json"), "utf8")).history,
		).toEqual(["draft\nwith details"]);
	});

	it("reads project prompt history and supports append, replace and cancel without flattening stored text", async () => {
		const ui = await setup();
		const past = SessionManager.create(ui.directory, ui.sessions);
		past.appendMessage({ role: "user", content: [{ type: "text", text: "old\nproject prompt" }], timestamp: 123 });
		past.appendMessage(fauxAssistantMessage("record it"));
		const other = SessionManager.create("/unrelated-project", ui.sessions);
		other.appendMessage({ role: "user", content: "must not appear", timestamp: 456 });
		other.appendMessage(fauxAssistantMessage("different project"));
		let action = "Append";
		ui.choose(async (title, choices) => {
			if (title === "Insert prompt") return action;
			expect(choices.join("\n")).not.toContain("must not appear");
			return choices[0];
		});
		ui.set("current");
		await ui.harness.session.extensionRunner.runCommand("stash-history");
		expect(ui.get()).toBe("current\nold\nproject prompt");
		action = "Replace";
		await ui.harness.session.extensionRunner.runCommand("stash-history");
		expect(ui.get()).toBe("old\nproject prompt");
		action = "Cancel";
		ui.set("keep me");
		await ui.harness.session.extensionRunner.runCommand("stash-history");
		expect(ui.get()).toBe("keep me");
		ui.choose(async (title, choices) => {
			if (title === "Insert prompt") {
				ui.set("typed during dialog");
				return "Replace";
			}
			return choices[0];
		});
		await ui.harness.session.extensionRunner.runCommand("stash-history");
		expect(ui.get()).toBe("typed during dialog");
	});

	it("leaves the draft untouched if saving fails", async () => {
		const ui = await setup(true);
		ui.set("do not lose this draft");
		await ui.harness.session.extensionRunner.runCommand("stash");
		expect(ui.get()).toBe("do not lose this draft");
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not stash prompt"), "error");
		expect(ui.status).not.toHaveBeenCalledWith("stash", "stash");
	});

	it("uses configurable shortcuts and disposes the raw input subscription", async () => {
		setKeybindings(new KeybindingsManager({ "app.promptStash.toggle": "ctrl+y", "app.promptStash.history": [] }));
		const ui = await setup();
		ui.set("saved");
		expect(ui.input("\u001bs")).toBeUndefined();
		expect(ui.input("\u0019")).toEqual({ consume: true });
		expect(ui.get()).toBe("");
		expect(ui.input("\u0019")).toEqual({ consume: true });
		expect(ui.get()).toBe("saved");
		await ui.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		expect(ui.unsubscribe).toHaveBeenCalledOnce();
	});
});
