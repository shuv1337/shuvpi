/**
 * Skill Palette Extension
 *
 * A VS Code/Amp-style command palette for quickly selecting and applying skills.
 * Usage: /skill - Opens the skill picker overlay
 *
 * Supports:
 * - Auto-loaded skills from pi (locked)
 * - Multi-select skills from config-defined locations
 */

import type { ExtensionAPI, ExtensionContext } from "@shuv1337/shuvpi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@shuv1337/shuvpi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	directory: string;
	category: string;
	origin: "auto" | "custom";
}

export interface SkillIndex {
	skills: readonly Skill[];
	byName: ReadonlyMap<string, Skill>;
	roots: readonly string[];
}

interface SkillBrowserConfig {
	paths?: string[];
	favorites?: string[];
	defaultActive?: string[];
}

interface SlashCommandInfo {
	name: string;
	description?: string;
	source?: string;
	path?: string;
	sourceInfo?: {
		path?: string;
		baseDir?: string;
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Theming
// ═══════════════════════════════════════════════════════════════════════════

interface PaletteTheme {
	border: string;        // Box borders
	title: string;         // Title text
	selected: string;      // Selected item highlight
	selectedText: string;  // Selected item text
	queued: string;        // Queued badge
	searchIcon: string;    // Search icon
	placeholder: string;   // Placeholder text
	description: string;   // Skill descriptions
	hint: string;          // Footer hints
	confirm: string;       // Confirm button (keep)
	cancel: string;        // Cancel button (remove)
}

const DEFAULT_THEME: PaletteTheme = {
	border: "2",           // dim
	title: "2",            // dim
	selected: "36",        // cyan
	selectedText: "36",    // cyan
	queued: "32",          // green
	searchIcon: "2",       // dim
	placeholder: "2;3",    // dim italic
	description: "2",      // dim
	hint: "2",             // dim
	confirm: "32",         // green
	cancel: "31",          // red
};

function loadTheme(): PaletteTheme {
	const configPath = path.join(os.homedir(), ".shuvpi", "agent", "extensions", "pi-skill-palette", "theme.json");
	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			const custom = JSON.parse(content) as Partial<PaletteTheme>;
			return { ...DEFAULT_THEME, ...custom };
		}
	} catch {
		// Ignore errors, use default
	}
	return DEFAULT_THEME;
}

function fg(code: string, text: string): string {
	if (!code) return text;
	// Handle compound codes like "2;3" (dim + italic)
	return `\x1b[${code}m${text}\x1b[0m`;
}

function progressBar(filled: number, total: number, theme: PaletteTheme): string {
	const filledBlock = fg(theme.selected, "█");
	const emptyBlock = fg(theme.hint, "░");
	let out = "";
	for (let i = 0; i < total; i++) {
		out += i < filled ? filledBlock : emptyBlock;
	}
	return out;
}

// Load theme once at startup
const paletteTheme = loadTheme();

type SkillFormat = "recursive" | "claude";

/**
 * Load config from ~/.shuvpi/agent/skill-browser.json
 */
function loadConfig(): SkillBrowserConfig {
	const configPath = path.join(os.homedir(), ".shuvpi", "agent", "skill-browser.json");
	let config: SkillBrowserConfig = {};

	try {
		if (fs.existsSync(configPath)) {
			const content = fs.readFileSync(configPath, "utf-8");
			const parsed = JSON.parse(content) as SkillBrowserConfig;
			config = { ...parsed };
			if (parsed.paths) {
				config.paths = [...parsed.paths];
			}
			if (parsed.favorites) {
				config.favorites = [...new Set(parsed.favorites)];
			}
			if (parsed.defaultActive) {
				config.defaultActive = [...new Set(parsed.defaultActive)];
			}
		}
	} catch {
		// Ignore invalid config
	}

	return config;
}

function resolveConfigPaths(paths: string[] | undefined, cwd: string): string[] {
	if (!paths || paths.length === 0) return [];
	return paths.map((p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(cwd, p)));
}

/**
 * Scan a file or directory for skills based on the format
 */
