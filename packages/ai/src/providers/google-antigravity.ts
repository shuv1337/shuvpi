import { googleAntigravityApi } from "../api/google-antigravity.lazy.ts";
import { buildAntigravityModels, type CatalogModel, fetchAvailableModels } from "../api/google-antigravity-shared.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadGoogleAntigravityOAuth } from "../auth/oauth/load.ts";
import type { Provider } from "../models.ts";
import type { Model } from "../types.ts";

const PROVIDER_ID = "google-antigravity";

/**
 * Google AI Pro / Antigravity: Gemini through the Cloud Code Assist
 * `v1internal` endpoint, authorized by a Google AI Pro subscription rather
 * than a Gemini API key.
 *
 * Subscription-only by design. There is no api-key path because Cloud Code
 * does not accept one, and the catalog exposes Google models exclusively —
 * the Claude and GPT models Cloud Code also serves draw from a separate quota
 * bucket and are what got comparable projects banned.
 *
 * The catalog ships with the known model ids so the provider is usable before
 * the first refresh, then merges whatever `fetchAvailableModels` reports.
 */
export function googleAntigravityProvider(): Provider<"google-antigravity"> {
	let models = buildAntigravityModels(PROVIDER_ID);
	const streams = googleAntigravityApi();

	return {
		id: PROVIDER_ID,
		name: "Google AI Pro",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		auth: {
			oauth: lazyOAuth({
				name: "Google AI Pro / Antigravity",
				isSubscription: true,
				loginLabel: "Sign in with Google AI Pro / Antigravity",
				load: loadGoogleAntigravityOAuth,
			}),
		},
		getModels: () => models,
		refreshModels: async (context) => {
			const stored = context.stored;
			if (stored) {
				const restored = stored.models.filter(
					(model) => model.provider === PROVIDER_ID,
				) as Model<"google-antigravity">[];
				if (
					restored.length > 0 &&
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted) return;
			if (context.credential?.type !== "oauth") return;
			const projectId = context.credential.projectId;
			if (typeof projectId !== "string" || projectId.length === 0) return;

			let discovered: CatalogModel[];
			try {
				discovered = await fetchAvailableModels(context.credential.access, projectId, context.signal);
			} catch {
				// A stale catalog beats losing every model when Cloud Code is unreachable.
				return;
			}
			if (context.signal.aborted) return;

			const refreshed = buildAntigravityModels(PROVIDER_ID, discovered);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => streams.stream(model, context, options),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
	};
}
