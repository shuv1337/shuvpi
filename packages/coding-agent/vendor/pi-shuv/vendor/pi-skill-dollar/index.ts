import type { ExtensionAPI } from "@shuv1337/shuvpi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@shuv1337/shuvpi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	type Skill,
	type SkillIndex,
	getSkillContent,
	getSkillIndex,
} from "../pi-skill-palette/index.ts";

const MENTION_RE = /(?<=^|[\s([{'"`])\$([a-z0-9][a-z0-9/-]*)/g;
const AUTOCOMPLETE_RE = /(?:^|[\s([{'"`])\$([a-z0-9/-]*)$/;
const MAX_SUGGESTIONS = 20;

function isReadableSkill(skill: Skill): boolean {
	if (!skill.filePath) return false;
	try {
		fs.accessSync(skill.filePath, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveToken(token: string, index: SkillIndex): Skill | undefined {
	const slashIndex = token.indexOf("/");
	if (slashIndex !== -1) {
		const category = token.slice(0, slashIndex);
		const name = token.slice(slashIndex + 1);
		if (!name) return undefined;

		for (const skill of index.skills) {
			if (skill.name === name && skill.category === category) {
				return skill;
			}
		}
		return undefined;
	}

	return index.byName.get(token);
}

function resolveMentions(text: string, index: SkillIndex): { skills: Skill[]; unreadable: Skill[] } {
	const skills: Skill[] = [];
	const unreadable: Skill[] = [];
	const seenPaths = new Set<string>();

	for (const match of text.matchAll(MENTION_RE)) {
		const token = match[1];
		if (!token) continue;

		const skill = resolveToken(token, index);
		if (!skill || seenPaths.has(skill.filePath)) continue;

		seenPaths.add(skill.filePath);
		if (!isReadableSkill(skill)) {
			unreadable.push(skill);
			continue;
		}

		skills.push(skill);
	}

	return { skills, unreadable };
}

function buildDollarSkillBlock(skill: Skill): string {
	const directory = skill.directory || (skill.filePath ? path.dirname(skill.filePath) : "");
	const content = getSkillContent(skill);
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${directory}.\n\n${content}\n</skill>`;
}

function formatSkillItem(skill: Skill): AutocompleteItem {
	const categoryPrefix = skill.category ? `[${skill.category}] ` : "";
	return {
		value: `$${skill.name}`,
		label: skill.name,
		description: `${categoryPrefix}${skill.description}`,
	};
}

function filterSkillsForAutocomplete(index: SkillIndex, query: string): AutocompleteItem[] {
	const readable = index.skills.filter(isReadableSkill);

	if (!query.trim()) {
		return readable.slice(0, MAX_SUGGESTIONS).map(formatSkillItem);
	}

	return fuzzyFilter(readable, query, (skill) => `${skill.name} ${skill.category} ${skill.description}`)
		.slice(0, MAX_SUGGESTIONS)
		.map(formatSkillItem);
}

function createSkillAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = before.match(AUTOCOMPLETE_RE);
			if (!match) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const index = getSkillIndex();
			const items = filterSkillsForAutocomplete(index, match[1] ?? "");
			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return {
				items,
				prefix: `$${match[1] ?? ""}`,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("$")) {
				const currentLine = lines[cursorLine] ?? "";
				const before = currentLine.slice(0, cursorCol);
				const after = currentLine.slice(cursorCol);
				const newBefore = before.slice(0, before.length - prefix.length) + item.value + " ";
				lines[cursorLine] = newBefore + after;
				return {
					lines,
					cursorLine,
					cursorCol: newBefore.length,
				};
			}

			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function skillDollarExtension(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (event.text.startsWith("/")) return { action: "continue" };

		const index = getSkillIndex();
		const { skills, unreadable } = resolveMentions(event.text, index);
		for (const skill of unreadable) {
			ctx.ui?.notify(`Skill file not readable: ${skill.name}`, "warning");
		}
		if (skills.length === 0) return { action: "continue" };

		const blocks: string[] = [];
		for (const skill of skills) {
			try {
				blocks.push(buildDollarSkillBlock(skill));
			} catch {
				ctx.ui?.notify(`Failed to load skill: ${skill.name}`, "warning");
			}
		}

		if (blocks.length === 0) return { action: "continue" };

		return {
			action: "transform",
			text: `${blocks.join("\n\n")}\n\n${event.text}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.ui?.addAutocompleteProvider) return;
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current));
	});
}
