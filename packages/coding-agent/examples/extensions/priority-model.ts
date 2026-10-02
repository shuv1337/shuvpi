/**
 * Optional GPT-5.5 priority variant using upstream virtual-model APIs.
 * Load with: shuvpi -e ./priority-model.ts --provider openai --model gpt-5.5-fast
 * The selected name stays virtual; requests use gpt-5.5 with priority service.
 */
import type { ExtensionAPI } from "@shuv1337/shuvpi-coding-agent";

export default function priorityModel(pi: ExtensionAPI): void {
	pi.registerVirtualModel({
		provider: "openai",
		id: "gpt-5.5-fast",
		name: "GPT-5.5 Fast",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
		route(request, ctx) {
			const model = ctx.modelRegistry.find("openai", "gpt-5.5");
			if (!model) throw new Error("OpenAI GPT-5.5 is not in the model catalog");
			return { model, thinkingLevel: request.thinkingLevel };
		},
	});
	pi.on("before_provider_request", ({ payload }, ctx) => {
		if (ctx.model?.provider !== "openai" || ctx.model.id !== "gpt-5.5-fast") return;
		if (payload && typeof payload === "object" && "model" in payload && payload.model === "gpt-5.5") {
			return { ...payload, service_tier: "priority" };
		}
	});
}
