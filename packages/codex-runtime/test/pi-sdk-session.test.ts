import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@shuv1337/shuvpi-ai/compat";
import { initTheme, ModelRuntime, SessionManager } from "@shuv1337/shuvpi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HostToolDefinitionSchema, type SessionEvent } from "../src/gen/pi_codex_runtime_pb.ts";
import { PiSdkSessionFactory } from "../src/sdk/pi-sdk-session.ts";

describe("PiSdkSessionFactory", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => initTheme("dark"));

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
		const modelRuntime = await ModelRuntime.create({
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const factory = new PiSdkSessionFactory({ modelRuntime });
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
		expect(firstEvents.map((event) => event.sequence)).toEqual(firstEvents.map((_event, index) => BigInt(index)));
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
			fauxAssistantMessage(fauxToolCall("host_echo", { text: "hello" }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("host tool completed"),
		]);
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
		const modelRuntime = await ModelRuntime.create({
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const factory = new PiSdkSessionFactory({ modelRuntime });
		const calls: Array<{ id: string; name: string; argumentsValue: unknown }> = [];
		const session = await factory.spawn({
			sessionId: "codex-child-host-tools",
			cwd: directory,
			agentDir,
			sessionDir,
			provider: model.provider,
			model: model.id,
			hostTools: [
				create(HostToolDefinitionSchema, {
					name: "host_echo",
					description: "Echo through the Codex host",
					inputSchemaJson: new TextEncoder().encode(
						JSON.stringify({
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						}),
					),
				}),
			],
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

	it("durably migrates legacy xai-oauth Grok sessions without falling back", async () => {
		const directory = join(tmpdir(), `pi-codex-xai-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(directory, "agent");
		const sessionDir = join(directory, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(_context, _options, _state, model) => ({
				...fauxAssistantMessage("resumed through canonical xai"),
				api: model.api,
				provider: model.provider,
				model: model.id,
			}),
		]);
		const fauxModel = faux.getModel();
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					xai: {
						baseUrl: fauxModel.baseUrl,
						api: fauxModel.api,
						apiKey: "faux-key",
						models: [
							{
								id: "grok-4.5",
								name: "Grok 4.5",
								reasoning: true,
								input: fauxModel.input,
								cost: fauxModel.cost,
								contextWindow: fauxModel.contextWindow,
								maxTokens: fauxModel.maxTokens,
							},
						],
					},
				},
			}),
		);

		const legacyManager = SessionManager.create(directory, sessionDir);
		legacyManager.appendModelChange("xai-oauth", "grok-4.5");
		legacyManager.appendThinkingLevelChange("high");
		legacyManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "legacy prompt" }],
			timestamp: Date.now(),
		});
		legacyManager.appendMessage({
			...fauxAssistantMessage("legacy reply"),
			provider: "xai-oauth",
			model: "grok-4.5",
		});
		const sessionLocator = legacyManager.getSessionFile();
		expect(sessionLocator).toBeDefined();
		expect(existsSync(sessionLocator as string)).toBe(true);

		const modelRuntime = await ModelRuntime.create({
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const factory = new PiSdkSessionFactory({ modelRuntime });
		const resumed = await factory.resume({
			sessionId: "codex-child-xai-migrated",
			sessionLocator: sessionLocator as string,
			cwdOverride: directory,
			agentDir,
			onEvent: () => {},
		});
		cleanups.push(async () => resumed.close());

		expect(resumed.provider).toBe("xai");
		expect(resumed.model).toBe("grok-4.5");
		const migratedBranch = SessionManager.open(sessionLocator as string).getBranch();
		const canonicalChanges = migratedBranch.filter(
			(entry) => entry.type === "model_change" && entry.provider === "xai" && entry.modelId === "grok-4.5",
		);
		expect(canonicalChanges).toHaveLength(1);
		expect(canonicalChanges[0]?.parentId).toBe(migratedBranch.at(-2)?.id);

		await resumed.close();

		const resumedAgain = await factory.resume({
			sessionId: "codex-child-xai-migrated-again",
			sessionLocator: sessionLocator as string,
			cwdOverride: directory,
			agentDir,
			onEvent: () => {},
		});
		cleanups.push(async () => resumedAgain.close());
		expect(resumedAgain.provider).toBe("xai");
		expect(resumedAgain.model).toBe("grok-4.5");
		const canonicalChangesAfterSecondResume = SessionManager.open(sessionLocator as string)
			.getBranch()
			.filter((entry) => entry.type === "model_change" && entry.provider === "xai" && entry.modelId === "grok-4.5");
		expect(canonicalChangesAfterSecondResume).toHaveLength(1);
		await resumedAgain.prompt("continue the legacy session");
		expect(faux.state.callCount).toBe(1);
	});

	it("rejects legacy xai-oauth migration without canonical xai auth and preserves history", async () => {
		const directory = join(tmpdir(), `pi-codex-xai-no-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(directory, "agent");
		const sessionDir = join(directory, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const fauxModel = faux.getModel();
		writeFileSync(join(agentDir, "auth.json"), "{}");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					xai: {
						baseUrl: fauxModel.baseUrl,
						api: fauxModel.api,
						apiKey: "faux-key",
						models: [
							{
								id: "grok-4.5",
								name: "Grok 4.5",
								reasoning: true,
								input: fauxModel.input,
								cost: fauxModel.cost,
								contextWindow: fauxModel.contextWindow,
								maxTokens: fauxModel.maxTokens,
							},
						],
					},
				},
			}),
		);

		const legacyManager = SessionManager.create(directory, sessionDir);
		legacyManager.appendModelChange("xai-oauth", "grok-4.5");
		legacyManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "legacy prompt" }],
			timestamp: Date.now(),
		});
		legacyManager.appendMessage({
			...fauxAssistantMessage("legacy reply"),
			provider: "xai-oauth",
			model: "grok-4.5",
		});
		const sessionLocator = legacyManager.getSessionFile();
		expect(sessionLocator).toBeDefined();

		const modelRuntime = await ModelRuntime.create({
			modelsPath: join(agentDir, "models.json"),
			authPath: join(agentDir, "auth.json"),
			allowModelNetwork: false,
		});
		vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		const factory = new PiSdkSessionFactory({ modelRuntime });
		await expect(
			factory.resume({
				sessionId: "codex-child-xai-no-auth",
				sessionLocator: sessionLocator as string,
				cwdOverride: directory,
				agentDir,
				onEvent: () => {},
			}),
		).rejects.toThrow("Pi legacy session model migration requires configured auth: xai/grok-4.5");

		const canonicalChanges = SessionManager.open(sessionLocator as string)
			.getBranch()
			.filter((entry) => entry.type === "model_change" && entry.provider === "xai" && entry.modelId === "grok-4.5");
		expect(canonicalChanges).toHaveLength(0);
	});
});
