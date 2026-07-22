import type { Agent, AgentEvent, AgentMessage, AgentState, AgentTool } from "@shuv1337/shuvpi-agent-core";

export type AgentSessionListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/**
 * Structural session surface required by the web UI.
 *
 * Remote sessions can implement this interface without constructing a local
 * Agent or exposing its executable stream and tool internals.
 */
export interface AgentSession {
	readonly state: AgentState;
	prompt(input: string): Promise<void>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	subscribe(listener: AgentSessionListener): () => void;
	abort(): void;
}

export type SelectedAgentSession =
	| { ownership: "local"; session: Agent }
	| { ownership: "remote"; session: AgentSession };

/** Resolve an explicitly selected local or remote session without inspecting its method shape. */
export function selectAgentSession(
	localAgent: Agent | undefined,
	remoteSession: AgentSession | undefined,
): SelectedAgentSession | undefined {
	if (remoteSession) return { ownership: "remote", session: remoteSession };
	if (localAgent) return { ownership: "local", session: localAgent };
	return undefined;
}

/** Invalidates asynchronous connection setup when its host disconnects or reconnects. */
export class AgentSessionConnectionGuard {
	private generation = 0;

	begin(): number {
		this.generation++;
		return this.generation;
	}

	disconnect(): void {
		this.generation++;
	}

	isCurrent(generation: number, isConnected: boolean): boolean {
		return isConnected && generation === this.generation;
	}
}

/** Install executable tools only when the host owns the session's tool runtime. */
export function installManagedTools(session: AgentSession, manageTools: boolean, createTools: () => AgentTool[]): void {
	if (!manageTools) return;
	session.state.tools = createTools();
}
