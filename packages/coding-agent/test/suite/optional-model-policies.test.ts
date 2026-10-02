import { type Api, fauxProvider, type Model, normalizeContext } from "@shuv1337/shuvpi-ai";
import { stream } from "@shuv1337/shuvpi-ai/api/openai-responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createFastModeExtension, supportsFastMode } from "../../src/extensions/fast-mode/index.ts";
import {
	createPreferredModelsExtension,
	PREFERRED_MODELS,
	selectPreferredModel,
} from "../../src/extensions/preferred-models/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function harness(extensions: ExtensionFactory[], settings = {}) {
	const value = await createHarness({
		models: [{ id: "base" }, { id: "preferred" }],
		extensionFactories: extensions,
		settings,
	});
	harnesses.push(value);
	return value;
}

describe("optional preferred models", () => {
	it.each(Object.entries(PREFERRED_MODELS))(
		"starts %s with its preferred model and a real registry fallback",
		async (provider, id) => {
			for (const available of [["fallback", id], ["fallback"]]) {
				const faux = fauxProvider({
					provider,
					api: `preferred-fixture-${provider}`,
					models: available.map((modelId) => ({ id: modelId })),
				});
				const setup = await harness([
					(pi) => {
						pi.registerProvider(provider, {
							api: faux.api,
							apiKey: "fixture-key",
							baseUrl: faux.getModel().baseUrl,
							models: faux.models,
							streamSimple: faux.provider.streamSimple,
						});
					},
					createPreferredModelsExtension({ provider, argv: [] }),
				]);
				await setup.session.bindExtensions({ shutdownHandler: () => {} });
				expect(setup.session.model?.provider).toBe(provider);
				expect(setup.session.model?.id).toBe(available.includes(id) ? id : "fallback");
				expect(setup.settingsManager.getDefaultModel()).toBeUndefined();
			}
		},
	);
	it.each(Object.entries(PREFERRED_MODELS))(
		"selects %s preference and falls back within that provider",
		async (provider, id) => {
			const setup = await harness([]);
			const base = { ...setup.getModel(), provider, id: "fallback" };
			const preferred = { ...base, id };
			expect(selectPreferredModel(provider, [base, preferred], PREFERRED_MODELS)).toBe(preferred);
			expect(selectPreferredModel(provider, [base], PREFERRED_MODELS)).toBe(base);
			expect(selectPreferredModel(provider, [{ ...base, provider: "other" }], PREFERRED_MODELS)).toBeUndefined();
		},
	);
	it("does nothing by default and applies only an explicitly enabled fresh-session provider", async () => {
		const disabled = await harness([createPreferredModelsExtension({ argv: [] })]);
		await disabled.session.bindExtensions({ shutdownHandler: () => {} });
		expect(disabled.session.model?.id).toBe("base");
		const enabled = await harness([
			createPreferredModelsExtension({ provider: "faux", preferences: { faux: "preferred" }, argv: [] }),
		]);
		await enabled.session.bindExtensions({ shutdownHandler: () => {} });
		expect(enabled.session.model?.id).toBe("preferred");
		expect(enabled.settingsManager.getDefaultModel()).toBeUndefined();
		expect(enabled.settingsManager.getDefaultProvider()).toBeUndefined();
	});
	it.each([
		["--model", "base"],
		["--models", "base,preferred"],
		["--continue"],
		["--resume"],
		["--session", "old"],
		["--fork", "old"],
	])("preserves explicit CLI selection %j", async (...argv) => {
		const setup = await harness([
			createPreferredModelsExtension({ provider: "faux", preferences: { faux: "preferred" }, argv }),
		]);
		await setup.session.bindExtensions({ shutdownHandler: () => {} });
		expect(setup.session.model?.id).toBe("base");
	});
	it("preserves saved defaults and resumed history; command selection stays session-only", async () => {
		const setup = await harness(
			[createPreferredModelsExtension({ provider: "faux", preferences: { faux: "preferred" }, argv: [] })],
			{ defaultProvider: "faux", defaultModel: "base" },
		);
		await setup.session.bindExtensions({ shutdownHandler: () => {} });
		expect(setup.session.model?.id).toBe("base");
		await setup.session.extensionRunner.runCommand("preferred-model", "faux");
		expect(setup.session.model?.id).toBe("preferred");
		expect(setup.settingsManager.getDefaultModel()).toBe("base");
		await setup.session.setModel(setup.getModel("base")!);
		await setup.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect(setup.session.model?.id).toBe("base");
	});
	it("does not select unauthenticated, missing, or out-of-scope preferences", async () => {
		const setup = await harness([createPreferredModelsExtension({ preferences: { faux: "preferred" }, argv: [] })]);
		setup.session.setScopedModels([{ model: setup.getModel("base")!, thinkingLevel: "off" }]);
		await setup.session.extensionRunner.runCommand("preferred-model", "faux");
		expect(setup.session.model?.id).toBe("base");
		await setup.session.extensionRunner.runCommand("preferred-model", "missing-provider");
		expect(setup.session.model?.id).toBe("base");
	});
});

