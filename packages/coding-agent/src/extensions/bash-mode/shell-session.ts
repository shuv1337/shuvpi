import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { APP_NAME } from "../../config.ts";
import type { BashTranscriptStore } from "./transcript.ts";
import type { ShellSessionState } from "./types.ts";

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export class ManagedShellSession {
	readonly state: ShellSessionState;
	private readonly transcript: BashTranscriptStore;
	private readonly onChange: () => void;
	private readonly onSuccess: (command: string, cwd: string) => void;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly fish: boolean;
	private process: ChildProcessWithoutNullStreams | undefined;
	private readonly directory = mkdtempSync(join(tmpdir(), `${APP_NAME}-shell-`));
	private readonly marker = `\u001e${randomBytes(16).toString("hex")}:`;
	private buffer = "";
	private counter = 0;
	private active:
		| {
				id: string;
				command: string;
				file: string;
				started: boolean;
				interruptRequested: boolean;
				interruptTimer?: ReturnType<typeof setTimeout>;
				resolve: (code: number) => void;
		  }
		| undefined;
	private readyPromise: Promise<void> | undefined;
	private readyResolve: (() => void) | undefined;
	private readyReject: ((error: Error) => void) | undefined;
	private startupTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private closed: Promise<void> = Promise.resolve();

	constructor(
		shellPath: string,
		cwd: string,
		transcript: BashTranscriptStore,
		onChange: () => void,
		onSuccess: (command: string, cwd: string) => void,
		environment: NodeJS.ProcessEnv = process.env,
	) {
		this.state = { shellPath, cwd, ready: false, running: false, lastExitCode: null };
		this.transcript = transcript;
		this.onChange = onChange;
		this.onSuccess = onSuccess;
		this.environment = environment;
		this.fish = basename(shellPath).toLowerCase().includes("fish");
	}

	async ensureReady(): Promise<void> {
		if (this.disposed) throw new Error("Shell session is closed");
		if (this.state.ready) return;
		if (this.readyPromise) return this.readyPromise;
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		const name = basename(this.state.shellPath).toLowerCase();
		const args = this.fish
			? []
			: name.includes("bash")
				? ["--noprofile", "--norc", "--noediting", "-i"]
				: name.includes("zsh")
					? ["-f", "-i"]
					: ["-i"];
		const child = spawn(this.state.shellPath, args, {
			cwd: this.state.cwd,
			env: {
				...this.environment,
				...(this.fish ? {} : { ENV: "/dev/null", HISTFILE: "/dev/null", PS1: "", PS2: "", PROMPT_COMMAND: "" }),
				DISABLE_AUTO_UPDATE: "true",
				DISABLE_UPDATE_PROMPT: "true",
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		this.process = child;
		this.closed = new Promise<void>((resolve) => {
			child.once("close", (code, signal) => {
				clearTimeout(this.startupTimer);
				const exit = code ?? (signal === "SIGINT" ? 130 : signal === "SIGKILL" ? 137 : 1);
				this.readyReject?.(new Error(`Shell exited before it was ready (exit ${exit})`));
				this.readyReject = undefined;
				this.readyResolve = undefined;
				if (this.buffer) this.appendOutput(this.buffer);
				this.buffer = "";
				this.finish(exit);
				this.process = undefined;
				this.readyPromise = undefined;
				this.state.ready = false;
				if (this.disposed) rmSync(this.directory, { recursive: true, force: true });
				this.onChange();
				resolve();
			});
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.receive(chunk));
		child.stderr.on("data", (chunk: string) => {
			// Interactive startup diagnostics can arrive after the ready frame. User
			// stderr is already redirected to stdout by the bootstrap before commands run.
			if (this.fish) this.appendOutput(chunk);
		});
		const fail = (error: Error) => {
			this.readyReject?.(error);
			this.readyReject = undefined;
			this.kill("SIGKILL");
		};
		child.on("error", fail);
		child.stdin.on("error", fail);
		this.startupTimer = setTimeout(() => fail(new Error("Shell startup timed out")), 10_000);
		this.startupTimer.unref();
		const marker = this.marker.slice(1);
		// The interactive shell's prompt marks completion even when SIGINT unwinds nested
		// functions. A sourced-script wrapper cannot do that without resuming user code.
		// Merge stderr before user commands so output and completion frames stay ordered.
		const prompt = name.includes("zsh")
			? `unsetopt promptcr promptsp; RPS1=; PS1=; TRAPINT() { return 130; }; __pi_prompt() { __pi_code=$?; printf '\\036${marker}%s:%s:%s\\037' "$__pi_id" "$__pi_code" "$PWD"; }; precmd_functions=(__pi_prompt)`
			: `if [ -n "\${BASH_VERSION-}" ]; then set +o emacs; set +o vi; fi; PS1=${quote(`$(printf '\\036${marker}%s:%s:%s\\037' "$__pi_id" "$?" "$PWD")`)}`;
		const init = this.fish
			? `function __pi_eval\n set -l __pi_id $argv[1]\n printf '\\036${marker}%s:start:%s\\037' $__pi_id "$PWD"\n source $argv[2] 2>&1\n set -l __pi_code $status\n printf '\\036${marker}%s:%s:%s\\037' $__pi_id $__pi_code "$PWD"\nend\nprintf '\\036${marker}0:0:%s\\037' "$PWD"\n`
			: `exec 2>&1; set +m; HISTFILE=/dev/null; HISTSIZE=0; PS2=; __pi_id=0; ${prompt}\n`;
		child.stdin.write(init);
		return this.readyPromise;
	}

	async runCommand(command: string): Promise<number> {
		await this.ensureReady();
		if (!this.process || this.disposed) throw new Error("Shell session is closed");
		if (this.state.running) throw new Error("Shell command already running");
		const id = String(++this.counter);
		const file = join(this.directory, `${id}.sh`);
		writeFileSync(file, `${command}\n`, { mode: 0o600, flag: "wx" });
		const completion = new Promise<number>((resolve) => {
			this.active = { id, file, command, resolve, started: false, interruptRequested: false };
		});
		this.state.running = true;
		this.transcript.startCommand(id, command, this.state.cwd);
		this.onChange();
		this.process.stdin.write(
			this.fish
				? `__pi_eval ${quote(id)} ${quote(file)}\n`
				: `__pi_id=${quote(id)}; printf '\\036${this.marker.slice(1)}%s:start:%s\\037' "$__pi_id" "$PWD"; . ${quote(file)}\n`,
		);
		return completion;
	}

	interrupt(): void {
		if (!this.active) return;
		this.active.interruptRequested = true;
		if (this.active.started) this.signalInterrupt();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		clearTimeout(this.startupTimer);
		clearTimeout(this.active?.interruptTimer);
		this.readyReject?.(new Error("Shell session is closed"));
		this.readyReject = undefined;
		this.kill("SIGKILL");
		await this.closed;
		rmSync(this.directory, { recursive: true, force: true });
	}

	private signalInterrupt(): void {
		const active = this.active;
		if (!active) return;
		this.kill("SIGINT");
		if (active.interruptTimer) return;
		// A foreground child can start just after the first signal. Retry once while
		// this command is still active; completion and disposal cancel the retry.
		active.interruptTimer = setTimeout(() => {
			active.interruptTimer = undefined;
			if (this.active === active) this.kill("SIGINT");
		}, 100);
		active.interruptTimer.unref();
	}

	private kill(signal: NodeJS.Signals): void {
		const child = this.process;
		if (!child) return;
		try {
			if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {
			child.kill(signal);
		}
	}

	private appendOutput(chunk: string): void {
		if (!this.active) return;
		this.transcript.appendOutput(
			this.active.id,
			stripVTControlCharacters(chunk).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""),
		);
		this.onChange();
	}

	private finish(code: number): void {
		const active = this.active;
		if (!active) return;
		clearTimeout(active.interruptTimer);
		this.active = undefined;
		this.state.running = false;
		this.state.lastExitCode = code;
		this.transcript.finishCommand(active.id, code);
		rmSync(active.file, { force: true });
		if (code === 0) this.onSuccess(active.command, this.state.cwd);
		active.resolve(code);
		this.onChange();
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		while (this.buffer) {
			const start = this.buffer.indexOf(this.marker);
			if (start < 0) {
				// Keep only a possible split frame prefix, never an unbounded unfinished output line.
				let keep = Math.min(this.marker.length - 1, this.buffer.length);
				while (keep > 0 && !this.marker.startsWith(this.buffer.slice(-keep))) keep--;
				this.appendOutput(this.buffer.slice(0, this.buffer.length - keep));
				this.buffer = keep ? this.buffer.slice(-keep) : "";
				return;
			}
			this.appendOutput(this.buffer.slice(0, start));
			this.buffer = this.buffer.slice(start);
			const end = this.buffer.indexOf("\u001f", this.marker.length);
			if (end < 0) {
				if (this.buffer.length > 64 * 1024) {
					this.appendOutput(this.buffer);
					this.buffer = "";
				}
				return;
			}
			const frame = /^(\d+):(start|\d+):([\s\S]*)$/.exec(this.buffer.slice(this.marker.length, end));
			this.buffer = this.buffer.slice(end + 1);
			if (!frame) continue;
			if (frame[1] === "0" && !this.state.ready) {
				clearTimeout(this.startupTimer);
				this.state.ready = true;
				this.state.cwd = frame[3];
				this.readyResolve?.();
				this.readyResolve = undefined;
				this.readyReject = undefined;
				this.onChange();
			} else if (this.active?.id === frame[1]) {
				if (frame[2] === "start") {
					this.active.started = true;
					if (this.active.interruptRequested) this.signalInterrupt();
					continue;
				}
				this.state.cwd = frame[3];
				this.finish(Number(frame[2]));
			}
		}
	}
}