function scanSkillPath(
	targetPath: string,
	format: SkillFormat,
	skillsByName: Map<string, Skill>,
	origin: Skill["origin"],
): void {
	if (!fs.existsSync(targetPath)) return;

	let stats: fs.Stats;
	try {
		stats = fs.statSync(targetPath);
	} catch {
		return;
	}

	if (stats.isFile()) {
		if (targetPath.endsWith(".md")) {
			const fallback = path.basename(targetPath, path.extname(targetPath));
			loadSkillFromFile(targetPath, skillsByName, origin, fallback);
		}
		return;
	}

	if (stats.isDirectory()) {
		scanSkillDir(targetPath, format, skillsByName, origin);
	}
}

/**
 * Scan a directory for skills based on the format
 * - "recursive": scans directories recursively looking for SKILL.md files and root .md files
 * - "claude": only scans one level deep (directories directly containing SKILL.md)
 */
function scanSkillDir(
	dir: string,
	format: SkillFormat,
	skillsByName: Map<string, Skill>,
	origin: Skill["origin"],
	visitedDirs?: Set<string>,
	isRoot = true,
): void {
	if (!fs.existsSync(dir)) return;

	// Track visited directories by realpath to detect symlink cycles
	const visited = visitedDirs ?? new Set<string>();
	let realDir: string;
	try {
		realDir = fs.realpathSync(dir);
	} catch {
		realDir = dir;
	}
	if (visited.has(realDir)) return;
	visited.add(realDir);

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const entryPath = path.join(dir, entry.name);

			// Handle symlinks
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = fs.statSync(entryPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue; // Broken symlink
				}
			}

			if (format === "recursive") {
				// Recursive format: scan directories, look for SKILL.md files anywhere
				if (isDirectory) {
					scanSkillDir(entryPath, format, skillsByName, origin, visited, false);
					continue;
				}

				if (!isFile) continue;
				if (entry.name === "SKILL.md") {
					loadSkillFromFile(entryPath, skillsByName, origin);
					continue;
				}

				if (isRoot && entry.name.endsWith(".md") && entry.name !== "README.md") {
					const fallback = path.basename(entry.name, ".md");
					loadSkillFromFile(entryPath, skillsByName, origin, fallback);
				}
			} else if (format === "claude") {
				// Claude format: only one level deep, each directory must contain SKILL.md
				if (!isDirectory) continue;

				const skillFile = path.join(entryPath, "SKILL.md");
				if (!fs.existsSync(skillFile)) continue;

				loadSkillFromFile(skillFile, skillsByName, origin);
			}
		}
	} catch {
		// Skip inaccessible directories
	}
}

/**
 * Load a single skill from a SKILL.md file
 */
function loadSkillFromFile(
	filePath: string,
	skillsByName: Map<string, Skill>,
	origin: Skill["origin"],
	fallbackName?: string,
): void {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const skillDir = path.dirname(filePath);
		const parentDirName = fallbackName ?? path.basename(skillDir);
		const { name, description } = parseFrontmatter(content, parentDirName);

		if (description && !skillsByName.has(name)) {
			// First occurrence wins (earlier sources take precedence)
			skillsByName.set(name, {
				name,
				description,
				filePath,
				directory: skillDir,
				category: "",
				origin,
			});
		}
	} catch {
		// Skip invalid skill files
	}
}

/**
 * Load auto skills that pi has already discovered.
 */
function loadAutoSkillsFromCommands(commands: SlashCommandInfo[]): Skill[] {
	const skills: Skill[] = [];
	const seen = new Set<string>();

	for (const command of commands) {
		if (command.source !== "skill") continue;

		const rawName = command.name ?? "";
		const name = rawName.startsWith("skill:") ? rawName.slice(6) : rawName;
		if (!name || seen.has(name)) continue;

		const description = command.description ?? "";
		if (!description) continue;

		const filePath = command.sourceInfo?.path ?? command.path ?? "";
		const directory =
			command.sourceInfo?.baseDir ?? (filePath ? path.dirname(filePath) : "");
		if (!filePath) continue;

		skills.push({
			name,
			description,
			filePath,
			directory,
			category: "",
			origin: "auto",
		});
		seen.add(name);
	}

	return skills;
}

/**
 * Load skills from pi defaults plus config-defined paths.
 */
