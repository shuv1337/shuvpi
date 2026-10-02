import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import type { DocumentId } from "@shuv1337/shuvpi-durable";
import { openNodeSqliteStorage } from "@shuv1337/shuvpi-durable/storage/sqlite/node";
import { startWorkflowOwner } from "../../src/core/durable-workflows/owner.ts";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Expected private state directory");
const context = BACKGROUND_CONTEXT;
const owner = await startWorkflowOwner({
	socketPath: join(directory, "owner.sock"),
	handle: async (operation) => {
		const current = await storage.document(id, "current", context);
		if (!current || typeof current.value.count !== "number") throw new Error("Missing persisted counter");
		if (operation.type === "increment") {
			const count = current.value.count + 1;
			await storage.commit(
				[{ type: "document.change", id, content: { kind: "base", version: 1, value: { count } } }],
				context,
			);
			return { count };
		}
		if (operation.type === "read") return current.value;
		throw new Error("Unknown operation");
	},
});
const storage = await openNodeSqliteStorage(join(directory, "state.sqlite"));
const record = await storage.findDocument({ kind: "package-proof", scope: { kind: "session" } }, "current", context);
const id = record?.id ?? (await storage.mintId<DocumentId>());
if (!record) {
	await storage.commit(
		[
			{
				type: "document.create",
				record: { id, kind: "package-proof", scope: { kind: "session" } },
				content: { kind: "base", version: 1, value: { count: 0 } },
			},
		],
		context,
	);
}
process.stdout.write("ready\n");
await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
await owner.close();
await storage.close(context);
