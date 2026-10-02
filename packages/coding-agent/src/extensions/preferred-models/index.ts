import type { Api, Model } from "@shuv1337/shuvpi-ai";
import { parseArgs } from "../../cli/args.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";

export const PREFERRED_MODELS: Readonly<Record<string, string>> = {
	anthropic: "claude-opus-5",
	"amazon-bedrock": "us.anthropic.claude-opus-5",
	baseten: "moonshotai/Kimi-K2.6",
	"cloudflare-ai-gateway": "moonshotai/kimi-k3",
	"google-antigravity": "gemini-3.8-flash-high",
};

export interface PreferredModelsOptions {
	preferences?: Readonly<Record<string, string>>;
	/** Optional explicit provider for a fresh session; omitted means command-only until --preferred-provider is supplied. */
	provider?: string;
	/** Embedders supply their own CLI selection context. */
	argv?: readonly string[];
}

export function selectPreferredModel(
	provider: string,
	available: readonly Model<Api>[],
	preferences: Readonly<Record<string, string>>,
	current?: Model<Api>,
): Model<Api> | undefined {
	const candidates = available.filter((model) => model.provider === provider);
	return (
		candidates.find((model) => model.id === preferences[provider]) ??
		candidates.find((model) => model.id === current?.id) ??
		candidates[0]
	);
}

/** Opt-in session selection; never changes the stored defaults or restored sessions. */
export function createPreferredModelsExtension(options: PreferredModelsOptions = {}): ExtensionFactory {
	const preferences = { ...PREFERRED_MODELS, ...options.preferences };
	return (pi) => {
		pi.registerFlag("preferred-provider", {
			type: "string",
			description: "Select the optional preferred model for a provider in a fresh session",
		});
		const select = async (provider: string, ctx: ExtensionContext) => {
			const available = ctx.modelRegistry.getAvailable();
			const allowed = ctx.scopedModels.length
				? available.filter((model) =>
						ctx.scopedModels.some(
							(scoped) => scoped.model.provider === model.provider && scoped.model.id === model.id,
						),
					)
				: available;
			const model = selectPreferredModel(provider, allowed, preferences, ctx.model);
			if (!model) {
				ctx.ui.notify(`No available model for ${provider}`, "warning");
				return;
			}
			if (!(await pi.setModel(model))) {
				ctx.ui.notify(`Authentication is unavailable for ${provider}`, "warning");
				return;
			}
			if (preferences[provider] && model.id !== preferences[provider])
				ctx.ui.notify(`Preferred model unavailable; using ${provider}/${model.id}`, "warning");
		};
		pi.registerCommand("preferred-model", {
			description: "Use a provider's preferred available model for this session",
			handler: async (args, ctx) => {
				const provider = args.trim() || ctx.model?.provider;
				if (!provider) {
					ctx.ui.notify("Usage: /preferred-model <provider>", "warning");
					return;
				}
				await select(provider, ctx);
			},
		});
		pi.on("session_start", async (event, ctx) => {
			if (event.reason !== "startup" || ctx.sessionManager.getEntries().some((entry) => entry.type === "message"))
				return;
			const args = parseArgs([...(options.argv ?? process.argv.slice(2))]);
			if (
				args.model ||
				args.models?.length ||
				args.continue ||
				args.resume ||
				args.session ||
				args.sessionId ||
				args.fork ||
				pi.getSettings().defaultModel ||
				ctx.scopedModels.length
			)
				return;
			const provider = pi.getFlag("preferred-provider") ?? options.provider;
			if (typeof provider === "string" && provider.trim()) await select(provider.trim(), ctx);
		});
	};
}

export default createPreferredModelsExtension();
