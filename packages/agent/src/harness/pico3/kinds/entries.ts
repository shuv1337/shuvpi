import type { AssistantMessage, ToolResultMessage, UserMessage } from "@shuv1337/shuvpi-ai";
import type { Entry, EntryKind, Id, JsonValue, SystemMessage, ToolControl } from "../types.ts";

export type UserEntry = Entry & { kind: "shuvpi.user"; model: [UserMessage]; data?: { continuation: true; from: Id } };
export type AssistantEntry = Entry & { kind: "shuvpi.assistant"; model: [AssistantMessage]; data: { attempt: number } };
export type ToolResultEntry = Entry & {
	kind: "shuvpi.tool_result";
	model: [ToolResultMessage];
	data: {
		details?: JsonValue;
		diagnostics?: JsonValue;
		control?: ToolControl;
		truncated?: { bytes: number; lines: number };
	};
};
export type SystemEntry = Entry & { kind: "shuvpi.system"; model: [SystemMessage]; data: { baseline: boolean } };
export type NoticeEntry = Entry & { kind: "shuvpi.notice"; model: [UserMessage] };
export type UsageEntry = Entry & {
	kind: "shuvpi.usage";
	data: { attempt: number; usage?: AssistantMessage["usage"]; error: string };
};
export type SummaryEntry = Entry & { kind: "shuvpi.summary"; model: [UserMessage]; data: { through: Id }; head: Id };
export type HandoffEntry = Entry & { kind: "shuvpi.handoff"; model: [UserMessage]; head: Id };
export type ResetEntry = Entry & { kind: "shuvpi.reset"; head: Id };

const coreEntry = <E extends Entry>(kind: string): EntryKind<E> =>
	Object.freeze({ kind, is: (entry: Entry | undefined): entry is E => entry?.kind === kind });

export const entries = {
	user: coreEntry<UserEntry>("shuvpi.user"),
	assistant: coreEntry<AssistantEntry>("shuvpi.assistant"),
	toolResult: coreEntry<ToolResultEntry>("shuvpi.tool_result"),
	system: coreEntry<SystemEntry>("shuvpi.system"),
	notice: coreEntry<NoticeEntry>("shuvpi.notice"),
	usage: coreEntry<UsageEntry>("shuvpi.usage"),
	summary: coreEntry<SummaryEntry>("shuvpi.summary"),
	handoff: coreEntry<HandoffEntry>("shuvpi.handoff"),
	reset: coreEntry<ResetEntry>("shuvpi.reset"),
} as const;
