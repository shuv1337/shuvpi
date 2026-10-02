import { fauxAssistantMessage } from "@shuv1337/shuvpi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionError } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("extension runCommand", () => {
	it("dispatches a resolved command with fresh context and no provider request or transcript entry", async () => {
		let api!: ExtensionAPI;
		const calls: Array<{ args: string; ctx: ExtensionCommandContext }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerCommand("record", {
						handler: async (args, ctx) => {
							await ctx.waitForIdle();
							calls.push({ args, ctx });
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must stay queued")]);
		await api.runCommand("record", "verbatim  arguments");
		await api.runCommand("record");
		expect(calls.map((call) => call.args)).toEqual(["verbatim  arguments", ""]);
		expect(calls[0].ctx).not.toBe(calls[1].ctx);
		expect(calls[0].ctx.sessionManager.getSessionId()).toBe(harness.sessionManager.getSessionId());
		expect(calls[0].ctx.model).toBe(harness.session.model);
		expect(typeof calls[0].ctx.getSystemPromptOptions()).toBe("object");
		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("uses disambiguated invocation names and propagates handler failures", async () => {
		let api!: ExtensionAPI;
		const calls: string[] = [];
		const failure = new Error("command failed");
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerCommand("duplicate", {
						handler: async () => {
							calls.push("first");
						},
					});
					pi.registerCommand("fails", {
						handler: async () => {
							throw failure;
						},
					});
				},
				(pi) => {
					pi.registerCommand("duplicate", {
						handler: async () => {
							calls.push("second");
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const errors: ExtensionError[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error));
		await expect(api.runCommand("duplicate")).rejects.toThrow("Unknown extension command");
		await api.runCommand("duplicate:2");
		expect(calls).toEqual(["second"]);
		await expect(api.runCommand("fails")).rejects.toBe(failure);
		expect(errors).toEqual([{ extensionPath: "command:fails", event: "command", error: "command failed" }]);
		expect(harness.session.messages).toEqual([]);
	});

	it("rejects calls during loading and after the extension runtime is invalidated", async () => {
		let api!: ExtensionAPI;
		let calls = 0;
		const harness = await createHarness({
			extensionFactories: [
				async (pi) => {
					api = pi;
					await expect(pi.runCommand("record")).rejects.toThrow("not initialized");
					pi.registerCommand("record", {
						handler: async () => {
							calls++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.invalidate();
		await expect(api.runCommand("record")).rejects.toThrow("stale");
		expect(calls).toBe(0);
	});
});
