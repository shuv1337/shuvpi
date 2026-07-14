import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@shuv1337/shuvpi-ai/compat";
import { AuthStorage, ModelRegistry } from "@shuv1337/shuvpi-coding-agent";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { HostToolDefinitionSchema, type SessionEvent } from "../src/gen/pi_codex_runtime_pb.js";
import { PiSdkSessionFactory } from "../src/sdk/pi-sdk-session.js";

describe("PiSdkSessionFactory", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("spawns and resumes a persistent no-tools Pi SDK session with native lifecycle events", async () => {
		const directory = join(tmpdir(), `pi-codex-sdk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(directory, "agent");
		const sessionDir = join(directory, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("resumed reply")]);
		const model = faux.getModel();
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[model.provider]: {
						baseUrl: model.baseUrl,
						api: model.api,
						apiKey: "faux-key",
						models: [
							{
								id: model.id,
								name: model.name,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							},
						],
					},
				},
			}),
		);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const factory = new PiSdkSessionFactory({ authStorage, modelRegistry });
		const firstEvents: SessionEvent[] = [];
		const session = await factory.spawn({
			sessionId: "codex-child-1",
			cwd: directory,
			agentDir,
			sessionDir,
			provider: model.provider,
			model: model.id,
			onEvent: (event) => firstEvents.push(event),
		});
		cleanups.push(async () => session.close());

		expect(session.activeToolNames).toEqual([]);
		expect(session.provider).toBe(model.provider);
		expect(session.model).toBe(model.id);
		await session.prompt("say first");
		const sessionLocator = session.sessionLocator;
		expect(existsSync(sessionLocator)).toBe(true);
		expect(firstEvents.map((event) => event.event.case)).toEqual(
			expect.arrayContaining([
				"agentStart",
				"turnStart",
				"messageStart",
				"textDelta",
				"messageEnd",
				"turnEnd",
				"agentEnd",
				"tokenUsage",
			]),
		);
		expect(firstEvents.map((event) => event.sequence)).toEqual(
			firstEvents.map((_event, index) => BigInt(index)),
		);
		const assistantStart = firstEvents.find(
			(event) => event.event.case === "messageStart" && event.event.value.role === "assistant",
		);
		const assistantEnd = firstEvents.find(
			(event) => event.event.case === "messageEnd" && event.event.value.role === "assistant",
		);
		expect(assistantStart?.event.case === "messageStart" ? assistantStart.event.value.messageId : undefined).toBe(
			assistantEnd?.event.case === "messageEnd" ? assistantEnd.event.value.messageId : undefined,
		);
		await session.close();

		const resumedEvents: SessionEvent[] = [];
		const resumed = await factory.resume({
			sessionId: "codex-child-1-resumed",
			sessionLocator,
			cwdOverride: directory,
			agentDir,
			onEvent: (event) => resumedEvents.push(event),
		});
		cleanups.push(async () => resumed.close());
		expect(resumed.activeToolNames).toEqual([]);
		await resumed.prompt("say resumed");
		expect(resumedEvents.some((event) => event.event.case === "textDelta")).toBe(true);
		expect(resumedEvents.some((event) => event.event.case === "agentEnd")).toBe(true);
		expect(faux.state.callCount).toBe(2);
	});

	it("exposes only Codex host tools and returns their result to the model", async () => {
		const directory = join(tmpdir(), `pi-codex-host-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(directory, "agent");
		const sessionDir = join(directory, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("host_echo", { text: "hello" }, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("host tool completed"),
		]);
		const model = faux.getModel();
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
			[model.provider]: {
				baseUrl: model.baseUrl,
				api: model.api,
				apiKey: "faux-key",
				models: [{
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				}],
			},
		} }));
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const factory = new PiSdkSessionFactory({
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
		});
		const calls: Array<{ id: string; name: string; argumentsValue: unknown }> = [];
		const session = await factory.spawn({
			sessionId: "codex-child-host-tools",
			cwd: directory,
			agentDir,
			sessionDir,
			provider: model.provider,
			model: model.id,
			hostTools: [create(HostToolDefinitionSchema, {
				name: "host_echo",
				description: "Echo through the Codex host",
				inputSchemaJson: new TextEncoder().encode(JSON.stringify({
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
				})),
			})],
			onHostToolCall: async (id, name, argumentsValue) => {
				calls.push({ id, name, argumentsValue });
				return { content: [{ type: "text", text: "echoed hello" }], details: { hosted: true } };
			},
			onEvent: () => {},
		});
		cleanups.push(async () => session.close());

		expect(session.activeToolNames).toEqual(["host_echo"]);
		expect(session.activeToolNames).not.toEqual(expect.arrayContaining(["bash", "read", "edit", "write"]));
		await session.prompt("use host echo");
		expect(calls).toEqual([{ id: "call-1", name: "host_echo", argumentsValue: { text: "hello" } }]);
		expect(faux.state.callCount).toBe(2);
	});
});
