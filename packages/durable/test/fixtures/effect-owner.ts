import { appendFile, writeFile } from "node:fs/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@shuv1337/shuvpi-ai";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import { createRegistry, defineTool, Harness, ToolTask } from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const [path, effectPath, mode] = process.argv.slice(2);
if (path === undefined || effectPath === undefined) throw new Error("Missing fixture paths");
const context = BACKGROUND_CONTEXT;
const registry = createRegistry();
registry.install({
	name: "effects",
	tools: [
		defineTool({
			name: "mutate",
			description: "counted external effect",
			parameters: Type.Object({}),
			compatibility: "v1",
			replay: mode === "generation-safe" ? "safe" : "unsafe",
			execute: async () => {
				if (mode === "generation-safe") await writeFile(effectPath, "effect\n");
				else await appendFile(effectPath, "effect\n");
				if (mode === "interrupt" || mode?.startsWith("generation-")) {
					process.send?.({ state: "effect" });
					await new Promise<void>(() => {});
				}
				return { structuredContent: { ok: true } };
			},
		}),
	],
});
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("mutate", {}, { id: "generation-call" })], { stopReason: "toolUse" }),
]);
const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
const root = await harness.root(context);
if (mode?.startsWith("generation-")) {
	await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
	await (await root.submit({ type: "input", content: "mutate" }, context)).wait(context);
} else {
	const id = await root.commit(
		(tx) =>
			tx.createTask(
				ToolTask,
				{ name: "mutate", arguments: {}, callId: "original" },
				{ ownership: { kind: "conversation" } },
			),
		context,
	);
	await harness.waitForTask(id, context);
	process.send?.({ state: "committed", id });
}
// Keep the real owner alive so the test kills it without a graceful close.
setInterval(() => {}, 1_000);
