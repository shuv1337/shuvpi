import type { AutocompleteProvider } from "@shuv1337/shuvpi-tui";
import { type BrowserSkill, readSkillBlock, resolveSkill } from "./model.ts";

export function expandSkillMentions(text: string, skills: BrowserSkill[], warn: (message: string) => void): string {
	const seen = new Set<string>();
	const blocks: string[] = [];
	for (const match of text.matchAll(/(?<=^|[\s([{"'`])\$([a-z0-9][a-z0-9/-]*)/g)) {
		const skill = resolveSkill(skills, match[1]!);
		if (!skill || seen.has(skill.filePath)) continue;
		seen.add(skill.filePath);
		try {
			blocks.push(readSkillBlock(skill));
		} catch (error) {
			warn(`Cannot read skill ${skill.name}: ${String(error)}`);
		}
	}
	return blocks.length ? `${blocks.join("\n\n")}\n\n${text}` : text;
}

function mentionPrefix(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
	if (lines.join("\n").trimStart().startsWith("/")) return undefined;
	return (lines[cursorLine] ?? "").slice(0, cursorCol).match(/(?:^|[\s([{"'`])(\$[a-z0-9/-]*)$/)?.[1];
}

export function withSkillAutocomplete(
	current: AutocompleteProvider,
	getSkills: () => BrowserSkill[],
): AutocompleteProvider {
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "$"])],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const prefix = mentionPrefix(lines, cursorLine, cursorCol);
			if (prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted) return null;
			const query = prefix.slice(1).toLowerCase();
			const items = getSkills()
				.filter((skill) => `${skill.category}/${skill.name}`.toLowerCase().includes(query))
				.map((skill) => ({
					value: `$${skill.name}`,
					label: `$${skill.name}`,
					description: skill.category ? `${skill.category} · ${skill.description}` : skill.description,
				}));
			return items.length ? { prefix, items } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("$") || !item.value.startsWith("$"))
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol - prefix.length);
			const after = line.slice(cursorCol);
			const insertion = `${item.value}${after.startsWith(" ") ? "" : " "}`;
			const result = [...lines];
			result[cursorLine] = before + insertion + after;
			return {
				lines: result,
				cursorLine,
				cursorCol: before.length + insertion.length + Number(after.startsWith(" ")),
			};
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				mentionPrefix(lines, cursorLine, cursorCol) === undefined &&
				(current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false)
			);
		},
	};
}
