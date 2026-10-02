#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { runDurableWorkflowOwner } from "./core/durable-workflows/owner-bootstrap.ts";
import { main } from "./main.ts";

setupCli();
const args = process.argv.slice(2);
if (args[0] === "--durable-workflow-owner") {
	void runDurableWorkflowOwner(args).catch((error: unknown) => {
		console.error(`Workflow owner failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
} else {
	main(args);
}
