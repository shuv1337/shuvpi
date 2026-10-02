import { fauxAssistantMessage, fauxToolCall } from "@shuv1337/shuvpi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundJobsExtension } from "../../src/extensions/background-jobs/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
});
describe("background completion integration", () => {
	it("reload terminates the old process manager without a late or duplicate follow-up", async () => {
		const harness = await createHarness({ extensionFactories: [createBackgroundJobsExtension()] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bg_start", { command: "sleep 0.2; printf stale", title: "reload fixture" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("running"),
		]);
		await harness.session.prompt("start");
		const previous = harness.session.extensionRunner;
		await harness.session.reload();
		expect(harness.session.extensionRunner).not.toBe(previous);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
		const notices: string[] = [];
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({ notify: (message) => notices.push(message) }),
			"tui",
		);
		await harness.session.extensionRunner.runCommand("ps");
		expect(notices).toContain("No background jobs");
	});
	it("delivers one follow-up after completion during a busy parent turn", async () => {
		const harness = await createHarness({ extensionFactories: [createBackgroundJobsExtension()] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bg_start", { command: "printf background-output", title: "fixture" })], {
				stopReason: "toolUse",
			}),
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 80));
				return fauxAssistantMessage("parent done");
			},
			fauxAssistantMessage("received completion"),
		]);
		await harness.session.prompt("start the fixture");
		const completions = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "background-job-result");
		expect(completions).toHaveLength(1);
		expect(completions[0]).toMatchObject({ details: { status: "done", stdout: "background-output" } });
	});
	it("suppresses killed-job follow-ups during session teardown and resets on a new session", async () => {
		const harness = await createHarness({ extensionFactories: [createBackgroundJobsExtension()] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bg_start", { command: "sleep 60", title: "hold" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("running"),
		]);
		await harness.session.prompt("start");
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bg_list", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("empty"),
		]);
		await harness.session.prompt("list");
		const result = harness.session.messages.findLast((message) => message.role === "toolResult");
		expect(result).toMatchObject({ details: [] });
	});
});