describe("optional in-memory fast mode", () => {
	const modelId = "openai/gpt-5.5";
	async function fast(extraBefore: ExtensionFactory[] = [], extraAfter: ExtensionFactory[] = []) {
		const setup = await harness([
			...extraBefore,
			createFastModeExtension({ models: [modelId, "openai-codex/gpt-5.5"] }),
			...extraAfter,
		]);
		const model: Model<"openai-responses"> = {
			...setup.getModel(),
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: "https://api.invalid/v1",
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
		};
		setup.session.agent.state.model = model;
		const status = vi.fn();
		const notify = vi.fn();
		setup.session.extensionRunner.setUIContext(createTestUiContext({ setStatus: status, notify }), "tui");
		return { ...setup, model, status, notify };
	}
	it("toggles requests, updates the footer, suspends on unsupported models, and never saves the toggle", async () => {
		const setup = await fast();
		const payload = { model: "gpt-5.5", input: [] };
		expect(await setup.session.extensionRunner.emitBeforeProviderRequest(payload)).toBe(payload);
		await setup.session.extensionRunner.runCommand("fast", "on");
		expect(await setup.session.extensionRunner.emitBeforeProviderRequest(payload)).toEqual({
			...payload,
			service_tier: "priority",
		});
		expect(setup.status).toHaveBeenLastCalledWith("fast-mode", "fast: priority");
		setup.session.agent.state.model = setup.getModel();
		await setup.session.extensionRunner.emit({
			type: "model_select",
			model: setup.getModel(),
			previousModel: setup.model,
			source: "set",
		});
		expect(await setup.session.extensionRunner.emitBeforeProviderRequest(payload)).toBe(payload);
		expect(setup.status).toHaveBeenLastCalledWith("fast-mode", "fast: paused (model unavailable)");
		setup.session.agent.state.model = setup.model;
		await setup.session.extensionRunner.runCommand("fast", "off");
		expect(await setup.session.extensionRunner.emitBeforeProviderRequest(payload)).toBe(payload);
		await setup.session.extensionRunner.runCommand("fast", "on");
		await setup.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect(await setup.session.extensionRunner.emitBeforeProviderRequest(payload)).toBe(payload);
		expect(setup.sessionManager.getEntries()).toEqual([]);
		expect(setup.settingsManager.getDefaultModel()).toBeUndefined();
	});
	it("requires an explicit model allowlist and rejects unsupported providers or APIs", async () => {
		const setup = await fast();
		for (const model of [
			{ ...setup.model, provider: "azure" },
			{ ...setup.model, api: "openai-completions" },
			{ ...setup.model, id: "unknown" },
		] as Model<Api>[])
			expect(supportsFastMode(model, new Set([modelId]))).toBe(false);
		expect(
			supportsFastMode(
				{ ...setup.model, provider: "openai-codex", api: "openai-codex-responses" },
				new Set(["openai-codex/gpt-5.5"]),
			),
		).toBe(true);
		const empty = await harness([createFastModeExtension()]);
		empty.session.agent.state.model = setup.model;
		const payload = { model: "gpt-5.5" };
		await empty.session.extensionRunner.runCommand("fast", "on");
		expect(await empty.session.extensionRunner.emitBeforeProviderRequest(payload)).toBe(payload);
	});
	it("follows extension order and preserves unrelated payload fields or a prior model rewrite", async () => {
		const setup = await fast(
			[
				(pi) => {
					pi.on("before_provider_request", (event) => ({
						...(event.payload as object),
						marker: "before",
						service_tier: "flex",
					}));
				},
			],
			[
				(pi) => {
					pi.on("before_provider_request", (event) => ({ ...(event.payload as object), marker: "after" }));
				},
			],
		);
		await setup.session.extensionRunner.runCommand("fast", "on");
		expect(await setup.session.extensionRunner.emitBeforeProviderRequest({ model: "gpt-5.5" })).toEqual({
			model: "gpt-5.5",
			marker: "after",
			service_tier: "priority",
		});
		expect(await setup.session.extensionRunner.emitBeforeProviderRequest({ model: "other" })).toEqual({
			model: "other",
			marker: "after",
			service_tier: "flex",
		});
		const last = await fast(
			[],
			[
				(pi) => {
					pi.on("before_provider_request", (event) => ({ ...(event.payload as object), service_tier: "default" }));
				},
			],
		);
		await last.session.extensionRunner.runCommand("fast", "on");
		expect(await last.session.extensionRunner.emitBeforeProviderRequest({ model: "gpt-5.5" })).toEqual({
			model: "gpt-5.5",
			service_tier: "default",
		});
	});
	it.each(["priority", undefined])(
		"captures priority requests and uses response or final-payload tier pricing: %s",
		async (responseTier) => {
			const setup = await fast();
			await setup.session.extensionRunner.runCommand("fast", "on");
			const requests: unknown[] = [];
			const result = await stream(
				setup.model,
				normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
				{
					apiKey: "fixture-key",
					maxRetries: 0,
					onPayload: (payload) => setup.session.extensionRunner.emitBeforeProviderRequest(payload),
					fetch: async (_input, init) => {
						requests.push(JSON.parse(String(init?.body)));
						return new Response(
							`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", service_tier: responseTier, output: [], usage: { input_tokens: 1000000, output_tokens: 1000000, total_tokens: 2000000 } } })}\n\n`,
							{ status: 200, headers: { "Content-Type": "text/event-stream" } },
						);
					},
				},
			).result();
			expect(requests).toEqual([expect.objectContaining({ model: "gpt-5.5", service_tier: "priority" })]);
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.usage.cost).toMatchObject({ input: 2.5, output: 5, total: 7.5 });
		},
	);
});
