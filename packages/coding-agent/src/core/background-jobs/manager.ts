import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { terminateProcessGroup } from "./process.ts";

export interface BackgroundJob {
	id: string;
	command: string;
	title: string;
	cwd: string;
	status: "running" | "done" | "failed" | "killed";
	pid?: number;
	exitCode?: number;
	signal?: string;
	error?: string;
	stdout: string;
	stderr: string;
	stdoutBytes: number;
	stderrBytes: number;
	truncated: boolean;
}

interface Entry {
	value: BackgroundJob;
	child: ChildProcess;
	settled: PromiseWithResolvers<BackgroundJob>;
	stopping?: Promise<void>;
	closed: boolean;
}

/** Session-owned shell jobs. State is deliberately in memory; closing the session kills all live groups. */
export class BackgroundJobManager {
	private readonly entries = new Map<string, Entry>();
	private readonly listeners = new Set<() => void>();
	private readonly completions = new Set<(job: BackgroundJob) => void>();
	private closed = false;
	private readonly retainedBytes: number;
	constructor(options: { retainedBytes?: number } = {}) {
		this.retainedBytes = options.retainedBytes ?? 2 * 1024 * 1024;
	}
	start(command: string, cwd: string, title = command): BackgroundJob {
		if (this.closed) throw new Error("Background process manager is closed");
		if (!command.trim()) throw new Error("Background command is empty");
		if ([...this.entries.values()].filter((entry) => !entry.closed).length >= 8)
			throw new Error("At most 8 background jobs may run at once");
		while (this.entries.size >= 32) {
			const oldest = [...this.entries.values()].find((entry) => entry.closed);
			if (!oldest) break;
			this.entries.delete(oldest.value.id);
		}
		const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
		const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
		const child = spawn(shell, args, {
			cwd: resolve(cwd),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const value: BackgroundJob = {
			id: randomUUID(),
			command,
			title: title.slice(0, 160),
			cwd: resolve(cwd),
			status: "running",
			...(child.pid ? { pid: child.pid } : {}),
			stdout: "",
			stderr: "",
			stdoutBytes: 0,
			stderrBytes: 0,
			truncated: false,
		};
		const entry: Entry = { value, child, settled: Promise.withResolvers<BackgroundJob>(), closed: false };
		this.entries.set(value.id, entry);
		const output = (stream: "stdout" | "stderr", chunk: string) => {
			value[stream === "stdout" ? "stdoutBytes" : "stderrBytes"] += Buffer.byteLength(chunk);
			const bytes = Buffer.from(value[stream] + chunk);
			value[stream] =
				bytes.length > this.retainedBytes
					? bytes.subarray(bytes.length - this.retainedBytes).toString("utf8")
					: bytes.toString("utf8");
			value.truncated ||= bytes.length > this.retainedBytes;
			this.changed();
		};
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => output("stdout", chunk));
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => output("stderr", chunk));
		child.once("error", (error) => {
			value.error = error.message;
		});
		child.once("exit", () => {
			// A shell can exit while its children retain the pipes. Reap that inherited group too.
			const timer = setTimeout(() => {
				if (!entry.closed) void this.stopEntry(entry, false);
			}, 300);
			timer.unref();
		});
		child.once("close", async (code, signal) => {
			// Redirected descendant stdio can outlive both the shell and its closed pipes.
			await terminateProcessGroup(child, 300, true);
			entry.closed = true;
			if (code !== null) value.exitCode = code;
			if (signal !== null) value.signal = signal;
			if (value.status !== "killed") value.status = !value.error && code === 0 ? "done" : "failed";
			const snapshot = this.get(value.id);
			entry.settled.resolve(snapshot);
			this.changed();
			for (const listener of this.completions) {
				try {
					listener(snapshot);
				} catch {}
			}
		});
		this.changed();
		return this.get(value.id);
	}
	get(id: string): BackgroundJob {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown background job: ${id}`);
		return { ...entry.value };
	}
	list(): BackgroundJob[] {
		return [...this.entries.values()].map((entry) => ({ ...entry.value }));
	}
	async wait(id: string, signal?: AbortSignal): Promise<BackgroundJob> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown background job: ${id}`);
		if (!signal) return entry.settled.promise;
		signal.throwIfAborted();
		const interrupted = Promise.withResolvers<never>();
		const onAbort = () => interrupted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([entry.settled.promise, interrupted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
	async kill(id: string): Promise<BackgroundJob> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown background job: ${id}`);
		await this.stopEntry(entry, true);
		return entry.settled.promise;
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onSettled(listener: (job: BackgroundJob) => void): () => void {
		this.completions.add(listener);
		return () => this.completions.delete(listener);
	}
	async close(): Promise<void> {
		this.closed = true;
		this.completions.clear();
		await Promise.all([...this.entries.values()].map((entry) => this.stopEntry(entry, true)));
		this.listeners.clear();
	}
	private async stopEntry(entry: Entry, killed: boolean): Promise<void> {
		if (entry.closed) return;
		if (killed && entry.child.exitCode === null && entry.child.signalCode === null) entry.value.status = "killed";
		entry.stopping ??= terminateProcessGroup(entry.child);
		await entry.stopping;
	}
	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {}
		}
	}
}