function stripQuotedValue(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function deriveCategory(directory: string, roots: string[]): string {
	for (const root of roots) {
		const rel = path.relative(root, directory);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;

		let categoryPath = rel.split(path.sep).join("/");
		if (categoryPath.startsWith("skills/")) {
			categoryPath = categoryPath.slice("skills/".length);
		}

		const parts = categoryPath.split("/").filter(Boolean);
		if (parts.length <= 1) return "";
		return parts.slice(0, -1).join("/");
	}
	return "";
}

function assignCategories(skillsByName: Map<string, Skill>, roots: string[]): void {
	for (const skill of skillsByName.values()) {
		skill.category = deriveCategory(skill.directory, roots);
	}
}

function loadSkills(
	cwd: string,
	config: SkillBrowserConfig,
	autoSkills: Skill[],
	roots: string[],
): {
	skills: Skill[];
	skillsByName: Map<string, Skill>;
	autoSkillNames: Set<string>;
} {
	const skillsByName = new Map<string, Skill>();

	for (const skill of autoSkills) {
		if (!skillsByName.has(skill.name)) {
			skillsByName.set(skill.name, skill);
		}
	}

	for (const targetPath of roots) {
		scanSkillPath(targetPath, "recursive", skillsByName, "custom");
	}

	assignCategories(skillsByName, roots);

	const favorites = new Set(config.favorites ?? []);
	const skills = Array.from(skillsByName.values()).sort((a, b) => {
		const aFav = favorites.has(a.name);
		const bFav = favorites.has(b.name);
		if (aFav && !bFav) return -1;
		if (!aFav && bFav) return 1;
		return a.name.localeCompare(b.name);
	});

	const autoSkillNames = new Set(
		Array.from(skillsByName.values())
			.filter((skill) => skill.origin === "auto")
			.map((skill) => skill.name),
	);

	return { skills, skillsByName, autoSkillNames };
}

/**
 * Parse frontmatter from skill file
 */
function parseFrontmatter(content: string, fallbackName: string): { name: string; description: string } {
	if (!content.startsWith("---")) {
		return { name: fallbackName, description: "" };
	}

	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { name: fallbackName, description: "" };
	}

	const frontmatter = content.slice(4, endIndex);
	let name = fallbackName;
	let description = "";

	for (const line of frontmatter.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;

		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();

		if (key === "name") name = stripQuotedValue(value);
		if (key === "description") description = stripQuotedValue(value);
	}

	return { name, description };
}

/**
 * Get skill content without frontmatter
 */
export function getSkillContent(skill: Skill): string {
	const raw = fs.readFileSync(skill.filePath, "utf-8");
	if (!raw.startsWith("---")) return raw;

	const endIndex = raw.indexOf("\n---", 3);
	if (endIndex === -1) return raw;

	return raw.slice(endIndex + 4).trim();
}

/**
 * Simple fuzzy match scoring
 */
function fuzzyScore(query: string, text: string): number {
	const lowerQuery = query.toLowerCase();
	const lowerText = text.toLowerCase();

	if (lowerText.includes(lowerQuery)) {
		return 100 + (lowerQuery.length / lowerText.length) * 50;
	}

	let score = 0;
	let queryIndex = 0;
	let consecutiveBonus = 0;

	for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
		if (lowerText[i] === lowerQuery[queryIndex]) {
			score += 10 + consecutiveBonus;
			consecutiveBonus += 5;
			queryIndex++;
		} else {
			consecutiveBonus = 0;
		}
	}

	return queryIndex === lowerQuery.length ? score : 0;
}

/**
 * Filter and sort skills by fuzzy match
 */
