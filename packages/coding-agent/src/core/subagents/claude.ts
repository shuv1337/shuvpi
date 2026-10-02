import type { SubagentBackend } from "./types.ts";

/** Structural SDK seam keeps this optional backend independent of an installed Claude SDK version. */
export interface ClaudeSubagentQuery extends AsyncIterable<unknown> {
	interrupt(): Promise<unknown>;
	close(): void;
}
export interface ClaudeSubagentQueryOptions {
	prompt: string;
	options: {
		cwd: string;
		model?: string;
		effort?: "low" | "medium" | "high" | "xhigh" | "max";
		resume?: string;
		permissionMode: "default" | "acceptEdits" | "plan";
		abortController: AbortController;
		disallowedTools: string[];
	};
}
export type ClaudeSubagentQueryFactory = (options: ClaudeSubagentQueryOptions) => ClaudeSubagentQuery;

export function createClaudeSubagentBackend(
	query: ClaudeSubagentQueryFactory,
	permissionMode: ClaudeSubagentQueryOptions["options"]["permissionMode"] = "default",
): SubagentBackend {
	return {
		name: "claude",
		async create(request, emit) {
			const effort = request.effort;
			if (effort === "off" || effort === "minimal" || effort === "ultra")
				throw new Error(`Claude SDK does not support effort ${effort}`);
			let sessionId: string | undefined;
			let active: Promise<void> | undefined;
			let stream: ClaudeSubagentQuery | undefined;
			let abortController: AbortController | undefined;
			let interrupted = false;
			const interrupt = async () => {
				interrupted = true;
				try {
					await stream?.interrupt();
				} finally {
					abortController?.abort();
					stream?.close();
					await active;
				}
			};
			return {
				async send(prompt, steer, run) {
					// SDK string prompts admit one turn per query; an idle follow-up resumes the recorded session.
					if (steer)
						throw new Error(
							"Claude steering is unavailable while a turn is running; cancel it before sending a follow-up",
						);
					if (active) throw new Error("Claude subagent is already running");
					request.signal.throwIfAborted();
					interrupted = false;
					abortController = new AbortController();
					stream = query({
						prompt,
						options: {
							cwd: request.cwd,
							model: request.model,
							effort,
							resume: sessionId,
							permissionMode,
							abortController,
							disallowedTools: ["Agent", "Task", "AskUserQuestion"],
						},
					});
					const current = stream;
					active = (async () => {
						let output = "";
						let resultSeen = false;
						let failure: string | undefined;
						try {
							for await (const message of current) {
								if (!message || typeof message !== "object") continue;
								if ("session_id" in message && typeof message.session_id === "string") {
									sessionId = message.session_id;
									emit({ type: "session", sessionId });
								}
								if (
									"type" in message &&
									message.type === "assistant" &&
									"message" in message &&
									message.message &&
									typeof message.message === "object" &&
									"content" in message.message &&
									Array.isArray(message.message.content)
								) {
									for (const block of message.message.content) {
										if (
											block &&
											typeof block === "object" &&
											block.type === "text" &&
											typeof block.text === "string"
										) {
											output = (output + block.text).slice(-2 * 1024 * 1024);
											emit({ type: "text", run, text: block.text });
										}
									}
								}
								if ("type" in message && message.type === "result") {
									resultSeen = true;
									const failed = "is_error" in message && message.is_error === true;
									if ("result" in message && typeof message.result === "string") output = message.result;
									if (failed) failure = "Claude turn failed";
								}
							}
							if (!resultSeen && !interrupted) failure = "Claude stream ended without a result";
						} catch (error) {
							failure = String(error);
						} finally {
							current.close();
							active = undefined;
							stream = undefined;
							emit({
								type: "settled",
								run,
								status: interrupted ? "aborted" : failure ? "error" : "done",
								output,
								error: failure,
							});
						}
					})();
				},
				interrupt,
				close: interrupt,
			};
		},
	};
}
