import { requestWorkflowOwner, startWorkflowOwner } from "../../src/core/durable-workflows/owner.ts";

const [mode, socketPath] = process.argv.slice(2);
if (socketPath === undefined) throw new Error("Expected a workflow owner socket path");

if (mode === "owner") {
	const owner = await startWorkflowOwner({
		socketPath,
		handle: async (operation) => ({ accepted: true, type: operation.type }),
	});
	process.stdout.write("ready\n");
	await new Promise<void>((resolve) => {
		process.once("SIGTERM", resolve);
		process.once("SIGINT", resolve);
	});
	await owner.close();
} else if (mode === "client") {
	const value = await requestWorkflowOwner(socketPath, { type: "from-ui" });
	process.stdout.write(`${JSON.stringify(value)}\n`);
} else {
	throw new Error(`Unknown mode: ${mode ?? "empty"}`);
}
