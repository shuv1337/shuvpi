import { spawn } from "node:child_process";
import { terminateProcessGroup } from "../background-jobs/process.ts";
import type { SubagentBackend } from "./types.ts";

export interface CodexSubagentOptions {
	command?: string;
	args?: string[];
	/** App-server v2 approval policy. Defaults to never with a read-only sandbox. */
	approvalPolicy?: "never" | "on-request" | "untrusted";
	sandbox?: "read-only" | "workspace-write";
	requestTimeoutMs?: number;
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Codex app-server v2 JSON-RPC adapter; no runtime-sidecar state is involved. */
export function createCodexSubagentBackend(options: CodexSubagentOptions = {}): SubagentBackend {
	return {
		name: "codex",
		async create(request, emit) {
			request.signal.throwIfAborted();
			const child = spawn(options.command ?? "codex", options.args ?? ["app-server"], {
				cwd: request.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			const pending = new Map<
				number,
				{
					method: string;
					resolve: (value: unknown) => void;
					reject: (error: Error) => void;
					timer: ReturnType<typeof setTimeout>;
				}
			>();
			let sequence = 0;
			let buffer = "";
			let stderr = "";
			let closing = false;
			let closingPromise: Promise<void> | undefined;
			let threadId: string | undefined;
			let turnId: string | undefined;
			let run = 0;
			let output = "";
			let stopped = Promise.withResolvers<void>();
			let active = false;
			const fail = (error: Error) => {
				for (const waiter of pending.values()) {
					clearTimeout(waiter.timer);
					waiter.reject(error);
				}
				pending.clear();
				if (active) {
					active = false;
					stopped.resolve();
					emit({ type: "settled", run, status: closing ? "aborted" : "error", output, error: error.message });
				}
			};
			child.on("error", fail);
			child.on("exit", (code) => fail(new Error(`Codex app-server exited (${code}): ${stderr}`)));
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString("utf8")).slice(-8192);
			});
			const write = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
			const rpc = (method: string, params: unknown): Promise<unknown> => {
				if (closing || child.exitCode !== null || child.signalCode !== null)
					return Promise.reject(new Error("Codex app-server is closed"));
				const id = ++sequence;
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						pending.delete(id);
						reject(new Error(`Codex ${method} timed out`));
					}, options.requestTimeoutMs ?? 10_000);
					pending.set(id, { method, resolve, reject, timer });
					write({ id, method, params });
				});
			};
			child.stdin.on("error", fail);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				if (buffer.length > 2 * 1024 * 1024) {
					fail(new Error("Codex protocol frame exceeded 2 MiB"));
					void close();
					return;
				}
				while (buffer.includes("\n")) {
					const newline = buffer.indexOf("\n");
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					let message: unknown;
					try {
						message = JSON.parse(line);
					} catch {
						fail(new Error("Invalid Codex protocol JSON"));
						void close();
						return;
					}
					if (!object(message)) continue;
					if (typeof message.id === "number" && !message.method) {
						const waiter = pending.get(message.id);
						if (!waiter) continue;
						pending.delete(message.id);
						clearTimeout(waiter.timer);
						if (message.error) waiter.reject(new Error(`Codex RPC error: ${JSON.stringify(message.error)}`));
						else {
							if (
								waiter.method === "turn/start" &&
								object(message.result) &&
								object(message.result.turn) &&
								typeof message.result.turn.id === "string"
							)
								turnId = message.result.turn.id;
							waiter.resolve(message.result);
						}
						continue;
					}
					if (message.id !== undefined && typeof message.method === "string") {
						// Headless children cannot authorize interactive approval or user-input requests.
						write({
							id: message.id,
							error: { code: -32601, message: "Interactive requests are not enabled for subagents" },
						});
						continue;
					}
					const params = message.params;
					if (!object(params) || params.threadId !== threadId || !active) continue;
					if (
						message.method === "item/agentMessage/delta" &&
						typeof params.delta === "string" &&
						turnId !== undefined &&
						params.turnId === turnId
					) {
						output = (output + params.delta).slice(-2 * 1024 * 1024);
						emit({ type: "text", run, text: params.delta });
					}
					if (
						message.method === "turn/completed" &&
						object(params.turn) &&
						turnId !== undefined &&
						params.turn.id === turnId
					) {
						active = false;
						stopped.resolve();
						emit({
							type: "settled",
							run,
							status:
								params.turn.status === "completed"
									? "done"
									: params.turn.status === "interrupted"
										? "aborted"
										: "error",
							output,
							error: params.turn.error ? JSON.stringify(params.turn.error) : undefined,
						});
					}
				}
			});
			const close = (): Promise<void> => {
				if (!closingPromise) {
					closing = true;
					closingPromise = terminateProcessGroup(child).finally(() => fail(new Error("Codex app-server closed")));
				}
				return closingPromise;
			};
			const abort = () => {
				void close();
			};
			request.signal.addEventListener("abort", abort, { once: true });
			try {
				await rpc("initialize", {
					clientInfo: { name: "shuvpi-subagent", version: "1.0" },
					capabilities: { experimentalApi: false },
				});
				write({ method: "initialized", params: {} });
				const result = await rpc("thread/start", {
					cwd: request.cwd,
					model: request.model,
					approvalPolicy: options.approvalPolicy ?? "never",
					sandbox: options.sandbox ?? "read-only",
					experimentalRawEvents: false,
					persistExtendedHistory: false,
				});
				if (!object(result) || !object(result.thread) || typeof result.thread.id !== "string")
					throw new Error("Invalid Codex thread/start result");
				threadId = result.thread.id;
				emit({ type: "session", sessionId: threadId });
				request.signal.throwIfAborted();
			} catch (error) {
				await close();
				request.signal.removeEventListener("abort", abort);
				throw error;
			}
			return {
				async send(prompt, steer, nextRun) {
					const input = [{ type: "text", text: prompt, text_elements: [] }];
					if (steer) {
						if (!turnId || !active) throw new Error("No running Codex turn to steer");
						await rpc("turn/steer", { threadId, expectedTurnId: turnId, input });
						return;
					}
					if (active) throw new Error("Codex subagent is already running");
					run = nextRun;
					output = "";
					turnId = undefined;
					active = true;
					stopped = Promise.withResolvers<void>();
					try {
						const result = await rpc("turn/start", {
							threadId,
							input,
							model: request.model,
							effort: request.effort,
						});
						if (!object(result) || !object(result.turn) || typeof result.turn.id !== "string")
							throw new Error("Invalid Codex turn/start result");
						turnId = result.turn.id;
					} catch (error) {
						fail(error instanceof Error ? error : new Error(String(error)));
						throw error;
					}
				},
				async interrupt() {
					if (!active) return;
					try {
						await rpc("turn/interrupt", { threadId, turnId });
						let timer: ReturnType<typeof setTimeout> | undefined;
						try {
							await Promise.race([
								stopped.promise,
								new Promise<never>((_resolve, reject) => {
									timer = setTimeout(
										() => reject(new Error("Codex interrupt timed out")),
										options.requestTimeoutMs ?? 10_000,
									);
								}),
							]);
						} finally {
							if (timer) clearTimeout(timer);
						}
					} catch {
						await close();
					}
				},
				async close() {
					request.signal.removeEventListener("abort", abort);
					await close();
				},
			};
		},
	};
}