function filterSkills(skills: Skill[], query: string): Skill[] {
	if (!query.trim()) return skills;

	const scored = skills
		.map((skill) => ({
			skill,
			score: Math.max(
				fuzzyScore(query, skill.name),
				fuzzyScore(query, skill.description) * 0.8,
			),
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);

	return scored.map((item) => item.skill);
}

/**
 * Skill Palette Overlay Component
 */
class SkillPaletteComponent {
	private allSkills: Skill[];
	private filtered: Skill[];
	private selected = 0;
	private query = "";
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private requestRender: (() => void) | null = null;
	private static readonly INACTIVITY_MS = 60000; // Auto-dismiss after 60s of no input

	constructor(
		skills: Skill[],
		private selectedSkills: Set<string>,
		private lockedSkills: Set<string>,
		private favorites: Set<string>,
		private done: (action: "apply" | "cancel") => void,
	) {
		this.allSkills = skills;
		this.filtered = skills;
		this.resetInactivityTimeout();
	}

	setRequestRender(fn: () => void): void {
		this.requestRender = fn;
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup();
			this.done("cancel");
		}, SkillPaletteComponent.INACTIVITY_MS);
	}

	private toggleSkill(skill: Skill): void {
		if (this.lockedSkills.has(skill.name)) return;
		if (this.selectedSkills.has(skill.name)) {
			this.selectedSkills.delete(skill.name);
		} else {
			this.selectedSkills.add(skill.name);
		}
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout(); // Reset on any input

		if (matchesKey(data, "escape")) {
			this.cleanup();
			this.done("cancel");
			return;
		}

		if (matchesKey(data, "return")) {
			this.cleanup();
			this.done("apply");
			return;
		}

		if (matchesKey(data, "space")) {
			const skill = this.filtered[this.selected];
			if (skill) {
				this.toggleSkill(skill);
				this.requestRender?.();
			}
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
				this.requestRender?.();
			}
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
				this.requestRender?.();
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.updateFilter();
				this.requestRender?.();
			}
			return;
		}

		// Printable character
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.updateFilter();
			this.requestRender?.();
		}
	}

	private updateFilter(): void {
		this.filtered = filterSkills(this.allSkills, this.query);
		this.selected = 0; // Always jump to top match when typing
	}

	render(width: number): string[] {
		const innerW = width - 2;
		const lines: string[] = [];

		// Theme-aware color helpers
		const t = paletteTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const selected = (s: string) => fg(t.selected, s);
		const selectedText = (s: string) => fg(t.selectedText, s);
		const queued = (s: string) => fg(t.queued, s);
		const searchIcon = (s: string) => fg(t.searchIcon, s);
		const placeholder = (s: string) => fg(t.placeholder, s);
		const description = (s: string) => fg(t.description, s);
		const hint = (s: string) => fg(t.hint, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

		const visLen = visibleWidth;

		const row = (content: string) => border("│") + truncateToWidth(" " + content, innerW, "…", true) + border("│");
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Top border with title
		const titleText = " Skills ";
		const borderLen = innerW - visLen(titleText);
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border("╭" + "─".repeat(leftBorder)) + title(titleText) + border("─".repeat(rightBorder) + "╮"));

		// Search input - clean underlined style
		const cursor = selected("│");
		const searchIconChar = searchIcon("◎");
		const queryDisplay = this.query
			? `${this.query}${cursor}`
			: `${cursor}${placeholder(italic("type to filter..."))}`;
		lines.push(row(`${searchIconChar}  ${queryDisplay}`));

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		// Skills list
		const maxVisible = 8;
		const startIndex = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

		if (this.filtered.length === 0) {
			lines.push(row(hint(italic("No matching skills"))));
		} else {
			for (let i = startIndex; i < endIndex; i++) {
				const skill = this.filtered[i];
				const isSelected = i === this.selected;
				const isLocked = this.lockedSkills.has(skill.name);
				const isChecked = isLocked || this.selectedSkills.has(skill.name);
				const isFavorite = this.favorites.has(skill.name);

				const prefix = isSelected ? selected("▸") : border("·");
				const checkMark = isChecked ? (isLocked ? hint("✓") : queued("✓")) : " ";
				const nameRaw = isSelected ? bold(skill.name) : skill.name;
				const nameColored = isLocked
					? hint(nameRaw)
					: isSelected
						? selectedText(nameRaw)
						: nameRaw;
				const favoriteBadge = isFavorite ? hint(" ★") : "";
				const nameSegment = `${nameColored}${favoriteBadge}`;

				const baseSegment = `${prefix} ${checkMark} ${nameSegment}`;
				const baseWidth = visLen(baseSegment);
				const maxDescLen = Math.max(0, innerW - baseWidth - 6);
				const descColor = isLocked ? hint : description;
				const descText = skill.category
					? `[${skill.category}] ${skill.description}`
					: skill.description;
				const descStr = maxDescLen > 3 ? descColor(truncateToWidth(descText, maxDescLen, "…")) : "";
				const separator = descStr ? `  ${border("—")}  ` : "";
				const skillLine = `${baseSegment}${separator}${descStr}`;
				lines.push(row(skillLine));
			}

			if (this.filtered.length > maxVisible) {
				const prog = Math.round(((this.selected + 1) / this.filtered.length) * 10);
				const bar = progressBar(prog, 10, t);
				const countStr = `${this.selected + 1}/${this.filtered.length}`;
				lines.push(row(`${bar}  ${hint(countStr)}`));
			}
		}

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		// Footer hints - minimal and elegant
		const hints = `${italic("↑↓")} navigate  ${italic("space")} toggle  ${italic("enter")} apply  ${italic("esc")} cancel`;
		lines.push(row(hint(hints)));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.cleanup();
	}
}

