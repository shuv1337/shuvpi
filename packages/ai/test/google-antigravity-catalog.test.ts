import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildAntigravityModels,
	cleanSchema,
	DEFAULT_MODEL_ID,
	filterGoogleModels,
	loadCodeAssist,
	parseCatalogModels,
	wrapGenerateRequest,
} from "../src/api/google-antigravity-shared.ts";
import { googleAntigravityOAuth } from "../src/auth/oauth/google-antigravity.ts";
import { loadGoogleAntigravityOAuth } from "../src/auth/oauth/load.ts";
import { registerBunOAuthFlows } from "../src/bun-oauth.ts";
import type { ModelsPublication, RefreshModelsContext } from "../src/models.ts";
import { builtinProviders } from "../src/providers/all.ts";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.ts";
import type { Model } from "../src/types.ts";

afterEach(() => vi.unstubAllGlobals());

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
		...overrides,
	};
}

describe("Google Antigravity catalog", () => {
	it("loads OAuth through both the Node module loader and the Bun registration", async () => {
		expect(await loadGoogleAntigravityOAuth()).toBe(googleAntigravityOAuth);
		registerBunOAuthFlows();
		expect(await loadGoogleAntigravityOAuth()).toBe(googleAntigravityOAuth);
	});

	it("registers subscription-only Gemini 3.8 defaults with model-specific output caps", () => {
		const provider = builtinProviders().find((candidate) => candidate.id === "google-antigravity");
		expect(provider).toBeDefined();
		expect(provider?.auth.oauth?.isSubscription).toBe(true);
		expect(provider?.auth.apiKey).toBeUndefined();
		expect(provider?.getModels()[0].id).toBe(DEFAULT_MODEL_ID);
		const models = buildAntigravityModels("google-antigravity", [{ id: "gemini-4-pro" }]);
		expect(models.find((model) => model.id === "gemini-3.8-flash-high")?.maxTokens).toBe(65536);
		expect(models.find((model) => model.id === "gemini-3.1-pro-high")?.maxTokens).toBe(32768);
		expect(models.find((model) => model.id === "gemini-4-pro")?.maxTokens).toBe(32768);
	});

	it("accepts only noninternal Gemini text models from each discovery response shape", () => {
		const entries = [
			{ id: "gemini-new", displayName: "New Gemini", modelProvider: "MODEL_PROVIDER_GOOGLE" },
			{ id: "gemini-unknown-provider" },
			{ id: "claude-test" },
			{ id: "gpt-test" },
			{ id: "gemini-image" },
			{ id: "gemini-internal", isInternal: true },
			{ id: "gemini-foreign", modelProvider: "MODEL_PROVIDER_OTHER" },
			{ id: "mystery-model" },
			{ id: "tab_complete" },
		];
		for (const key of ["models", "availableModels", "model"]) {
			expect(filterGoogleModels(parseCatalogModels({ [key]: entries })).map((item) => item.id)).toEqual([
				"gemini-new",
				"gemini-unknown-provider",
			]);
		}
	});

	it("restores a safe stale catalog and retains it when discovery fails", async () => {
		const provider = googleAntigravityProvider();
		const base = provider.getModels()[0];
		const foreign: Model<"google-antigravity"> = { ...base, id: "claude-stale" };
		const unsafeEndpoint: Model<"google-antigravity"> = {
			...base,
			id: "gemini-cached",
			name: "Cached",
			baseUrl: "https://untrusted.invalid",
			headers: { Authorization: "old-token" },
		};
		const fetch = vi.fn(async () => {
			throw new Error("offline");
		});
		vi.stubGlobal("fetch", fetch);
		const publications: ModelsPublication[] = [];
		await provider.refreshModels?.(
			refreshContext({
				allowNetwork: true,
				credential: {
					type: "oauth",
					access: "fake",
					refresh: "fake-refresh",
					expires: Date.now() + 60000,
					projectId: "project",
				},
				stored: { models: [foreign, unsafeEndpoint], checkedAt: 1 },
				publish: async (publication) => {
					publications.push(publication);
					publication.update?.();
					return true;
				},
			}),
		);
		expect(fetch).toHaveBeenCalledOnce();
		expect(provider.getModels().some((model) => model.id === "claude-stale")).toBe(false);
		expect(provider.getModels().find((model) => model.id === "gemini-cached")).toMatchObject({
			name: "Cached",
			baseUrl: base.baseUrl,
		});
		expect(provider.getModels().find((model) => model.id === "gemini-cached")?.headers).toBeUndefined();
		expect(publications).toHaveLength(1);
		expect(publications[0].persist).toBeUndefined();
	});

	it("publishes and persists only Google discovery results", async () => {
		const provider = googleAntigravityProvider();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ models: [{ id: "gemini-new", displayName: "Discovered Gemini" }, { id: "claude-other" }] }),
			),
		);
		const publications: ModelsPublication[] = [];
		await provider.refreshModels?.(
			refreshContext({
				allowNetwork: true,
				credential: {
					type: "oauth",
					access: "fake",
					refresh: "refresh",
					expires: Date.now() + 60000,
					projectId: "project",
				},
				publish: async (publication) => {
					publications.push(publication);
					publication.update?.();
					return true;
				},
			}),
		);
		expect(provider.getModels().some((model) => model.id === "gemini-new")).toBe(true);
		expect(provider.getModels().some((model) => model.id === "claude-other")).toBe(false);
		expect(publications[0].persist?.models).toEqual(provider.getModels());
	});

	it("honors offline, aborted, and rejected publication fences", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const provider = googleAntigravityProvider();
		const original = provider.getModels();
		await provider.refreshModels?.(refreshContext());
		await provider.refreshModels?.(refreshContext({ allowNetwork: true, signal: AbortSignal.abort() }));
		await provider.refreshModels?.(
			refreshContext({
				allowNetwork: true,
				stored: { models: [{ ...original[0], id: "gemini-stale" }], checkedAt: 1 },
				publish: async () => false,
			}),
		);
		expect(provider.getModels()).toBe(original);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("maps project/tier discovery and preserves request aliases and schema cleaning", async () => {
		expect(
			await loadCodeAssist("fake", undefined, async () =>
				Response.json({ cloudaicompanionProject: { id: "project" }, paidTier: { name: "pro" } }),
			),
		).toEqual({ projectId: "project", paidTier: "pro" });
		expect(
			cleanSchema({ type: "object", $schema: "draft", properties: { value: { const: "x", default: "x" } } }),
		).toEqual({ type: "object", properties: { value: { enum: ["x"] } } });
		expect(
			wrapGenerateRequest({
				body: {},
				projectId: "project",
				model: "gemini-3.1-pro-high",
				sessionID: "session",
				now: 1,
				trajectory: "trace",
			}),
		).toMatchObject({ project: "project", model: "gemini-pro-agent", requestId: "agent/session/1/trace/2" });
	});
});
