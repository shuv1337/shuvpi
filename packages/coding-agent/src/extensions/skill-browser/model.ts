import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { SlashCommandInfo } from "../../core/slash-commands.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

export interface BrowserSkill {
	name: string;
	description: string;
	filePath: string;
	directory: string;
	category: string;
	origin: "auto" | "custom";
}

export interface SkillBrowserConfig {
	paths: string[];
	favorites: string[];
	defaultActive: string[];
}

function readConfig(agentDir: string): Record<string, unknown> {
	const path = join(agentDir, "skill-browser.json");
	if (!existsSync(path)) return {};
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid skill config: ${path}`);
	return value as Record<string, unknown>;
}

export function loadSkillConfig(agentDir: string): SkillBrowserConfig {
	const raw = readConfig(agentDir);
	const result: SkillBrowserConfig = { paths: [], favorites: [], defaultActive: [] };
	for (const key of ["paths", "favorites", "defaultActive"] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
			throw new Error(`Skill config ${key} must be an array of strings`);
		}
		result[key] = [...new Set(value)];
	}
	return result;
}

/** Re-read immediately before writing so edits to unrelated config fields survive. */
export function saveSkillConfig(agentDir: string, changes: Partial<SkillBrowserConfig>): void {
	const current = readConfig(agentDir);
	loadSkillConfig(agentDir);
	mkdirSync(agentDir, { recursive: true });
	const path = join(agentDir, "skill-browser.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ ...current, ...changes }, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function loadSkillCatalog(
	agentDir: string,
	cwd: string,
	commands: SlashCommandInfo[],
): { skills: BrowserSkill[]; config: SkillBrowserConfig; warnings: string[] } {
	const warnings: string[] = [];
	let config: SkillBrowserConfig;
	try {
		config = loadSkillConfig(agentDir);
	} catch (error) {
		config = { paths: [], favorites: [], defaultActive: [] };
		warnings.push(String(error));
	}
	const skills = new Map<string, BrowserSkill>();
	const files = new Set<string>();
	const add = (filePath: string, origin: BrowserSkill["origin"], category: string, command?: SlashCommandInfo) => {
		try {
			const canonical = realpathSync(filePath);
			if (files.has(canonical)) return;
			const { frontmatter } = parseFrontmatter(readFileSync(canonical, "utf8"));
			const name =
				command?.name.replace(/^skill:/, "") ??
				(typeof frontmatter.name === "string"
					? frontmatter.name
					: basename(filePath) === "SKILL.md"
						? basename(dirname(filePath))
						: basename(filePath, ".md"));
			if (!/^[a-z0-9][a-z0-9/-]*$/.test(name)) {
				warnings.push(`Invalid skill name in ${filePath}: ${name}`);
				return;
			}
			files.add(canonical);
			if (skills.has(name)) {
				warnings.push(`Duplicate skill ${name}: using ${skills.get(name)!.filePath}`);
				return;
			}
			skills.set(name, {
				name,
				description:
					command?.description ?? (typeof frontmatter.description === "string" ? frontmatter.description : ""),
				filePath: canonical,
				directory: dirname(canonical),
				category,
				origin,
			});
		} catch (error) {
			warnings.push(`Cannot read skill ${filePath}: ${String(error)}`);
		}
	};
	for (const command of commands) {
		if (command.source === "skill" && command.sourceInfo.path) add(command.sourceInfo.path, "auto", "", command);
	}
	const visited = new Set<string>();
	const walk = (path: string, root: string) => {
		try {
			const canonical = realpathSync(path);
			if (visited.has(canonical)) return;
			visited.add(canonical);
			if (statSync(path).isFile()) {
				if (path.endsWith(".md") && basename(path).toLowerCase() !== "readme.md") add(path, "custom", "");
				return;
			}
			for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.name.startsWith(".")) continue;
				const child = join(path, entry.name);
				let directory = entry.isDirectory();
				if (entry.isSymbolicLink()) {
					try {
						directory = statSync(child).isDirectory();
					} catch (error) {
						warnings.push(`Cannot read skill path ${child}: ${String(error)}`);
						continue;
					}
				}
				if (directory) walk(child, root);
				else if (
					entry.name === "SKILL.md" ||
					(path === root && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
				) {
					const category = relative(root, entry.name === "SKILL.md" ? dirname(path) : path).replaceAll("\\", "/");
					add(child, "custom", category === ".." ? "" : category);
				}
			}
		} catch (error) {
			warnings.push(`Cannot scan skill path ${path}: ${String(error)}`);
		}
	};
	for (const configuredPath of config.paths) {
		const path = configuredPath.startsWith("~/")
			? join(homedir(), configuredPath.slice(2))
			: resolve(cwd, configuredPath);
		walk(path, path);
	}
	return { skills: sortSkills([...skills.values()], config.favorites), config, warnings };
}

export function sortSkills(skills: BrowserSkill[], favorites: string[]): BrowserSkill[] {
	const favoriteSet = new Set(favorites);
	return [...skills].sort(
		(a, b) => Number(favoriteSet.has(b.name)) - Number(favoriteSet.has(a.name)) || a.name.localeCompare(b.name),
	);
}

export function resolveSkill(skills: BrowserSkill[], name: string): BrowserSkill | undefined {
	return (
		skills.find((skill) => skill.name === name) ??
		skills.find((skill) => skill.category && `${skill.category}/${skill.name}` === name)
	);
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function readSkillBlock(skill: BrowserSkill): string {
	const { body } = parseFrontmatter(readFileSync(skill.filePath, "utf8"));
	return `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.filePath)}">\nReferences are relative to ${skill.directory}.\n\n${body}\n</skill>`;
}
