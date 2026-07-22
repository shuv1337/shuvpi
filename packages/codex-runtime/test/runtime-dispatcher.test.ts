import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CloseRequestSchema,
	type Envelope,
	EnvelopeSchema,
	FollowUpRequestSchema,
	HostToolDefinitionSchema,
	HostToolResultSchema,
	PromptRequestSchema,
	ResumeRequestSchema,
	RuntimeRequestSchema,
	type SessionEvent,
	SessionEventSchema,
	SessionStatusSchema,
	SpawnRequestSchema,
	StatusRequestSchema,
} from "../src/gen/pi_codex_runtime_pb.ts";
import type { ResumePiSessionOptions, SpawnPiSessionOptions } from "../src/sdk/pi-sdk-session.ts";
import {
	RuntimeDispatcher,
	type RuntimeResponseSink,
	type RuntimeSession,
	type RuntimeSessionFactory,
} from "../src/server/runtime-dispatcher.ts";

class RecordingSink implements RuntimeResponseSink {
	readonly envelopes: Envelope[] = [];

	send(envelope: Envelope): void {
		this.envelopes.push(envelope);
	}
}

class FakeSession implements RuntimeSession {
	readonly sessionLocator = "/sessions/fake.jsonl";
	readonly provider = "faux";
	readonly model = "faux-model";
	readonly thinkingLevel = "high";
	readonly prompts: string[] = [];
	readonly followUps: string[] = [];
	readonly errors: Array<{ code: string; message: string; retryable: boolean }> = [];
	closed = false;
	private promptCompletion: Promise<void> = Promise.resolve();

	setPromptCompletion(completion: Promise<void>): void {
		this.promptCompletion = completion;
	}

	prompt(text: string): Promise<void> {
		this.prompts.push(text);
		return this.promptCompletion;
	}

	async steer(): Promise<void> {}
	async followUp(text: string): Promise<void> {
		this.followUps.push(text);
	}
	async interrupt(): Promise<void> {}

	status() {
		return create(SessionStatusSchema, { state: "idle" });
	}

