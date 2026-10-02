import { readFileSync, writeFileSync } from "node:fs";
import {
	attachWorkflowReceiptReceiver,
	persistWorkflowReceipt,
	type WorkflowReceiptDestination,
	type WorkflowReceiptEvent,
} from "../../src/core/durable-workflows/receipt.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const [phase, inputFile, acknowledgmentFile] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputFile, "utf8")) as {
	destination: WorkflowReceiptDestination;
	event: WorkflowReceiptEvent;
};
const session = SessionManager.open(input.destination.sessionFile);
const receiver = attachWorkflowReceiptReceiver(session);
if (phase === "after") {
	const result = persistWorkflowReceipt(receiver, input.destination, input.event);
	if (result.status !== "persisted") throw new Error(result.reason);
}
process.send?.("boundary");
// The owner acknowledgment is a separate durable operation, deliberately after the crash boundary.
process.on("message", () => {
	const result = persistWorkflowReceipt(receiver, input.destination, input.event);
	writeFileSync(acknowledgmentFile, JSON.stringify(result));
	process.exit(0);
});
