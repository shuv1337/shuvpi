import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@shuv1337/shuvpi-ai/compat";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

type TempSessionResources = {
	tempDir: string;
	cleanup: () => void;
};

function createTempDir(prefix: string): TempSessionResources {
	const tempDir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return {
		tempDir,
		cleanup: () => {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	};
}

async function createOpenAISession(options?: {
	provider?: "openai" | "openai-codex";
	modelId?: "gpt-5.4" | "gpt-5.4-mini" | "gpt-5.4-pro" | "gpt-5.5" | "gpt-5.6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra";
	resourceLoader?: ReturnType<typeof createTestResourceLoader>;
}) {
	const { tempDir, cleanup } = createTempDir("shuvpi-fast-mode-test");
	const provider = options?.provider ?? "openai";
	const requestedModelId = options?.modelId ?? "gpt-5.4";
	const model =
		provider === "openai-codex"
			? getModel("openai-codex", requestedModelId as "gpt-5.4" | "gpt-5.4-mini" | "gpt-5.5")
			: getModel("openai", requestedModelId);
	if (!model) {
		throw new Error(`${provider} model not found for test`);
	}

	const authStorage = AuthStorage.inMemory({ [provider]: { type: "api_key", key: "test-key" } });
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		allowModelNetwork: false,
	});
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory(tempDir);

	const result = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		model,
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader: options?.resourceLoader ?? createTestResourceLoader(),
	});

	return {
		...result,
		tempDir,
		model,
		cleanup: () => {
			result.session.dispose();
			cleanup();
		},
	};
}

describe("fast mode session state", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("starts off, stays session-local, and is not persisted to session JSONL", async () => {
		const first = await createOpenAISession();
		cleanups.push(first.cleanup);

		expect(first.session.fastMode).toBe(false);
		expect(first.session.isFastModeActiveForCurrentModel()).toBe(false);

		const entriesBefore = first.session.sessionManager.getEntries().length;
		first.session.setFastMode(true);
		expect(first.session.fastMode).toBe(true);
		expect(first.session.isFastModeActiveForCurrentModel()).toBe(true);
		first.session.toggleFastMode();
		expect(first.session.fastMode).toBe(false);
		expect(first.session.sessionManager.getEntries()).toHaveLength(entriesBefore);

		first.session.setFastMode(true);
		const exportPath = first.session.exportToJsonl(join(first.tempDir, "session.jsonl"));
		const exported = readFileSync(exportPath, "utf-8");
		expect(exported).not.toContain("fastMode");
		expect(exported).not.toContain('"service_tier"');

		const second = await createOpenAISession();
		cleanups.push(second.cleanup);
		expect(second.session.fastMode).toBe(false);
	});
});

describe("fast mode payload mutation", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("injects service_tier priority only for supported models when fast mode is active", async () => {
		const supported = await createOpenAISession({ provider: "openai", modelId: "gpt-5.4" });
		cleanups.push(supported.cleanup);
		supported.session.setFastMode(true);

		const payload = { model: supported.model.id, input: [] };
		const mutated = await supported.session.agent.onPayload?.(payload, supported.model);
		expect(mutated).toMatchObject({
			model: supported.model.id,
			service_tier: "priority",
		});

		const codexSupported = await createOpenAISession({ provider: "openai-codex", modelId: "gpt-5.4" });
		cleanups.push(codexSupported.cleanup);
		codexSupported.session.setFastMode(true);

		const codexPayload = { model: codexSupported.model.id, input: [] };
		const codexMutated = await codexSupported.session.agent.onPayload?.(codexPayload, codexSupported.model);
		expect(codexMutated).toMatchObject({
			model: codexSupported.model.id,
			service_tier: "priority",
		});

		const codexSupported55 = await createOpenAISession({ provider: "openai-codex", modelId: "gpt-5.5" });
		cleanups.push(codexSupported55.cleanup);
		codexSupported55.session.setFastMode(true);

		const codex55Payload = { model: codexSupported55.model.id, input: [] };
		const codex55Mutated = await codexSupported55.session.agent.onPayload?.(codex55Payload, codexSupported55.model);
		expect(codex55Mutated).toMatchObject({
			model: codexSupported55.model.id,
			service_tier: "priority",
		});

		for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const) {
			const gpt56 = await createOpenAISession({ provider: "openai", modelId });
			cleanups.push(gpt56.cleanup);
			gpt56.session.setFastMode(true);

			const gpt56Payload = { model: gpt56.model.id, input: [] };
			const gpt56Mutated = await gpt56.session.agent.onPayload?.(gpt56Payload, gpt56.model);
			expect(gpt56Mutated).toMatchObject({
				model: gpt56.model.id,
				service_tier: "priority",
			});
		}

		const unsupported = await createOpenAISession({ provider: "openai", modelId: "gpt-5.4-pro" });
		cleanups.push(unsupported.cleanup);
		unsupported.session.setFastMode(true);

		const unsupportedPayload = { model: unsupported.model.id, input: [] };
		const untouched = await unsupported.session.agent.onPayload?.(unsupportedPayload, unsupported.model);
		expect(untouched).toEqual(unsupportedPayload);
	});

	it("runs extension before_provider_request handlers after fast-mode mutation", async () => {
		const seenPayloads: unknown[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(shuvpi) => {
				shuvpi.on("before_provider_request", (event) => {
					seenPayloads.push(event.payload);
					return {
						...(event.payload as Record<string, unknown>),
						service_tier: "default",
						extensionOverride: true,
					};
				});
			},
		]);
		const sessionWithExtension = await createOpenAISession({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		cleanups.push(sessionWithExtension.cleanup);
		sessionWithExtension.session.setFastMode(true);
		await sessionWithExtension.session.bindExtensions({});

		const mutated = await sessionWithExtension.session.agent.onPayload?.(
			{ model: sessionWithExtension.model.id, input: [] },
			sessionWithExtension.model,
		);

		expect(seenPayloads).toHaveLength(1);
		expect(seenPayloads[0]).toMatchObject({ service_tier: "priority" });
		expect(mutated).toMatchObject({
			service_tier: "default",
			extensionOverride: true,
		});
	});
});

