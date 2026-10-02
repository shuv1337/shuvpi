import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@shuv1337/shuvpi-ai";
import { streamSimple as streamResponses } from "@shuv1337/shuvpi-ai/api/openai-responses";
import { describe, expect, it } from "vitest";
import priorityModel from "../examples/extensions/priority-model.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createHarness } from "./suite/harness.ts";

describe("selected native model replacements", () => {
	it("keeps provider registration, replacement and removal local to each runtime", async () => {
		const [first, second] = await Promise.all(
			Array.from({ length: 2 }, () =>
				ModelRuntime.create({
					credentials: AuthStorage.inMemory(),
					modelsStore: new InMemoryModelsStore(),
					modelsPath: null,
					allowModelNetwork: false,
				}),
			),
		);
		const left = fauxProvider({ provider: "runtime-local", models: [{ id: "left" }] });
		const right = fauxProvider({ provider: "runtime-local", models: [{ id: "right" }] });
		first.registerNativeProvider(left.provider);
		second.registerNativeProvider(right.provider);
		await Promise.all([first.refresh({ allowNetwork: false }), second.refresh({ allowNetwork: false })]);
		expect(first.getModels("runtime-local").map((model) => model.id)).toEqual(["left"]);
		expect(second.getModels("runtime-local").map((model) => model.id)).toEqual(["right"]);
		expect(first.getProviders().filter((provider) => provider.id === "runtime-local")).toHaveLength(1);
		expect(second.getProviders().filter((provider) => provider.id === "runtime-local")).toHaveLength(1);

		const replacement = fauxProvider({ provider: "runtime-local", models: [{ id: "replacement" }] });
		first.registerNativeProvider(replacement.provider);
		await first.refresh({ allowNetwork: false });
		expect(first.getModels("runtime-local").map((model) => model.id)).toEqual(["replacement"]);
		expect(second.getModels("runtime-local").map((model) => model.id)).toEqual(["right"]);
		replacement.setResponses([fauxAssistantMessage("first runtime")]);
		right.setResponses([fauxAssistantMessage("second runtime")]);
		const context = { messages: [{ role: "user" as const, content: "fixture", timestamp: 0 }] };
		const responses = await Promise.all([
			first.completeSimple(first.getModel("runtime-local", "replacement")!, context),
			second.completeSimple(second.getModel("runtime-local", "right")!, context),
		]);
		expect(responses.map((response) => response.model)).toEqual(["replacement", "right"]);
		expect([replacement.state.callCount, right.state.callCount, left.state.callCount]).toEqual([1, 1, 0]);
		first.unregisterProvider("runtime-local");
		await first.refresh({ allowNetwork: false });
		expect(first.getProvider("runtime-local")).toBeUndefined();
		expect(second.getModels("runtime-local").map((model) => model.id)).toEqual(["right"]);
	});

	it("keeps a virtual fast selection while sending the physical wire ID and priority tier", async () => {
		const harness = await createHarness({ extensionFactories: [priorityModel], tools: [] });
		try {
			const runtime = harness.session.modelRuntime;
			await runtime.setRuntimeApiKey("openai", "local-fixture-key");
			const selected = runtime.getModel("openai", "gpt-5.5-fast")!;
			const physical = runtime.getModel("openai", "gpt-5.5")!;
			expect(selected).toMatchObject({ id: "gpt-5.5-fast", name: "GPT-5.5 Fast", api: "pi-virtual" });
			const requests: Record<string, unknown>[] = [];
			const fetch: typeof globalThis.fetch = async (_url, init) => {
				expect(typeof init?.body).toBe("string");
				requests.push(JSON.parse(String(init!.body)));
				return new Response(
					`event: response.completed\ndata: ${JSON.stringify({
						type: "response.completed",
						response: { id: "fixture", object: "response", status: "completed", output: [] },
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			};
			harness.session.agent.streamFunction = (model, context, options) => {
				expect(model.api).toBe("openai-responses");
				return streamResponses({ ...model, api: "openai-responses" }, context, { ...options, fetch });
			};
			await harness.session.setModel(selected);
			await harness.session.prompt("priority fixture");
			expect(harness.session.model).toMatchObject({ id: "gpt-5.5-fast", name: "GPT-5.5 Fast" });
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				model: "gpt-5.5",
				stopReason: "stop",
			});
			await harness.session.setModel(physical);
			await harness.session.prompt("ordinary fixture");
			expect(requests).toHaveLength(2);
			expect(requests[0]).toMatchObject({ model: "gpt-5.5", service_tier: "priority" });
			expect(requests[1]).toMatchObject({ model: "gpt-5.5" });
			expect(requests[1].service_tier).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
