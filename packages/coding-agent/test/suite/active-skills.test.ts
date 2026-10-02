import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@shuv1337/shuvpi-ai/compat";
import { TuiMainScreen } from "@shuv1337/shuvpi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createActiveSkillsExtension } from "../../src/extensions/active-skills/index.ts";
import {
	loadSkillCatalog,
	loadSkillConfig,
	readSkillBlock,
	saveSkillConfig,
} from "../../src/extensions/skill-browser/model.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const directories: string[] = [];
const harnesses: Harness[] = [];
function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "active-skills-"));
	directories.push(agentDir);
	const root = join(agentDir, "custom");
	for (const [name, body] of [
		["alpha", "ALPHA FULL TEXT\n\nSecond paragraph."],
		["beta", "BETA FULL TEXT"],
	]) {
		const path = join(root, name!, "SKILL.md");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nname: ${name}\ndescription: ${name} instructions\n---\n${body}`);
	}
	saveSkillConfig(agentDir, { paths: [root], defaultActive: ["alpha"] });
	return { agentDir, root };
}

async function setup(agentDir: string, sessionManager?: SessionManager) {
	const harness = await createHarness({
		extensionFactories: [createActiveSkillsExtension({ agentDir })],
		sessionManager,
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ shutdownHandler: () => {} });
	return harness;
}

async function prompt(harness: Harness) {
	const result = await harness.session.extensionRunner.emitBeforeAgentStart("A new turn", undefined, {
		cwd: harness.tempDir,
		forceSystemPrompt: "BASE",
	});
	return result.systemPromptOptions.forceSystemPrompt;
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => initTheme("dark"));

describe("optional active skills", () => {
	it("keeps automatically discovered skills out of persistent custom-path injection", async () => {
		const { agentDir, root } = fixture();
		const path = join(root, "alpha", "SKILL.md");
		const extensionsResult = await createTestExtensionsResult([createActiveSkillsExtension({ agentDir })], agentDir);
		const resourceLoader = createTestResourceLoader({ extensionsResult });
		resourceLoader.getSkills = () => ({
			skills: [
				{
					name: "alpha",
					description: "Automatic",
					filePath: path,
					baseDir: dirname(path),
					disableModelInvocation: false,
					sourceInfo: { path, source: "fixture", scope: "user", origin: "top-level" },
				},
			],
			diagnostics: [],
		});
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		expect(await prompt(harness)).toBe("BASE");
		harness.sessionManager.appendCustomEntry("active-skills", { active: ["alpha"] });
		expect(await prompt(harness)).toBe("BASE");
	});

	it("injects exact full text and base paths on every turn, then removes injection after deactivation", async () => {
		const { agentDir, root } = fixture();
		const harness = await setup(agentDir);
		const alpha = loadSkillCatalog(agentDir, root, []).skills.find((skill) => skill.name === "alpha")!;
		expect(await prompt(harness)).toBe(`BASE\n\n${readSkillBlock(alpha)}`);
		expect(await prompt(harness)).toBe(`BASE\n\n${readSkillBlock(alpha)}`);
		let providerPrompt = "";
		harness.setResponses([
			(context) => {
				providerPrompt = context.messages
					.filter((message) => message.role === "system")
					.map((message) => message.content)
					.join("\n");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Use the active skill");
		expect(providerPrompt).toContain("ALPHA FULL TEXT\n\nSecond paragraph.");
		await harness.session.extensionRunner.runCommand("active-skills", "clear");
		expect(await prompt(harness)).toBe("BASE");
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		expect(await prompt(harness)).toBe("BASE");
	});

	it("commits multi-selection only on confirmation and preserves choices when cancelled", async () => {
		const { agentDir } = fixture();
		const harness = await setup(agentDir);
		let cancel = true;
		const status = vi.fn();
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				setStatus: status,
				custom: async <T>(factory: Parameters<ReturnType<typeof createTestUiContext>["custom"]>[0]) => {
					let result: unknown;
					const component = await factory(
						new TuiMainScreen(new VirtualTerminal(60, 20)),
						theme,
						new KeybindingsManager({ "app.activeSkills.toggle": "ctrl+t" }),
						(value) => {
							result = value;
						},
					);
					component.handleInput?.("\x14");
					component.handleInput?.("\x1b[B");
					component.handleInput?.("\x14");
					component.handleInput?.(cancel ? "\x1b" : "\r");
					return result as T;
				},
			}),
			"tui",
		);
		await harness.session.extensionRunner.runCommand("active-skills");
		expect(await prompt(harness)).toContain("ALPHA FULL TEXT");
		cancel = false;
		await harness.session.extensionRunner.runCommand("active-skills");
		expect(await prompt(harness)).toContain("BETA FULL TEXT");
		expect(await prompt(harness)).not.toContain("ALPHA FULL TEXT");
		expect(status).toHaveBeenLastCalledWith("active-skills", "Skills: 1");
	});

	it("restores the selected branch and keeps concurrent child sessions independent", async () => {
		const { agentDir } = fixture();
		const first = await setup(agentDir);
		const defaultLeaf = first.sessionManager.getLeafId()!;
		first.sessionManager.appendCustomEntry("active-skills", { active: ["beta"] });
		const betaLeaf = first.sessionManager.getLeafId()!;
		const child = await setup(agentDir);
		expect(await prompt(first)).toContain("BETA FULL TEXT");
		expect(await prompt(child)).toContain("ALPHA FULL TEXT");
		await child.session.extensionRunner.runCommand("active-skills", "clear");
		expect(await prompt(first)).toContain("BETA FULL TEXT");
		first.sessionManager.branch(defaultLeaf);
		await first.session.extensionRunner.emit({ type: "session_tree", newLeafId: defaultLeaf, oldLeafId: betaLeaf });
		expect(await prompt(first)).toContain("ALPHA FULL TEXT");
		expect(await prompt(first)).not.toContain("BETA FULL TEXT");
		first.sessionManager.branch(betaLeaf);
		expect(await prompt(first)).toContain("BETA FULL TEXT");
		expect(await prompt(child)).toBe("BASE");
	});

	it("reopens durable state and keeps an explicit empty selection after restart", async () => {
		const { agentDir } = fixture();
		const manager = SessionManager.create(agentDir, join(agentDir, "sessions"));
		manager.appendMessage(fauxAssistantMessage("Existing conversation"));
		manager.appendCustomEntry("active-skills", { active: ["beta"] });
		const path = manager.getSessionFile()!;
		const resumed = await setup(agentDir, SessionManager.open(path));
		expect(await prompt(resumed)).toContain("BETA FULL TEXT");
		await resumed.session.extensionRunner.runCommand("active-skills", "clear");
		const reopened = await setup(agentDir, SessionManager.open(path));
		expect(await prompt(reopened)).toBe("BASE");
		expect(loadSkillConfig(agentDir).defaultActive).toEqual(["alpha"]);
	});

	it("applies saved defaults only to fresh sessions and saves defaults only on explicit command", async () => {
		const { agentDir } = fixture();
		const first = await setup(agentDir);
		first.sessionManager.appendCustomEntry("active-skills", { active: ["beta"] });
		expect(loadSkillConfig(agentDir).defaultActive).toEqual(["alpha"]);
		await first.session.extensionRunner.runCommand("active-skills", "save-defaults");
		expect(loadSkillConfig(agentDir).defaultActive).toEqual(["beta"]);
		const fresh = await setup(agentDir);
		expect(await prompt(fresh)).toContain("BETA FULL TEXT");
		const oldManager = SessionManager.inMemory();
		oldManager.appendMessage(fauxAssistantMessage("History without active skills"));
		const old = await setup(agentDir, oldManager);
		expect(await prompt(old)).toBe("BASE");
		old.sessionManager.resetLeaf();
		await old.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect(await prompt(old)).toBe("BASE");
		await old.session.extensionRunner.emit({ type: "session_start", reason: "fork" });
		expect(await prompt(old)).toBe("BASE");
		await old.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
		expect(await prompt(old)).toBe("BASE");
	});

	it("reports removed skills without injecting stale content or changing defaults", async () => {
		const { agentDir, root } = fixture();
		const harness = await setup(agentDir);
		const notify = vi.fn();
		harness.session.extensionRunner.setUIContext(createTestUiContext({ notify }), "tui");
		rmSync(join(root, "alpha"), { recursive: true });
		expect(await prompt(harness)).toBe("BASE");
		expect(notify).toHaveBeenCalledWith("Active skill unavailable: alpha", "warning");
		expect(loadSkillConfig(agentDir).defaultActive).toEqual(["alpha"]);
	});
});