type FastModeSessionStub = {
	fastMode: boolean;
	supportsFastMode(): boolean;
	isFastModeActiveForCurrentModel(): boolean;
	setFastMode(enabled: boolean): void;
	toggleFastMode(): boolean;
};

function createFastCommandHarness(overrides?: {
	supportsFastMode?: boolean;
	fastMode?: boolean;
	activeForCurrentModel?: boolean;
}) {
	const session: FastModeSessionStub = {
		fastMode: overrides?.fastMode ?? false,
		supportsFastMode: () => overrides?.supportsFastMode ?? true,
		isFastModeActiveForCurrentModel: () => overrides?.activeForCurrentModel ?? session.fastMode,
		setFastMode(enabled: boolean) {
			this.fastMode = enabled;
		},
		toggleFastMode() {
			this.fastMode = !this.fastMode;
			return this.fastMode;
		},
	};
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showError = vi.fn();
	const footerInvalidate = vi.fn();

	const fakeThis = {
		session,
		footer: { invalidate: footerInvalidate },
		showStatus,
		showWarning,
		showError,
	};

	return { fakeThis, session, showStatus, showWarning, showError, footerInvalidate };
}

describe("InteractiveMode fast command", () => {
	it("toggles fast mode on and off with /fast", () => {
		const first = createFastCommandHarness({ supportsFastMode: true, fastMode: false });
		(
			InteractiveMode as unknown as { prototype: { handleFastCommand(text: string): void } }
		).prototype.handleFastCommand.call(first.fakeThis, "/fast");
		expect(first.session.fastMode).toBe(true);
		expect(first.footerInvalidate).toHaveBeenCalledTimes(1);
		expect(first.showStatus).toHaveBeenCalledWith("Fast mode enabled");

		const second = createFastCommandHarness({ supportsFastMode: true, fastMode: true });
		(
			InteractiveMode as unknown as { prototype: { handleFastCommand(text: string): void } }
		).prototype.handleFastCommand.call(second.fakeThis, "/fast");
		expect(second.session.fastMode).toBe(false);
		expect(second.showStatus).toHaveBeenCalledWith("Fast mode disabled");
	});

	it("rejects enabling fast mode on unsupported models", () => {
		const harness = createFastCommandHarness({ supportsFastMode: false, fastMode: false });
		(
			InteractiveMode as unknown as { prototype: { handleFastCommand(text: string): void } }
		).prototype.handleFastCommand.call(harness.fakeThis, "/fast on");

		expect(harness.session.fastMode).toBe(false);
		expect(harness.showWarning).toHaveBeenCalledWith(
			"Fast mode is only available for supported OpenAI GPT-5.4/5.5 models.",
		);
	});

	it("reports inactive status and invalid usage clearly", () => {
		const statusHarness = createFastCommandHarness({
			supportsFastMode: false,
			fastMode: true,
			activeForCurrentModel: false,
		});
		(
			InteractiveMode as unknown as { prototype: { handleFastCommand(text: string): void } }
		).prototype.handleFastCommand.call(statusHarness.fakeThis, "/fast status");
		expect(statusHarness.showWarning).toHaveBeenCalledWith("Fast mode is enabled but inactive for the current model");

		const invalidHarness = createFastCommandHarness();
		(
			InteractiveMode as unknown as { prototype: { handleFastCommand(text: string): void } }
		).prototype.handleFastCommand.call(invalidHarness.fakeThis, "/fast maybe now");
		expect(invalidHarness.showError).toHaveBeenCalledWith("Usage: /fast [on|off|status]");
	});
});

describe("FooterComponent fast-mode indicator", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows fast only when active for the current model", () => {
		const session = {
			state: {
				model: {
					id: "gpt-5.4",
					provider: "openai",
					contextWindow: 200_000,
					reasoning: true,
				},
				thinkingLevel: "medium",
			},
			sessionManager: {
				getEntries: () => [],
				getSessionName: () => undefined,
				getCwd: () => "/tmp/project",
			},
			getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
			modelRuntime: {
				isUsingOAuth: () => false,
				isUsingSubscription: () => false,
			},
			isFastModeActiveForCurrentModel: () => true,
		} as unknown as ConstructorParameters<typeof FooterComponent>[0];
		const footerData = {
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map<string, string>(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		};

		const footer = new FooterComponent(session, footerData);
		const lines = footer.render(80);
		expect(lines[1]).toContain("gpt-5.4");
		expect(lines[1]).toContain("fast");
		expect(lines[1]).toContain("medium");

		const inactiveSession = {
			...session,
			isFastModeActiveForCurrentModel: () => false,
		} as unknown as ConstructorParameters<typeof FooterComponent>[0];
		const inactiveFooter = new FooterComponent(inactiveSession, footerData);
		const inactiveLines = inactiveFooter.render(80);
		expect(inactiveLines[1]).not.toContain("fast");
	});
});