let allSkills: Skill[] = [];
let skillsByName = new Map<string, Skill>();
let scanRoots: string[] = [];
let autoSkillNames = new Set<string>();
let selectedSkillNames = new Set<string>();
let favorites = new Set<string>();
let config: SkillBrowserConfig = {};
let lastPersistedSelection: Set<string> | null = null;
let registeredCustomSkillCommands = new Set<string>();

export function getSkillIndex(): SkillIndex {
	return {
		skills: [...allSkills],
		byName: new Map(skillsByName),
		roots: [...scanRoots],
	};
}

function getActiveSkills(): Skill[] {
	return allSkills.filter((skill) => autoSkillNames.has(skill.name) || selectedSkillNames.has(skill.name));
}

function getSelectedSkills(): Skill[] {
	return allSkills.filter((skill) => selectedSkillNames.has(skill.name));
}

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.ui) return;

	const activeSkills = getActiveSkills();
	const availableCount = allSkills.length;

	if (activeSkills.length === 0 && availableCount === 0) {
		ctx.ui.setStatus("skill", undefined);
		ctx.ui.setWidget("skill", undefined);
		return;
	}

	const activeCount = activeSkills.length;
	// Show: "5 skills (86 available)" or just "86 skills available" if none active
	const display = activeCount > 0
		? `${activeCount} skill${activeCount !== 1 ? "s" : ""} (${availableCount} available)`
		: `${availableCount} skill${availableCount !== 1 ? "s" : ""} available`;

	ctx.ui.setStatus("skill", `skills: ${display}`);
	ctx.ui.setWidget("skill", undefined);
}

function hasSelectableSkill(name: string): boolean {
	return skillsByName.has(name) && !autoSkillNames.has(name);
}

function setSelectedSkills(next: Set<string>): void {
	selectedSkillNames = new Set(next);
}

function skillsChanged(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return true;
	for (const value of a) {
		if (!b.has(value)) return true;
	}
	return false;
}

function buildSkillBlock(skill: Skill): string {
	const directory = skill.directory || (skill.filePath ? path.dirname(skill.filePath) : "");
	const directoryAttr = directory ? ` directory="${directory}"` : "";
	const locationHint = directory
		? `IMPORTANT: This skill is located at: ${directory}\nAll relative paths in this skill (like ./script.sh or ./references/doc.md) must be resolved relative to ${directory}\nFor example: ./server.sh means ${directory}/server.sh\n\n`
		: "";
	const content = getSkillContent(skill);
	return `<skill name="${skill.name}"${directoryAttr}>\n${locationHint}${content}\n</skill>`;
}

function buildSkillInvocationPrompt(skill: Skill, args: string): string {
	const content = getSkillContent(skill);
	const trimmedArgs = args.trim();
	if (!trimmedArgs) return content;
	return `${content}\n\nUser: ${trimmedArgs}`;
}

function registerEnabledSkillCommands(pi: ExtensionAPI, names?: Iterable<string>): void {
	const existing = new Set(pi.getCommands().map((command) => command.name));
	const enabledNames = names ? Array.from(names) : Array.from(selectedSkillNames);

	for (const name of enabledNames) {
		const skill = skillsByName.get(name);
		if (!skill || skill.origin !== "custom") continue;

		const commandName = `skill:${skill.name}`;
		if (existing.has(commandName) || registeredCustomSkillCommands.has(commandName)) continue;

		pi.registerCommand(commandName, {
			description: skill.description || `Load skill ${skill.name}`,
			handler: async (args: string, ctx: ExtensionContext) => {
				if (!selectedSkillNames.has(skill.name)) {
					ctx.ui?.notify(`Skill ${skill.name} is disabled in /skill. Re-enable it to use this command.`, "warning");
					return;
				}

				const selected = skillsByName.get(skill.name);
				if (!selected?.filePath) return;
				await pi.sendUserMessage(buildSkillInvocationPrompt(selected, args));
			},
		});

		registeredCustomSkillCommands.add(commandName);
		existing.add(commandName);
	}
}

