import type { AgentMessage } from "@shuv1337/shuvpi-agent-core";
import type { AgentSession } from "./agent-session.ts";

/**
 * Coalesces transcript-driven asynchronous UI reconstruction.
 *
 * Only one reconstruction runs at a time. If events arrive while it is
 * running, intermediate snapshots are replaced by the newest transcript.
 */
export class AgentTranscriptReconciler {
	private readonly session: AgentSession;
	private readonly apply: (messages: readonly AgentMessage[]) => Promise<void>;
	private readonly onError?: (error: unknown) => void;
	private unsubscribe?: () => void;
	private pending?: AgentMessage[];
	private draining?: Promise<void>;
	private disposed = false;

	constructor(
		session: AgentSession,
		apply: (messages: readonly AgentMessage[]) => Promise<void>,
		onError?: (error: unknown) => void,
	) {
		this.session = session;
		this.apply = apply;
		this.onError = onError;
	}

	connect(): Promise<void> {
		if (this.disposed || this.unsubscribe) return Promise.resolve();
		this.unsubscribe = this.session.subscribe((event) => {
			if (event.type !== "message_end" && event.type !== "turn_end" && event.type !== "agent_end") return;
			void this.reconcile().catch((error: unknown) => this.onError?.(error));
		});
		return this.reconcile();
	}

	reconcile(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.pending = this.session.state.messages.slice();
		if (!this.draining) {
			this.draining = this.drain();
		}
		return this.draining;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pending = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private async drain(): Promise<void> {
		const errors: unknown[] = [];
		try {
			while (!this.disposed && this.pending) {
				const messages = this.pending;
				this.pending = undefined;
				try {
					await this.apply(messages);
				} catch (error: unknown) {
					errors.push(error);
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Artifact transcript reconciliation failed");
		} finally {
			this.draining = undefined;
		}
	}
}
