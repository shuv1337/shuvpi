import { fauxAssistantMessage } from "@shuv1337/shuvpi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContextActions, TreePreparation } from "../../src/core/extensions/types.ts";
import {
	createIncrementalWorkflowExtension,
	INCREMENTAL_WORKFLOW_DEFAULT_END_PROMPT,
	INCREMENTAL_WORKFLOW_GIT_END_PROMPT,
	INCREMENTAL_WORKFLOW_STATE_ENTRY,
} from "../../src/extensions/incremental-workflow/index.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { userMsg } from "../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
beforeEach(() => initTheme("dark"));
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function bindNavigation(harness: Harness): void {
	const unused = async (): Promise<never> => {
		throw new Error("Unexpected session operation");
	};
	const actions: ExtensionCommandContextActions = {
		waitForIdle: async () => {},
		newSession: unused,
		fork: unused,
		switchSession: unused,
		reload: unused,
		navigateTree: (target, options) => harness.session.navigateTree(target, options),
	};
	harness.session.extensionRunner.bindCommandContext(actions);
}

describe("optional incremental workflow commands", () => {
	it.each([
		["", INCREMENTAL_WORKFLOW_DEFAULT_END_PROMPT],
		["git", INCREMENTAL_WORKFLOW_GIT_END_PROMPT],
		["full", undefined],
		["focus on the API", "focus on the API"],
	])("summarizes and advances the persisted marker with mode %s", async (mode, instructions) => {
		const preparations: TreePreparation[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createIncrementalWorkflowExtension(),
				(pi) => {
					pi.on("session_before_tree", (event) => {
						preparations.push(event.preparation);
					});
				},
			],
		});
		harnesses.push(harness);
		bindNavigation(harness);
		harness.sessionManager.appendMessage(userMsg("Plan the work"));
		const baseline = harness.sessionManager.appendMessage(fauxAssistantMessage("Agreed plan"));
		await harness.session.extensionRunner.runCommand("marker");
		expect(harness.sessionManager.getLabel(baseline)).toBe("marker");
		harness.sessionManager.appendMessage(userMsg("Implement it"));
		harness.sessionManager.appendMessage(fauxAssistantMessage("Implemented outcome"));
		harness.setResponses([fauxAssistantMessage("Completed increment summary")]);
		await harness.session.extensionRunner.runCommand("end", mode);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(preparations).toHaveLength(1);
		expect(preparations[0].targetId).toBe(baseline);
		expect(preparations[0].customInstructions).toBe(instructions);
		const summary = harness.sessionManager.getBranch().find((entry) => entry.type === "branch_summary");
		expect(summary).toMatchObject({ summary: expect.stringContaining("Completed increment summary") });
		expect(harness.sessionManager.getLabel(summary!.id)).toBe("marker");
		expect(harness.sessionManager.getLabel(baseline)).toBeUndefined();
		const state = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === INCREMENTAL_WORKFLOW_STATE_ENTRY);
		expect(state).toMatchObject({ data: { version: 1, markerId: summary!.id } });
		await harness.session.extensionRunner.runCommand("end");
		expect(preparations).toHaveLength(1);
	});

	it("preserves user labels and ignores markers from another branch", async () => {
		const harness = await createHarness({ extensionFactories: [createIncrementalWorkflowExtension()] });
		harnesses.push(harness);
		bindNavigation(harness);
		const notify = vi.fn();
		harness.session.extensionRunner.setUIContext(createTestUiContext({ notify }), "tui");
		await harness.session.extensionRunner.runCommand("marker");
		expect(notify).toHaveBeenCalledWith("No conversation point to mark yet", "warning");
		harness.sessionManager.appendMessage(userMsg("Plan"));
		const baseline = harness.sessionManager.appendMessage(fauxAssistantMessage("Plan answer"));
		harness.sessionManager.appendLabelChange(baseline, "keep this label");
		await harness.session.extensionRunner.runCommand("marker");
		expect(harness.sessionManager.getLabel(baseline)).toBe("keep this label");
		harness.sessionManager.branch(baseline);
		harness.sessionManager.appendMessage(fauxAssistantMessage("Sibling branch"));
		harness.setResponses([fauxAssistantMessage("must remain queued")]);
		await harness.session.extensionRunner.runCommand("end");
		expect(notify).toHaveBeenCalledWith("No marker set. Run /marker first", "warning");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not advance on cancelled navigation and clears progress after failure", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createIncrementalWorkflowExtension(),
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		bindNavigation(harness);
		const setWorkingMessage = vi.fn();
		harness.session.extensionRunner.setUIContext(createTestUiContext({ setWorkingMessage }), "tui");
		harness.sessionManager.appendMessage(userMsg("Plan"));
		const baseline = harness.sessionManager.appendMessage(fauxAssistantMessage("Plan answer"));
		await harness.session.extensionRunner.runCommand("marker");
		harness.sessionManager.appendMessage(fauxAssistantMessage("New work"));
		const leaf = harness.sessionManager.getLeafId();
		await harness.session.extensionRunner.runCommand("end");
		expect(harness.sessionManager.getLeafId()).toBe(leaf);
		expect(harness.sessionManager.getLabel(baseline)).toBe("marker");
		expect(setWorkingMessage).toHaveBeenLastCalledWith();
		vi.spyOn(harness.session, "navigateTree").mockRejectedValueOnce(new Error("summary failed"));
		await expect(harness.session.extensionRunner.runCommand("end")).rejects.toThrow("summary failed");
		expect(setWorkingMessage).toHaveBeenLastCalledWith();
		expect(harness.sessionManager.getLeafId()).toBe(leaf);
	});
});
