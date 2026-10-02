import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BashCompletionEngine } from "../src/extensions/bash-mode/completion.ts";
import { appendProjectHistory, readProjectHistory } from "../src/extensions/bash-mode/history.ts";
import { ManagedShellSession } from "../src/extensions/bash-mode/shell-session.ts";
import { BashTranscriptStore } from "../src/extensions/bash-mode/transcript.ts";

const sessions: ManagedShellSession[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function setup(shellPath = "/bin/bash", environment: NodeJS.ProcessEnv = {}) {
	const directory = mkdtempSync(join(os.tmpdir(), "bash-mode-test-"));
	directories.push(directory);
	const transcript = new BashTranscriptStore();
	const success = vi.fn();
	const changed = vi.fn();
	const session = new ManagedShellSession(shellPath, directory, transcript, changed, success, {
		PATH: process.env.PATH,
		HISTFILE: join(directory, "history"),
		BASH_ENV: "/dev/null",
		ENV: "/dev/null",
		ZDOTDIR: directory,
		...environment,
	});
	sessions.push(session);
	return { directory, transcript, session, success, changed };
}

describe.skipIf(process.platform === "win32")("managed sticky shell", () => {
	it("does not run an inherited interactive prompt hook in the managed shell", async () => {
		const { session, transcript } = setup("/bin/bash", {
			PROMPT_COMMAND: "printf inherited-prompt-hook; false",
		});
		expect(await session.runCommand("printf command-only")).toBe(0);
		expect(transcript.getSnapshot().at(-1)?.output).toBe("command-only");
	});

	it.each(["/bin/bash", "/bin/sh", "/usr/bin/zsh"].filter(existsSync))(
		"preserves directory/environment, no-newline output and exact exit codes in %s",
		async (path) => {
			const { directory, session, transcript, success } = setup(path);
			const nested = join(directory, "nested:with space");
			mkdirSync(nested);
			expect(
				await session.runCommand("cd 'nested:with space'; export UI05_FIXTURE=retained; printf no-newline"),
			).toBe(0);
			expect(session.state.cwd).toBe(nested);
			expect(transcript.getSnapshot()[0].output).toBe("no-newline");
			expect(await session.runCommand(`printf '%s:%s' "$UI05_FIXTURE" "$PWD"; printf ':stderr' >&2; false`)).toBe(1);
			expect(transcript.getSnapshot()[1].output).toBe(`retained:${nested}:stderr`);
			expect(success).toHaveBeenCalledOnce();
			expect(session.state.running).toBe(false);
		},
	);

	it.each(["/bin/bash", "/bin/sh", "/usr/bin/zsh"].filter(existsSync))(
		"interrupts a real command, keeps %s usable, and resolves running work on shutdown",
		async (path) => {
			const { directory, session, transcript } = setup(path);
			await session.runCommand("export UI05_FIXTURE=still-here");
			const running = session.runCommand("printf running; sleep 30");
			await vi.waitFor(() => expect(transcript.getSnapshot().at(-1)?.output).toBe("running"));
			await expect(session.runCommand("must not run")).rejects.toThrow("already running");
			session.interrupt();
			expect(await running).toBe(130);
			expect(await session.runCommand(`printf '%s' "$UI05_FIXTURE"`)).toBe(0);
			expect(transcript.getSnapshot().at(-1)?.output).toBe("still-here");
			const childPidFile = join(directory, "pid");
			const sleeping = session.runCommand(
				`sleep 30 & child=$!; printf '%s' "$child" > '${childPidFile}'; wait "$child"`,
			);
			await vi.waitFor(() => expect(existsSync(childPidFile)).toBe(true));
			await session.dispose();
			expect(await sleeping).toBe(137);
			expect(session.state.ready).toBe(false);
			await expect(session.ensureReady()).rejects.toThrow("closed");
		},
	);

	it.each(["/bin/bash", "/bin/sh", "/usr/bin/zsh"].filter(existsSync))(
		"interrupts top-level and nested loops without later statements and retains shell state in %s",
		async (path) => {
			const { directory, session, transcript } = setup(path);
			const nested = join(directory, "retained-directory");
			mkdirSync(nested);
			await session.runCommand(
				"cd retained-directory; export UI05_FIXTURE=retained; ui05_retained() { printf function-retained; }",
			);
			for (const command of [
				"while :; do :; done",
				"while :; do sleep 30; done",
				"ui05_inner() { while :; do :; done; printf inner-after; }; ui05_inner",
				"ui05_inner() { while :; do sleep 30; done; printf inner-after; }; ui05_outer() { ui05_inner; printf outer-after; }; ui05_outer",
			]) {
				const running = session.runCommand(`printf loop-ready; ${command}; printf must-not-run`);
				await vi.waitFor(() => expect(transcript.getSnapshot().at(-1)?.output).toBe("loop-ready"));
				session.interrupt();
				await vi.waitFor(() => expect(session.state.running).toBe(false), { timeout: 1000 });
				expect(await running).toBe(130);
				expect(transcript.getSnapshot().at(-1)?.output.trimEnd()).toBe("loop-ready");
				expect(session.state.cwd).toBe(nested);
				expect(await session.runCommand(`printf '%s:%s:' "$UI05_FIXTURE" "$PWD"; ui05_retained`)).toBe(0);
				expect(transcript.getSnapshot().at(-1)?.output).toBe(`retained:${nested}:function-retained`);
			}
		},
	);

	it.each(["/bin/bash", "/bin/sh", "/usr/bin/zsh"].filter(existsSync))(
		"cancels a command interrupted during dispatch before its start frame in %s",
		async (path) => {
			const { session, transcript, changed } = setup(path);
			await session.ensureReady();
			let interrupted = false;
			changed.mockImplementation(() => {
				if (!session.state.running || interrupted) return;
				interrupted = true;
				session.interrupt();
			});
			const running = session.runCommand("while :; do sleep 30; done; printf must-not-run");
			await vi.waitFor(() => expect(interrupted && !session.state.running).toBe(true), { timeout: 1000 });
			expect(await running).toBe(130);
			expect(transcript.getSnapshot().at(-1)?.output).not.toContain("must-not-run");
			expect(await session.runCommand("printf still-usable")).toBe(0);
			expect(transcript.getSnapshot().at(-1)?.output).toBe("still-usable");
		},
	);

	it("rejects a missing shell and never leaves startup waiting after disposal", async () => {
		const { session } = setup("/does/not/exist");
		await expect(session.ensureReady()).rejects.toThrow();
		await session.dispose();
	});

	it("bounds a single running command, huge lines, blank output and many silent commands", () => {
		const transcript = new BashTranscriptStore(5, 100);
		transcript.startCommand("one", "output", "/");
		transcript.appendOutput("one", "x".repeat(500));
		expect(Buffer.byteLength(transcript.getSnapshot()[0].output)).toBeLessThanOrEqual(100);
		expect(transcript.getSnapshot()[0].truncated).toBe(true);
		transcript.appendOutput("one", "\n".repeat(100));
		expect(transcript.getSnapshot()[0].output.split("\n").length).toBeLessThan(5);
		for (let i = 0; i < 100; i++) transcript.startCommand(String(i), "true", "/");
		expect(transcript.getSnapshot().length).toBeLessThanOrEqual(5);
	});

	it("keeps private project history distinct and uses local path/git/history suggestions", async () => {
		const { directory } = setup();
		const agentDir = join(directory, "agent");
		appendProjectHistory(directory, "printf previous", directory, agentDir);
		appendProjectHistory(`${directory}/a-b`, "one project", directory, agentDir);
		appendProjectHistory(`${directory}/a/b`, "another project", directory, agentDir);
		expect(readProjectHistory(`${directory}/a-b`, agentDir)[0].command).toBe("one project");
		expect(readProjectHistory(`${directory}/a/b`, agentDir)[0].command).toBe("another project");
		expect(readdirSync(join(agentDir, "bash-mode", "history")).some((file) => file.endsWith(".tmp"))).toBe(false);
		const engine = new BashCompletionEngine(agentDir, null);
		const signal = new AbortController().signal;
		expect(
			(await engine.getGhostSuggestion("printf p", `${directory}/changed`, "/bin/bash", signal, directory))?.value,
		).toBe("printf previous");
		expect((await engine.getGhostSuggestion("printf p", directory, "/bin/bash", signal))?.value).toBe(
			"printf previous",
		);
		writeFileSync(join(directory, "sample.txt"), "fixture");
		expect((await engine.getGhostSuggestion("cat sam", directory, "/bin/bash", signal))?.value).toBe(
			"cat sample.txt",
		);
		expect((await engine.getGhostSuggestion("git stat", directory, "/bin/bash", signal))?.value).toBe("git status");
	});

	it("does not fail a successful command when the project history directory is unavailable", async () => {
		const { directory, session, success } = setup();
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "bash-mode"), "A file blocks the history directory");
		expect(() => appendProjectHistory(directory, "true", directory, agentDir)).not.toThrow();
		success.mockImplementation((command: string, cwd: string) =>
			appendProjectHistory(directory, command, cwd, agentDir),
		);
		expect(await session.runCommand("true")).toBe(0);
		expect(await session.runCommand("printf still-usable")).toBe(0);
		expect(session.state.running).toBe(false);
	});

	it("completes filesystem roots and the home directory without changing their base", async () => {
		const { directory } = setup();
		writeFileSync(join(directory, "project-only-file.txt"), "fixture");
		const engine = new BashCompletionEngine(join(directory, "agent"), null);
		const signal = new AbortController().signal;
		const root = await engine.getGhostSuggestion("cat /", directory, "/bin/bash", signal);
		expect(root?.value).toMatch(/^cat \//);
		expect(root?.value).not.toBe("cat /project-only-file.txt");
		const home = vi.spyOn(os, "homedir").mockReturnValue(directory);
		syncBuiltinESMExports();
		try {
			expect((await engine.getGhostSuggestion("cat ~/", directory, "/bin/bash", signal))?.value).toBe(
				"cat ~/project-only-file.txt",
			);
		} finally {
			home.mockRestore();
			syncBuiltinESMExports();
		}
	});

	it("continues escaped and quoted path completions after directory names containing spaces", async () => {
		const { directory, session, transcript } = setup();
		const nested = join(directory, "space directory");
		mkdirSync(nested);
		writeFileSync(join(nested, "sample.txt"), "path-fixture");
		const engine = new BashCompletionEngine(join(directory, "agent"), null);
		const signal = new AbortController().signal;
		expect((await engine.getGhostSuggestion("cat spa", directory, "/bin/bash", signal))?.value).toBe(
			"cat space\\ directory/",
		);
		for (const [prefix, expected] of [
			["cat space\\ directory/sa", "cat space\\ directory/sample.txt"],
			['cat "space directory/sa', 'cat "space directory/sample.txt"'],
			["cat 'space directory/sa", "cat 'space directory/sample.txt'"],
		]) {
			const result = await engine.getGhostSuggestion(prefix, directory, "/bin/bash", signal);
			expect(result?.value).toBe(expected);
			expect(await session.runCommand(result!.value)).toBe(0);
			expect(transcript.getSnapshot().at(-1)?.output).toBe("path-fixture");
		}
	});
});
