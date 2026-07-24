import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@shuv1337/shuvpi-agent-core";
import type { Usage } from "@shuv1337/shuvpi-ai";
import { reconstructArtifactContents } from "../src/tools/artifacts/artifact-transcript.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function artifactToolCall(id: string, argumentsValue: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "artifacts", arguments: argumentsValue }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(id: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "artifacts",
		content: [{ type: "text", text: "ok" }],
		isError,
		timestamp: 2,
	};
}

describe("reconstructArtifactContents", () => {
	it("replays successful artifact tool calls in transcript order", () => {
		const messages: AgentMessage[] = [
			artifactToolCall("create", { command: "create", filename: "note.txt", content: "alpha" }),
			toolResult("create"),
			artifactToolCall("update", {
				command: "update",
				filename: "note.txt",
				old_str: "alpha",
				new_str: "beta",
			}),
			toolResult("update"),
		];

		assert.deepEqual(Array.from(reconstructArtifactContents(messages)), [["note.txt", "beta"]]);
	});

	it("replays remote artifact messages and deletion", () => {
		const messages: AgentMessage[] = [
			{
				role: "artifact",
				action: "create",
				filename: "remote.md",
				content: "first",
				title: "Remote",
				timestamp: "2026-07-21T00:00:00.000Z",
			},
			{
				role: "artifact",
				action: "update",
				filename: "remote.md",
				content: "second",
				timestamp: "2026-07-21T00:00:01.000Z",
			},
			{
				role: "artifact",
				action: "delete",
				filename: "remote.md",
				timestamp: "2026-07-21T00:00:02.000Z",
			},
		];

		assert.deepEqual(Array.from(reconstructArtifactContents(messages)), []);
	});

	it("preserves prior content when a rewrite has empty content", () => {
		const messages: AgentMessage[] = [
			{
				role: "artifact",
				action: "create",
				filename: "remote.md",
				content: "alpha",
				timestamp: "2026-07-21T00:00:00.000Z",
			},
			{
				role: "artifact",
				action: "update",
				filename: "remote.md",
				content: "",
				timestamp: "2026-07-21T00:00:01.000Z",
			},
		];

		assert.deepEqual(Array.from(reconstructArtifactContents(messages)), [["remote.md", "alpha"]]);

		const toolMessages: AgentMessage[] = [
			artifactToolCall("create", { command: "create", filename: "tool.txt", content: "alpha" }),
			toolResult("create"),
			artifactToolCall("rewrite", { command: "rewrite", filename: "tool.txt", content: "" }),
			toolResult("rewrite"),
		];
		assert.deepEqual(Array.from(reconstructArtifactContents(toolMessages)), [["tool.txt", "alpha"]]);
	});

	it("ignores failed tool results", () => {
		const messages: AgentMessage[] = [
			artifactToolCall("failed", { command: "create", filename: "failed.txt", content: "nope" }),
			toolResult("failed", true),
		];

		assert.deepEqual(Array.from(reconstructArtifactContents(messages)), []);
	});

	it("ignores malformed artifact actions instead of treating them as rewrites", () => {
		const malformed = {
			role: "artifact",
			action: "bogus",
			filename: "remote.md",
			content: "beta",
			timestamp: "2026-07-21T00:00:01.000Z",
		} as unknown as AgentMessage;
		const messages: AgentMessage[] = [
			{
				role: "artifact",
				action: "create",
				filename: "remote.md",
				content: "alpha",
				timestamp: "2026-07-21T00:00:00.000Z",
			},
			malformed,
		];

		assert.deepEqual(Array.from(reconstructArtifactContents(messages)), [["remote.md", "alpha"]]);
	});

	it("does not mutate the transcript while replaying it", () => {
		const argumentsValue = Object.freeze({ command: "create", filename: "note.txt", content: "alpha" });
		const messages = Object.freeze<AgentMessage[]>([
			artifactToolCall("create", argumentsValue),
			toolResult("create"),
		]);
		const before = JSON.stringify(messages);

		reconstructArtifactContents(messages);

		assert.equal(JSON.stringify(messages), before);
	});
});
