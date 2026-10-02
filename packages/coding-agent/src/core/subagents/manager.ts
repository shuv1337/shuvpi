import { randomUUID } from "node:crypto";
import type {
	SubagentBackend,
	SubagentBackendName,
	SubagentEvent,
	SubagentRequest,
	SubagentSession,
	SubagentSnapshot,
} from "./types.ts";

// A process-wide cap includes independent extension instances and in-flight backend creation.
const running = new Set<string>();
interface Entry {
	value: SubagentSnapshot;
	session?: SubagentSession;
	controller: AbortController;
	initialized: PromiseWithResolvers<void>;
	settled: PromiseWithResolvers<SubagentSnapshot>;
}

export class SubagentManager {
	private readonly entries = new Map<string, Entry>();
	private readonly backends: ReadonlyMap<SubagentBackendName, SubagentBackend>;
	private readonly listeners = new Set<() => void>();
	private readonly completions = new Set<(value: SubagentSnapshot) => void>();
	private closed = false;
	constructor(backends: readonly SubagentBackend[]) {
		this.backends = new Map(backends.map((backend) => [backend.name, backend]));
	}
	async spawn(backendName: SubagentBackendName, request: Omit<SubagentRequest, "signal">): Promise<SubagentSnapshot> {
		if (this.closed) throw new Error("Subagent manager is closed");
		const backend = this.backends.get(backendName);
		if (!backend) throw new Error(`Subagent backend unavailable: ${backendName}`);
		const id = randomUUID();
		this.reserve(id);
		const entry: Entry = {
			value: {
				id,
				backend: backendName,
				title: request.title,
				cwd: request.cwd,
				status: "running",
				run: 1,
				output: "",
				transcript: [{ role: "user", text: request.prompt }],
			},
			controller: new AbortController(),
			initialized: Promise.withResolvers<void>(),
			settled: Promise.withResolvers<SubagentSnapshot>(),
		};
		this.entries.set(id, entry);
		entry.value.originEntryId = request.parent.sessionManager.getLeafId();
		try {
			entry.session = await backend.create({ ...request, signal: entry.controller.signal }, (event) =>
				this.event(entry, event),
			);
			if (this.closed) {
				await entry.session.close();
				throw new Error("Subagent manager closed during startup");
			}
			entry.controller.signal.throwIfAborted();
			await entry.session.send(request.prompt, false, entry.value.run);
		} catch (error) {
			await entry.session?.close();
			this.event(entry, {
				type: "settled",
				run: entry.value.run,
				status: entry.controller.signal.aborted ? "aborted" : "error",
				output: "",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			entry.initialized.resolve();
		}
		this.changed();
		return this.get(id);
	}
	async send(id: string, prompt: string): Promise<void> {
		if (this.closed) throw new Error("Subagent manager is closed");
		const entry = this.entry(id);
		if (!entry.session) throw new Error("Subagent is still starting");
		const steering = entry.value.status === "running";
		if (!steering) {
			this.reserve(id);
			entry.value.status = "running";
			entry.value.run++;
			entry.value.output = "";
			delete entry.value.error;
			entry.settled = Promise.withResolvers<SubagentSnapshot>();
		}
		entry.value.transcript.push({ role: "user", text: prompt });
		while (entry.value.transcript.length > 128) entry.value.transcript.shift();
		try {
			await entry.session.send(prompt, steering, entry.value.run);
		} catch (error) {
			if (!steering)
				this.event(entry, {
					type: "settled",
					run: entry.value.run,
					status: "error",
					output: "",
					error: error instanceof Error ? error.message : String(error),
				});
			throw error;
		}
		this.changed();
	}
	async cancel(id: string): Promise<SubagentSnapshot> {
		const entry = this.entry(id);
		if (entry.value.status === "running") {
			if (!entry.session) {
				entry.controller.abort();
				await entry.initialized.promise;
			}
			if (entry.session) {
				try {
					await entry.session.interrupt();
				} catch {
					await entry.session.close();
				}
			}
			this.event(entry, { type: "settled", run: entry.value.run, status: "aborted", output: entry.value.output });
		}
		return this.get(id);
	}
	get(id: string): SubagentSnapshot {
		return structuredClone(this.entry(id).value);
	}
	list(): SubagentSnapshot[] {
		return [...this.entries.values()].map((entry) => structuredClone(entry.value));
	}
	async wait(id: string, signal?: AbortSignal): Promise<SubagentSnapshot> {
		const entry = this.entry(id);
		if (!signal) return entry.settled.promise;
		signal.throwIfAborted();
		const interrupted = Promise.withResolvers<never>();
		const abort = () => interrupted.reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		try {
			return await Promise.race([entry.settled.promise, interrupted.promise]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onSettled(listener: (value: SubagentSnapshot) => void): () => void {
		this.completions.add(listener);
		return () => this.completions.delete(listener);
	}
	async close(): Promise<void> {
		this.closed = true;
		this.completions.clear();
		for (const entry of this.entries.values()) entry.controller.abort();
		await Promise.all(
			[...this.entries.values()].map(async (entry) => {
				await entry.initialized.promise;
				try {
					await entry.session?.close();
				} finally {
					this.event(entry, {
						type: "settled",
						run: entry.value.run,
						status: "aborted",
						output: entry.value.output,
					});
					running.delete(entry.value.id);
				}
			}),
		);
		this.listeners.clear();
	}
	private entry(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown subagent: ${id}`);
		return entry;
	}
	private reserve(id: string): void {
		if (running.size >= 4) throw new Error("At most 4 subagents may run at once");
		running.add(id);
	}
	private event(entry: Entry, event: SubagentEvent): void {
		if (event.type === "session") entry.value.sessionId = event.sessionId;
		else if (entry.value.status !== "running" || event.run !== entry.value.run) return;
		else if (event.type === "text") entry.value.output = (entry.value.output + event.text).slice(-2 * 1024 * 1024);
		else {
			entry.value.status = event.status;
			entry.value.output = event.output.slice(-2 * 1024 * 1024);
			if (event.error) entry.value.error = event.error;
			entry.value.transcript.push({ role: "assistant", text: entry.value.output });
			while (entry.value.transcript.length > 128) entry.value.transcript.shift();
			running.delete(entry.value.id);
			const result = structuredClone(entry.value);
			entry.settled.resolve(result);
			for (const listener of this.completions) {
				try {
					listener(result);
				} catch {}
			}
		}
		this.changed();
	}
	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {}
		}
	}
}