	reportError(code: string, message: string, retryable = false): void {
		this.errors.push({ code, message, retryable });
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeFactory implements RuntimeSessionFactory {
	readonly session = new FakeSession();
	spawnOptions: SpawnPiSessionOptions | undefined;
	resumeOptions: ResumePiSessionOptions | undefined;

	async spawn(options: SpawnPiSessionOptions): Promise<RuntimeSession> {
		this.spawnOptions = options;
		return this.session;
	}

	async resume(options: ResumePiSessionOptions): Promise<RuntimeSession> {
		this.resumeOptions = options;
		return this.session;
	}
}

function spawnRequest(requestId = "spawn-1"): Envelope {
	return create(EnvelopeSchema, {
		protocolVersion: 2,
		payload: {
			case: "request",
			value: create(RuntimeRequestSchema, {
				requestId,
				sessionId: "child-1",
				command: {
					case: "spawn",
					value: create(SpawnRequestSchema, {
						codexThreadId: "codex-thread-1",
						cwd: "/work",
						agentDir: "/agent",
						sessionDir: "/sessions",
						provider: "faux",
						model: "faux-model",
						thinkingLevel: "high",
						hostTools: [
							create(HostToolDefinitionSchema, {
								name: "host_echo",
								description: "Echo through Codex",
								inputSchemaJson: new TextEncoder().encode(JSON.stringify({ type: "object" })),
							}),
						],
					}),
				},
			}),
		},
	});
}

function sessionRequest(
	requestId: string,
	command:
		| { case: "prompt"; value: ReturnType<typeof create<typeof PromptRequestSchema>> }
		| { case: "followUp"; value: ReturnType<typeof create<typeof FollowUpRequestSchema>> }
		| { case: "status"; value: ReturnType<typeof create<typeof StatusRequestSchema>> }
		| { case: "close"; value: ReturnType<typeof create<typeof CloseRequestSchema>> },
): Envelope {
	return create(EnvelopeSchema, {
		protocolVersion: 2,
		payload: {
			case: "request",
			value: create(RuntimeRequestSchema, { requestId, sessionId: "child-1", command }),
		},
	});
}

function resumeRequest(): Envelope {
	return create(EnvelopeSchema, {
		protocolVersion: 2,
		payload: {
			case: "request",
			value: create(RuntimeRequestSchema, {
				requestId: "resume-1",
				sessionId: "child-1",
				command: {
					case: "resume",
					value: create(ResumeRequestSchema, {
						codexThreadId: "codex-thread-1",
						sessionLocator: "/sessions/fake.jsonl",
						cwdOverride: "/work",
						agentDir: "/custom-agent",
					}),
				},
			}),
		},
	});
}

function responseResult(envelope: Envelope): string | undefined {
	if (envelope.payload.case !== "response") {
		return undefined;
	}
	return envelope.payload.value.result.case;
}

describe("RuntimeDispatcher", () => {
	it("preserves agentDir on resume and dispatches plaintext follow-ups", async () => {
		const factory = new FakeFactory();
		const dispatcher = new RuntimeDispatcher(factory);
		const sink = new RecordingSink();

		await dispatcher.handleEnvelope(sink, resumeRequest());
		expect(factory.resumeOptions).toMatchObject({
			sessionId: "child-1",
			sessionLocator: "/sessions/fake.jsonl",
			cwdOverride: "/work",
			agentDir: "/custom-agent",
		});
		await dispatcher.handleEnvelope(
			sink,
			sessionRequest("follow-up-1", {
				case: "followUp",
				value: create(FollowUpRequestSchema, { text: "continue" }),
			}),
		);
		expect(factory.session.followUps).toEqual(["continue"]);
	});

	it("owns spawn, streaming events, non-blocking prompts, status, and close", async () => {
		const factory = new FakeFactory();
		const dispatcher = new RuntimeDispatcher(factory);
		const sink = new RecordingSink();

		await dispatcher.handleEnvelope(sink, spawnRequest());
		expect(responseResult(sink.envelopes[0])).toBe("spawned");
		expect(factory.spawnOptions).toMatchObject({
			sessionId: "child-1",
			cwd: "/work",
			agentDir: "/agent",
			sessionDir: "/sessions",
			provider: "faux",
			model: "faux-model",
			thinkingLevel: "high",
		});

		const event: SessionEvent = create(SessionEventSchema, { sessionId: "child-1", sequence: 0n });
		factory.spawnOptions?.onEvent(event);
		expect(sink.envelopes[1].payload.case).toBe("event");

		let finishPrompt: (() => void) | undefined;
		factory.session.setPromptCompletion(
			new Promise<void>((resolve) => {
				finishPrompt = resolve;
			}),
		);
		await dispatcher.handleEnvelope(
			sink,
			sessionRequest("prompt-1", { case: "prompt", value: create(PromptRequestSchema, { text: "hello" }) }),
		);
		expect(factory.session.prompts).toEqual(["hello"]);
		expect(responseResult(sink.envelopes[2])).toBe("ack");
		finishPrompt?.();

		await dispatcher.handleEnvelope(
			sink,
			sessionRequest("status-1", { case: "status", value: create(StatusRequestSchema) }),
		);
		expect(responseResult(sink.envelopes[3])).toBe("status");

		await dispatcher.handleEnvelope(
			sink,
			sessionRequest("close-1", { case: "close", value: create(CloseRequestSchema) }),
		);
		expect(responseResult(sink.envelopes[4])).toBe("ack");
		expect(factory.session.closed).toBe(true);
	});

	it("returns structured errors for duplicate and missing sessions", async () => {
		const factory = new FakeFactory();
		const dispatcher = new RuntimeDispatcher(factory);
		const sink = new RecordingSink();

		await dispatcher.handleEnvelope(sink, spawnRequest());
		await dispatcher.handleEnvelope(sink, spawnRequest("spawn-duplicate"));
		expect(responseResult(sink.envelopes[1])).toBe("error");

		await dispatcher.handleEnvelope(
			sink,
			sessionRequest("close-1", { case: "close", value: create(CloseRequestSchema) }),
		);
		await dispatcher.handleEnvelope(
			sink,
			sessionRequest("status-missing", { case: "status", value: create(StatusRequestSchema) }),
		);
		expect(responseResult(sink.envelopes.at(-1) ?? create(EnvelopeSchema))).toBe("error");
	});

	it("turns an asynchronous prompt failure into a session error event", async () => {
		const factory = new FakeFactory();
		const dispatcher = new RuntimeDispatcher(factory);
		const sink = new RecordingSink();
		await dispatcher.handleEnvelope(sink, spawnRequest());
		factory.session.setPromptCompletion(Promise.reject(new Error("model unavailable")));

		await dispatcher.handleEnvelope(
			sink,
			sessionRequest("prompt-1", { case: "prompt", value: create(PromptRequestSchema, { text: "hello" }) }),
		);
		await Promise.resolve();
		expect(factory.session.errors).toEqual([
			{ code: "prompt_failed", message: "model unavailable", retryable: false },
		]);
	});

	it("round-trips a correlated host tool request and result", async () => {
		const factory = new FakeFactory();
		const dispatcher = new RuntimeDispatcher(factory);
		const sink = new RecordingSink();
		await dispatcher.handleEnvelope(sink, spawnRequest());

		const completion = factory.spawnOptions?.onHostToolCall?.("call-1", "host_echo", { text: "hello" }, undefined);
		expect(completion).toBeDefined();
		const requestEnvelope = sink.envelopes.at(-1);
		expect(requestEnvelope?.payload.case).toBe("hostToolRequest");
		if (requestEnvelope?.payload.case !== "hostToolRequest") throw new Error("missing host request");

		await dispatcher.handleEnvelope(
			sink,
			create(EnvelopeSchema, {
				protocolVersion: 2,
				payload: {
					case: "hostToolResult",
					value: create(HostToolResultSchema, {
						requestId: requestEnvelope.payload.value.requestId,
						sessionId: "child-1",
						toolCallId: "call-1",
						resultJson: new TextEncoder().encode(JSON.stringify({ content: [{ type: "text", text: "hello" }] })),
					}),
				},
			}),
		);

		await expect(completion).resolves.toEqual({ content: [{ type: "text", text: "hello" }] });
	});
});
