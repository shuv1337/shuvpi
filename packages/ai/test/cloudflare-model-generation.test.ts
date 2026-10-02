import { beforeAll, describe, expect, it } from "vitest";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../src/api/cloudflare.ts";
import { createModels } from "../src/models.ts";
import { cloudflareAIGatewayProvider } from "../src/providers/cloudflare-ai-gateway.ts";
import type { Api, Model } from "../src/types.ts";
import { generateModelCatalog } from "./model-generation-support.ts";

const metadata = {
	tool_call: true,
	reasoning: true,
	modalities: { input: ["text", "image"] },
	limit: { context: 262144, output: 32768 },
	cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
};
let providers: Record<string, Record<string, Model<Api>>>;

beforeAll(() => {
	({ providers } = generateModelCatalog({
		"cloudflare-ai-gateway": {
			models: {
				"openai/gpt-5.5": metadata,
				"anthropic/claude-opus-5": metadata,
				"workers-ai/@cf/moonshotai/kimi-k2.6": { ...metadata, name: "Gateway Kimi" },
				"moonshotai/kimi-k3": metadata,
				"unselected-vendor/new-model": metadata,
				"moonshotai/no-tools": { ...metadata, tool_call: false },
			},
		},
		"cloudflare-workers-ai": {
			models: {
				"@cf/moonshotai/kimi-k2.6": { ...metadata, name: "Direct Kimi" },
				"@cf/test/mirrored": metadata,
			},
		},
	}));
});

describe("selected Cloudflare catalog routes", () => {
	it("ships all four selected routes through the actual provider and runtime model lookup", () => {
		const models = createModels();
		models.setProvider(cloudflareAIGatewayProvider());
		for (const id of ["gpt-5.5", "claude-opus-5", "workers-ai/@cf/moonshotai/kimi-k2.6", "moonshotai/kimi-k3"]) {
			const generated = providers["cloudflare-ai-gateway"][id];
			const shipped = models.getModel("cloudflare-ai-gateway", id);
			expect(shipped).toMatchObject({ id, api: generated.api, baseUrl: generated.baseUrl });
			if (generated.api === "openai-responses") {
				expect(shipped?.compat ?? {}).not.toHaveProperty("sendSessionAffinityHeaders", true);
			} else {
				expect(shipped?.compat).toMatchObject({ sendSessionAffinityHeaders: true });
			}
		}
	});

	// AI-06 comparison with frozen fork 69da6d8c: preserve these four selected route families.
	it.each([
		["gpt-5.5", "openai-responses", CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL, false],
		["claude-opus-5", "anthropic-messages", CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL, true],
		["workers-ai/@cf/moonshotai/kimi-k2.6", "openai-completions", CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL, true],
		["moonshotai/kimi-k3", "openai-completions", CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL, true],
	] as const)("generates %s with its selected transport and affinity", (id, api, baseUrl, affinity) => {
		const model = providers["cloudflare-ai-gateway"][id];
		expect(model).toMatchObject({
			id,
			api,
			baseUrl,
			provider: "cloudflare-ai-gateway",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262144,
			maxTokens: 32768,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		});
		if (affinity) {
			expect(model.compat).toMatchObject({ sendSessionAffinityHeaders: true });
		} else {
			expect(model.compat ?? {}).not.toHaveProperty("sendSessionAffinityHeaders", true);
		}
	});

	it("retains direct Workers AI, mirrors missing gateway entries, and preserves explicit gateway metadata", () => {
		expect(providers["cloudflare-workers-ai"]["@cf/moonshotai/kimi-k2.6"]).toMatchObject({
			id: "@cf/moonshotai/kimi-k2.6",
			api: "openai-completions",
			baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
			name: "Direct Kimi",
			compat: { sendSessionAffinityHeaders: true },
		});
		expect(providers["cloudflare-ai-gateway"]["workers-ai/@cf/moonshotai/kimi-k2.6"].name).toBe("Gateway Kimi");
		expect(providers["cloudflare-ai-gateway"]["workers-ai/@cf/test/mirrored"]).toMatchObject({
			api: "openai-completions",
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			compat: { sendSessionAffinityHeaders: true },
		});
	});

	it("does not expand the selection to unrelated upstreams or models without tools", () => {
		expect(providers["cloudflare-ai-gateway"]).not.toHaveProperty("unselected-vendor/new-model");
		expect(providers["cloudflare-ai-gateway"]).not.toHaveProperty("moonshotai/no-tools");
	});
});
