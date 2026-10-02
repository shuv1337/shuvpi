import type { ModelThinkingLevel } from "@shuv1337/shuvpi-ai";
import type { ExtensionContext } from "../extensions/types.ts";

export type SubagentBackendName = "pi" | "claude" | "codex";
export interface SubagentRequest {
	prompt: string;
	title: string;
	cwd: string;
	model?: string;
	effort?: ModelThinkingLevel;
	parent: ExtensionContext;
	signal: AbortSignal;
}
export type SubagentEvent =
	| { type: "text"; run: number; text: string }
	| { type: "settled"; run: number; status: "done" | "error" | "aborted"; output: string; error?: string }
	| { type: "session"; sessionId: string };
export interface SubagentSession {
	/** Resolve once a prompt is admitted; completion arrives through the event callback. */
	send(prompt: string, steer: boolean, run: number): Promise<void>;
	/** Resolve only once the active run has stopped. */
	interrupt(): Promise<void>;
	close(): Promise<void>;
}
export interface SubagentBackend {
	name: SubagentBackendName;
	create(request: SubagentRequest, emit: (event: SubagentEvent) => void): Promise<SubagentSession>;
}
export interface SubagentSnapshot {
	id: string;
	backend: SubagentBackendName;
	title: string;
	cwd: string;
	status: "running" | "done" | "error" | "aborted";
	run: number;
	output: string;
	error?: string;
	sessionId?: string;
	originEntryId?: string | null;
	transcript: Array<{ role: "user" | "assistant"; text: string }>;
}
