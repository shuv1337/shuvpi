import { getAgentDir } from "../../config.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { expandSkillMentions, withSkillAutocomplete } from "./dollar.ts";
import { loadSkillCatalog, loadSkillConfig, readSkillBlock, resolveSkill, saveSkillConfig } from "./model.ts";
import { loadSkillBrowserStyles, SkillPicker } from "./ui.ts";

export interface SkillExtensionOptions {
	agentDir?: string;
}

/** Core browsing and one-shot invocation. No active skill state is persisted here. */
export function createSkillBrowserExtension(options: SkillExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		const agentDir = options.agentDir ?? getAgentDir();
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.addAutocompleteProvider((current) =>
				withSkillAutocomplete(current, () => loadSkillCatalog(agentDir, ctx.cwd, pi.getCommands()).skills),
			);
		});
		pi.on("input", (event, ctx) => {
			if (event.source === "extension" || event.text.trimStart().startsWith("/") || !event.text.includes("$"))
				return;
			const { skills } = loadSkillCatalog(agentDir, ctx.cwd, pi.getCommands());
			const text = expandSkillMentions(event.text, skills, (message) => ctx.ui.notify(message, "warning"));
			if (text !== event.text) return { action: "transform", text, images: event.images };
		});
		pi.registerCommand("skill", {
			description: "Browse skills or invoke a skill by name",
			handler: async (args, ctx) => {
				const { skills, config, warnings } = loadSkillCatalog(agentDir, ctx.cwd, pi.getCommands());
				for (const warning of warnings) ctx.ui.notify(warning, "warning");
				const [name, ...rest] = args.trim().split(/\s+/);
				if (name) {
					const skill = resolveSkill(skills, name.replace(/^\$/, ""));
					if (!skill) return ctx.ui.notify(`Unknown skill: ${name}`, "error");
					try {
						pi.sendUserMessage(`${readSkillBlock(skill)}\n\n${rest.join(" ") || `Use the ${skill.name} skill.`}`);
					} catch (error) {
						ctx.ui.notify(String(error), "error");
					}
					return;
				}
				if (!ctx.hasUI) return ctx.ui.notify("/skill requires interactive mode or a skill name", "error");
				try {
					const chosen = await ctx.ui.custom<string[] | undefined>(
						(tui, theme, keys, done) =>
							new SkillPicker(
								{
									skills,
									favorites: config.favorites,
									styles: loadSkillBrowserStyles(agentDir),
									onFavorite: (favorite) => {
										const current = loadSkillConfig(agentDir).favorites;
										const favorites = current.includes(favorite)
											? current.filter((value) => value !== favorite)
											: [...current, favorite];
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
					if (chosen?.[0]) {
						const text = ctx.ui.getEditorText();
						ctx.ui.setEditorText(`${text}${text && !/\s$/.test(text) ? " " : ""}$${chosen[0]} `);
					}
				} catch (error) {
					ctx.ui.notify(String(error), "error");
				}
			},
		});
	};
}
