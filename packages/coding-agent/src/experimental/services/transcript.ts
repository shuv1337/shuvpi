import { defineService, type ReplicatedState } from "@shuv1337/shuvpi-chord";
import type { ConversationView } from "@shuv1337/shuvpi-durable";

/** The root conversation's durable view: active entries and its live, inbox, agent, and usage documents. */
export interface Transcript {
	readonly state: ReplicatedState<ConversationView>;
}

export const Transcript = defineService<Transcript>("pi.transcript");
