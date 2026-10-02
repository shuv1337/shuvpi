import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@shuv1337/shuvpi-ai";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import { createRegistry } from "@shuv1337/shuvpi-durable";
import { openNodeSqliteStorage } from "@shuv1337/shuvpi-durable/storage/sqlite/node";
import { startDurableWorkflowService } from "../../src/core/durable-workflows/service.ts";

const [directory, mode] = process.argv.slice(2);
if (!directory) throw new Error("Missing workflow fixture directory");
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	async (request, options) => {
		await appendFile(
			join(directory, "requests.jsonl"),
			`${JSON.stringify({ users: request.messages.filter((message) => message.role === "user").length })}\n`,
		);
		if (mode === "hold") {
			await writeFile(join(directory, "reached"), "ready");
			await new Promise((_resolve, reject) =>
				options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }),
			);
		}
		return fauxAssistantMessage([fauxText("process resumed")]);
	},
]);
const service = await startDurableWorkflowService(
	{
		socketPath: join(directory, "owner.sock"),
		openStorage: () => openNodeSqliteStorage(join(directory, "state.sqlite")),
		harness: { models, registry: createRegistry() },
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	},
	BACKGROUND_CONTEXT,
);
await new Promise<void>((resolve) => {
	process.once("SIGTERM", resolve);
	process.once("SIGINT", resolve);
});
await service.close();