function persistSelectedSkills(pi: ExtensionAPI): void {
	if (!lastPersistedSelection || skillsChanged(lastPersistedSelection, selectedSkillNames)) {
		pi.appendEntry("skill-browser-state", { active: Array.from(selectedSkillNames) });
		lastPersistedSelection = new Set(selectedSkillNames);
	}
}

export default function skillPaletteExtension(pi: ExtensionAPI): void {
	// Register the /skill command
	pi.registerCommand("skill", {
		description: "Open skill palette to select skills",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (allSkills.length === 0) {
				ctx.ui.setStatus("skill", "No skills found");
				setTimeout(() => ctx.ui.setStatus("skill", undefined), 3000);
				return;
			}

			const draftSelected = new Set(selectedSkillNames);
			const result = await ctx.ui.custom<"apply" | "cancel">(
				(tui, _theme, _keybindings, done) => {
					const palette = new SkillPaletteComponent(allSkills, draftSelected, autoSkillNames, favorites, done);
					palette.setRequestRender(() => tui.requestRender());
					return palette;
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: 70 } },
			);

			if (result === "apply") {
				const previousSelected = new Set(selectedSkillNames);
				const nextSelected = new Set(Array.from(draftSelected).filter((name) => hasSelectableSkill(name)));
				const changed = skillsChanged(previousSelected, nextSelected);
				setSelectedSkills(nextSelected);

				if (changed) {
					registerEnabledSkillCommands(pi, nextSelected);
					persistSelectedSkills(pi);
					updateStatus(ctx);

					const disabled = Array.from(previousSelected).filter((name) => !nextSelected.has(name));
					if (disabled.length > 0) {
						ctx.ui?.notify("Disabled skill commands are removed from /command after /reload.", "info");
					}
				}
			}
		},
	});

	// Inject selected skill content into the system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		const selectedSkills = getSelectedSkills();
		if (selectedSkills.length === 0) {
			return {};
		}

		const skillBlocks: string[] = [];
		for (const skill of selectedSkills) {
			if (!skill.filePath) {
				ctx.ui?.notify(`Missing skill file for: ${skill.name}`, "warning");
				continue;
			}

			try {
				skillBlocks.push(buildSkillBlock(skill));
			} catch {
				ctx.ui?.notify(`Failed to load skill: ${skill.name}`, "warning");
			}
		}

		if (skillBlocks.length === 0) {
			return {};
		}

		const skillSection = `\n<active_skills>\nThe following skills were explicitly selected in the skill palette. Follow their instructions when relevant to the user's request.\n\nCRITICAL: Each skill has a \"directory\" attribute showing its absolute path. Any relative paths mentioned in the skill content (scripts, references, etc.) MUST be resolved relative to that skill's directory.\n\n${skillBlocks.join("\n\n")}\n</active_skills>`;

		return {
			systemPrompt: `${event.systemPrompt}${skillSection}`,
		};
	});

	// Initialize on session start
	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		favorites = new Set(config.favorites ?? []);

		scanRoots = resolveConfigPaths(config.paths, ctx.cwd);
		const commandSkills = loadAutoSkillsFromCommands(pi.getCommands() as SlashCommandInfo[]);
		const loaded = loadSkills(ctx.cwd, config, commandSkills, scanRoots);
		allSkills = loaded.skills;
		skillsByName = loaded.skillsByName;
		autoSkillNames = loaded.autoSkillNames;
		setSelectedSkills(new Set());

		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "skill-browser-state")
			.pop() as { data?: { active: string[] } } | undefined;

		if (stateEntry?.data?.active) {
			const valid = stateEntry.data.active.filter((name) => hasSelectableSkill(name));
			setSelectedSkills(new Set(valid));
		} else if (config.defaultActive && config.defaultActive.length > 0) {
			const validDefaults = config.defaultActive.filter((name) => hasSelectableSkill(name));
			setSelectedSkills(new Set(validDefaults));
		}

		registerEnabledSkillCommands(pi, selectedSkillNames);
		lastPersistedSelection = new Set(selectedSkillNames);

		updateStatus(ctx);

		if (allSkills.length > 0 && ctx.ui) {
			ctx.ui.notify(`Indexed ${allSkills.length} skills. Use /skill to browse.`, "info");
		}
	});

	// Persist state on turn start
	pi.on("turn_start", async () => {
		persistSelectedSkills(pi);
	});
}
