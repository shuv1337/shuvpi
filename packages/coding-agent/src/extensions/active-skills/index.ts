import { getAgentDir } from "../../config.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import type { SkillExtensionOptions } from "../skill-browser/index.ts";
import { loadSkillCatalog, loadSkillConfig, readSkillBlock, saveSkillConfig } from "../skill-browser/model.ts";
import { loadSkillBrowserStyles, SkillPicker } from "../skill-browser/ui.ts";

const STATE_TYPE = "active-skills";

function activeNames(ctx: ExtensionContext): string[] | undefined {
	for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data: unknown = entry.data;
		if (
			data &&
			typeof data === "object" &&
			"active" in data &&
			Array.isArray(data.active) &&
			data.active.every((name): name is string => typeof name === "string")
		)
			return [...new Set(data.active)];
	}
	return undefined;
}

/** Optional full-text injection; all state belongs to the current session branch. */
export function createActiveSkillsExtension(options: SkillExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		const agentDir = options.agentDir ?? getAgentDir();
		const status = (ctx: ExtensionContext) => {
			const active = activeNames(ctx) ?? [];
			ctx.ui.setStatus(STATE_TYPE, active.length ? `Skills: ${active.length}` : undefined);
		};
		pi.on("session_start", (event, ctx) => {
			if (
				activeNames(ctx) === undefined &&
				(event.reason === "new" ||
					(event.reason === "startup" &&
						!ctx.sessionManager.getEntries().some((entry) => entry.type === "message")))
			) {
				const { config, skills, warnings } = loadSkillCatalog(agentDir, ctx.cwd, pi.getCommands());
				for (const warning of warnings) ctx.ui.notify(warning, "warning");
				pi.appendEntry(STATE_TYPE, {
					active: config.defaultActive.filter((name) =>
						skills.some((skill) => skill.origin === "custom" && skill.name === name),
					),
				});
			}
			status(ctx);
		});
		pi.on("session_tree", (_event, ctx) => status(ctx));
		pi.on("before_agent_start", (event, ctx) => {
			const names = activeNames(ctx) ?? [];
			if (!names.length) return;
			const { skills } = loadSkillCatalog(agentDir, ctx.cwd, pi.getCommands());
			const blocks: string[] = [];
			for (const name of names) {
				const skill = skills.find((candidate) => candidate.origin === "custom" && candidate.name === name);
				if (!skill) {
					ctx.ui.notify(`Active skill unavailable: ${name}`, "warning");
					continue;
				}
				try {
					blocks.push(readSkillBlock(skill));
				} catch (error) {
					ctx.ui.notify(`Cannot read active skill ${name}: ${String(error)}`, "warning");
				}
			}
			return blocks.length ? { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` } : undefined;
		});
		pi.registerCommand("active-skills", {
			description: "Choose persistent skills; clear or save-defaults",
			handler: async (args, ctx) => {
				try {
					const command = args.trim();
					if (command === "clear") {
						pi.appendEntry(STATE_TYPE, { active: [] });
						status(ctx);
						return;
					}
					if (command === "save-defaults") {
						saveSkillConfig(agentDir, { defaultActive: activeNames(ctx) ?? [] });
						ctx.ui.notify("Active skill defaults saved", "info");
						return;
					}
					if (command) return ctx.ui.notify("Usage: /active-skills [clear|save-defaults]", "error");
					if (!ctx.hasUI) return ctx.ui.notify("/active-skills requires interactive mode", "error");
					const { skills, config, warnings } = loadSkillCatalog(agentDir, ctx.cwd, pi.getCommands());
					for (const warning of warnings) ctx.ui.notify(warning, "warning");
					const chosen = await ctx.ui.custom<string[] | undefined>(
						(tui, theme, keys, done) =>
							new SkillPicker(
								{
									skills: skills.filter((skill) => skill.origin === "custom"),
									favorites: config.favorites,
									selected: activeNames(ctx) ?? [],
									styles: loadSkillBrowserStyles(agentDir),
									onFavorite: (name) => {
										const current = loadSkillConfig(agentDir).favorites;
										const favorites = current.includes(name)
											? current.filter((favorite) => favorite !== name)
											: [...current, name];
										saveSkillConfig(agentDir, { favorites });
										return favorites;
									},
									onConfirm: done,
									onCancel: () => done(undefined),
									onError: (error) => ctx.ui.notify(String(error), "error"),
								},
								tui,
								theme,
								keys,
							),
					);
					if (chosen) {
						pi.appendEntry(STATE_TYPE, { active: chosen });
						status(ctx);
					}
				} catch (error) {
					ctx.ui.notify(String(error), "error");
				}
			},
		});
	};
}
