import { getCurrentSystemPrompt, type Model } from "@shuv1337/shuvpi-ai";
import { streamSimple as streamAnthropic } from "@shuv1337/shuvpi-ai/api/anthropic-messages";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

interface WireBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
}

interface WireRequest {
	model: string;
	system?: WireBlock[];
	messages: Array<{ role: string; content: string | WireBlock[]; output_config?: { effort: string } }>;
	thinking?: { type: string };
	output_config?: { effort: string };
}

function response(model: string, label: string, text: string): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${label}`,
				model,
				role: "assistant",
				content: [],
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `${label} thought` } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `signature-${label}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

// HIST-07: selected current models, real session/transcript/compaction code, entirely fake HTTP.
describe("selected thinking and system history across compaction", () => {
	it.each(["claude-opus-5", "claude-sonnet-5", "claude-fable-5"] as const)(
		"preserves retained signed thinking and checkpoints system updates with %s",
		async (id) => {
			let policy = "initial-policy";
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false, keepRecentTokens: 60, reserveTokens: 1024 } },
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", (event) => {
							event.systemPromptOptions.sections.fixture_policy = policy;
						});
					},
				],
			});
			try {
				const runtime = harness.session.modelRuntime;
				await runtime.setRuntimeApiKey("anthropic", "local-fixture-key");
				const selected = runtime.getModel("anthropic", id)!;
				expect(selected.api).toBe("anthropic-messages");
				const requests: WireRequest[] = [];
				const replies = [
					["old", "old answer"],
					["retained", "retained answer"],
					["summary", "## Goal\nCompleted the old request."],
					["continued", "continued answer"],
				];
				const fetch: typeof globalThis.fetch = async (input, init) => {
					const request = input instanceof Request ? input : new Request(input, init);
					const body = JSON.parse(await request.text()) as WireRequest;
					const reply = replies[requests.length];
					requests.push(body);
					if (!reply) throw new Error("Unexpected extra fixture request");
					return response(body.model, reply[0], reply[1]);
				};
				harness.session.agent.streamFunction = (model, context, options) => {
					if (model.api !== "anthropic-messages") throw new Error(`Unexpected fixture API ${model.api}`);
					return streamAnthropic(model as Model<"anthropic-messages">, context, { ...options, fetch });
				};
				await harness.session.setModel(selected);
				harness.session.setThinkingLevel("low");
				await harness.session.prompt(`old request ${"O".repeat(2000)}`);
				policy = "updated-policy";
				harness.session.setThinkingLevel("high");
				const retainedQuestion = `retained request ${"R".repeat(400)}`;
				await harness.session.prompt(retainedQuestion);
				expect(requests).toHaveLength(2);
				expect(requests[0].thinking?.type).toBe("adaptive");
				expect(requests[1].thinking?.type).toBe("adaptive");
				expect(JSON.stringify(requests[0].system)).toContain("initial-policy");
				expect(JSON.stringify(requests[1])).toContain("updated-policy");
				expect(requests[1].messages).toContainEqual({
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "old thought", signature: "signature-old" },
						{ type: "text", text: "old answer" },
					],
				});
				if (id === "claude-sonnet-5") {
					expect(JSON.stringify(requests[1].system)).toContain("updated-policy");
					expect(requests[1].messages.filter((message) => message.role === "system")).toEqual([]);
				} else {
					expect(JSON.stringify(requests[1].messages.filter((message) => message.role === "system"))).toContain(
						"updated-policy",
					);
				}

				const result = await harness.session.compact();
				expect(result.summary).toBe("## Goal\nCompleted the old request.");
				expect(requests).toHaveLength(3);
				expect(requests[2].model).toBe(id);
				expect(requests[2].thinking?.type).toBe("adaptive");
				expect(JSON.stringify(requests[2].messages)).toContain("[Assistant thinking]: old thought");
				expect(JSON.stringify(requests[2].messages)).not.toContain("signature-old");
				expect(getCurrentSystemPrompt(harness.session.messages)).toContain("updated-policy");
				expect(getCurrentSystemPrompt(harness.session.messages)).not.toContain("initial-policy");
				expect(harness.session.messages.filter((message) => message.role === "system")).toHaveLength(1);
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);

				await harness.session.prompt("continue after compaction");
				expect(requests).toHaveLength(4);
				const continued = requests[3];
				expect(JSON.stringify(continued.system)).toContain("updated-policy");
				expect(JSON.stringify(continued)).not.toContain("initial-policy");
				expect(JSON.stringify(continued.messages)).toContain("Completed the old request.");
				expect(JSON.stringify(continued.messages)).toContain(retainedQuestion);
				expect(JSON.stringify(continued.messages)).not.toContain("old thought");
				expect(JSON.stringify(continued.messages)).not.toContain("summary thought");
				expect(continued.messages).toContainEqual({
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "retained thought", signature: "signature-retained" },
						{ type: "text", text: "retained answer" },
					],
				});
				expect(harness.session.messages.at(-1)).toMatchObject({
					role: "assistant",
					model: id,
					stopReason: "stop",
				});
			} finally {
				harness.cleanup();
			}
		},
	);
});
