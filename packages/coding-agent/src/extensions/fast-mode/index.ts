import type { Api, Model } from "@shuv1337/shuvpi-ai";
import type { KeyId } from "@shuv1337/shuvpi-tui";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";

export interface FastModeOptions {
	/** Explicit provider/model IDs approved by the user. No model is eligible by default. */
	models?: readonly string[];
	/** Optional user-selected shortcut; no global key is hardcoded by this extension. */
	shortcut?: KeyId;
}

export function supportsFastMode(model: Model<Api> | undefined, allowed: ReadonlySet<string>): boolean {
	return (
		!!model &&
		(model.provider === "openai" || model.provider === "openai-codex") &&
		(model.api === "openai-responses" || model.api === "openai-codex-responses") &&
		allowed.has(`${model.provider}/${model.id}`)
	);
}

/** Session-only priority preference; the provider remains authoritative for usage and cost. */
export function createFastModeExtension(options: FastModeOptions = {}): ExtensionFactory {
	return (pi) => {
		let enabled = false;
		pi.registerFlag("fast-models", {
			type: "string",
			description: "Comma-separated provider/model IDs eligible for /fast priority mode",
		});
		const allowed = () => {
			const flag = pi.getFlag("fast-models");
			return new Set(
				typeof flag === "string"
					? flag
							.split(",")
							.map((value) => value.trim())
							.filter(Boolean)
					: (options.models ?? []),
			);
		};
		const status = (ctx: ExtensionContext) => {
			const supported = supportsFastMode(ctx.model, allowed());
			ctx.ui.setStatus(
				"fast-mode",
				enabled ? (supported ? "fast: priority" : "fast: paused (model unavailable)") : undefined,
			);
			return enabled
				? supported
					? "Fast mode on (priority pricing)"
					: "Fast mode paused for this model"
				: "Fast mode off";
		};
		const enable = (next: boolean, ctx: ExtensionContext) => {
			if (next && !supportsFastMode(ctx.model, allowed())) {
				ctx.ui.notify(
					"This model is not configured for priority mode; set --fast-models provider/model",
					"warning",
				);
				return;
			}
			enabled = next;
			ctx.ui.notify(status(ctx), "info");
		};
		pi.registerCommand("fast", {
			description: "Toggle session-only priority mode: /fast [on|off|status]",
			handler: async (args, ctx) => {
				const action = args.trim();
				if (!["", "on", "off", "status"].includes(action)) {
					ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
					return;
				}
				if (action !== "status") {
					const next = action === "off" ? false : action === "on" ? true : !enabled;
					enable(next, ctx);
					return;
				}
				ctx.ui.notify(status(ctx), "info");
			},
		});
		if (options.shortcut)
			pi.registerShortcut(options.shortcut, {
				description: "Toggle fast priority mode",
				handler: (ctx) => enable(!enabled, ctx),
			});
		pi.on("session_start", (_event, ctx) => {
			enabled = false;
			status(ctx);
		});
		pi.on("model_select", (event, ctx) => {
			status({ ...ctx, model: event.model });
		});
		pi.on("before_provider_request", (event, ctx) => {
			if (
				!enabled ||
				!supportsFastMode(ctx.model, allowed()) ||
				event.payload === null ||
				typeof event.payload !== "object" ||
				Array.isArray(event.payload)
			)
				return;
			const payload = event.payload as Record<string, unknown>;
			// A preceding hook may have selected a different model; it needs its own explicit eligibility.
			if (payload.model !== undefined && payload.model !== ctx.model?.id) return;
			return { ...payload, service_tier: "priority" };
		});
	};
}

export default createFastModeExtension();
