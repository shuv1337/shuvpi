import type { AgentMessage } from "@shuv1337/shuvpi-agent-core";
import { isArtifactMessage } from "../../artifact-message.ts";

type ArtifactMutation = {
	command: "create" | "update" | "rewrite" | "delete";
	filename: string;
	content?: string;
	old_str?: string;
	new_str?: string;
};

function readMutation(value: unknown): ArtifactMutation | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.filename !== "string") return undefined;
	const command = candidate.command;
	if (command !== "create" && command !== "update" && command !== "rewrite" && command !== "delete") {
		return undefined;
	}
	return {
		command,
		filename: candidate.filename,
		content: typeof candidate.content === "string" ? candidate.content : undefined,
		old_str: typeof candidate.old_str === "string" ? candidate.old_str : undefined,
		new_str: typeof candidate.new_str === "string" ? candidate.new_str : undefined,
	};
}

/** Compute the artifact snapshot represented by a complete agent transcript. */
export function reconstructArtifactContents(messages: readonly AgentMessage[]): Map<string, string> {
	const toolCalls = new Map<string, unknown>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && block.name === "artifacts") {
				toolCalls.set(block.id, block.arguments);
			}
		}
	}

	const mutations: ArtifactMutation[] = [];
	for (const message of messages) {
		if (isArtifactMessage(message)) {
			if (message.action === "delete") {
				mutations.push({ command: "delete", filename: message.filename });
			} else {
				mutations.push({
					command: message.action === "create" ? "create" : "rewrite",
					filename: message.filename,
					content: message.content,
				});
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== "artifacts" || message.isError) continue;
		const mutation = readMutation(toolCalls.get(message.toolCallId));
		if (mutation) mutations.push(mutation);
	}

	const artifacts = new Map<string, string>();
	for (const mutation of mutations) {
		switch (mutation.command) {
			case "create":
			case "rewrite":
				if (mutation.content) artifacts.set(mutation.filename, mutation.content);
				break;
			case "update": {
				const content = artifacts.get(mutation.filename);
				if (content && mutation.old_str !== undefined && mutation.new_str !== undefined) {
					artifacts.set(mutation.filename, content.replace(mutation.old_str, mutation.new_str));
				}
				break;
			}
			case "delete":
				artifacts.delete(mutation.filename);
				break;
		}
	}

	return artifacts;
}
