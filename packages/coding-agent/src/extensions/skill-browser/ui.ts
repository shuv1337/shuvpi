import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Component, Input, type KeybindingsManager, truncateToWidth } from "@shuv1337/shuvpi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type BrowserSkill, sortSkills } from "./model.ts";

type SkillStyle = "title" | "selected" | "description" | "hint";
export type SkillBrowserStyles = Partial<Record<SkillStyle, string>>;

export function loadSkillBrowserStyles(agentDir: string): SkillBrowserStyles {
	const path = join(agentDir, "extensions", "skill-browser", "theme.json");
	if (!existsSync(path)) return {};
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid skill browser theme: ${path}`);
	const styles: SkillBrowserStyles = {};
	for (const key of ["title", "selected", "description", "hint"] as const) {
		const value = (raw as Record<string, unknown>)[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !/^\d+(;\d+)*$/.test(value))
			throw new Error(`Invalid skill browser theme color: ${key}`);
		styles[key] = value;
	}
	return styles;
}

interface SkillPickerOptions {
	skills: BrowserSkill[];
	favorites: string[];
	selected?: string[];
	styles?: SkillBrowserStyles;
	onFavorite(name: string): string[];
	onError?(error: unknown): void;
	onConfirm(names: string[]): void;
	onCancel(): void;
}

/** Shared search UI; active selection is owned by the optional extension. */
export class SkillPicker implements Component {
	private readonly options: SkillPickerOptions;
	private readonly tui: { terminal: { rows: number }; requestRender(): void };
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly search = new Input({ prompt: "Search: ", placeholder: "Skills" });
	private readonly selected: Set<string>;
	private favorites: string[];
	private cursor = 0;

	constructor(
		options: SkillPickerOptions,
		tui: { terminal: { rows: number }; requestRender(): void },
		theme: Theme,
		keys: KeybindingsManager,
	) {
		this.options = options;
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.favorites = [...options.favorites];
		this.selected = new Set(options.selected);
	}

	private filtered(): BrowserSkill[] {
		const query = this.search.getValue().toLowerCase();
		return sortSkills(this.options.skills, this.favorites).filter((skill) =>
			`${skill.name} ${skill.category} ${skill.description}`.toLowerCase().includes(query),
		);
	}

	handleInput(data: string): void {
		const skills = this.filtered();
		const skill = skills[this.cursor];
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		if (this.keys.matches(data, "tui.select.confirm")) {
			if (this.options.selected !== undefined) this.options.onConfirm([...this.selected]);
			else if (skill) this.options.onConfirm([skill.name]);
			return;
		}
		if (this.keys.matches(data, "app.skillBrowser.favorite")) {
			if (skill) {
				try {
					this.favorites = this.options.onFavorite(skill.name);
					this.cursor = this.filtered().findIndex((candidate) => candidate.name === skill.name);
				} catch (error) {
					this.options.onError?.(error);
				}
			}
		} else if (this.options.selected !== undefined && this.keys.matches(data, "app.activeSkills.toggle")) {
			if (skill) {
				if (this.selected.has(skill.name)) this.selected.delete(skill.name);
				else this.selected.add(skill.name);
			}
		} else if (this.keys.matches(data, "tui.select.up")) this.cursor--;
		else if (this.keys.matches(data, "tui.select.down")) this.cursor++;
		else if (this.keys.matches(data, "tui.select.pageUp")) this.cursor -= Math.max(1, this.tui.terminal.rows - 5);
		else if (this.keys.matches(data, "tui.select.pageDown")) this.cursor += Math.max(1, this.tui.terminal.rows - 5);
		else {
			this.search.handleInput(data);
			this.cursor = 0;
		}
		this.cursor = Math.max(0, Math.min(this.cursor, this.filtered().length - 1));
		this.tui.requestRender();
	}

	private color(key: SkillStyle, text: string): string {
		const custom = this.options.styles?.[key];
		if (custom) return `\x1b[${custom}m${text}\x1b[0m`;
		return this.theme.fg(
			key === "title" || key === "selected" ? "accent" : key === "description" ? "muted" : "dim",
			text,
		);
	}

	render(width: number): string[] {
		if (width <= 0 || this.tui.terminal.rows <= 0) return [];
		const skills = this.filtered();
		this.cursor = Math.max(0, Math.min(this.cursor, skills.length - 1));
		const pageSize = Math.max(1, this.tui.terminal.rows - 5);
		const start = Math.max(0, this.cursor - pageSize + 1);
		const rows = skills.slice(start, start + pageSize).map((skill, i) => {
			const marker =
				this.options.selected === undefined
					? this.favorites.includes(skill.name)
						? "* "
						: "  "
					: this.selected.has(skill.name)
						? "[x] "
						: "[ ] ";
			const text = `${start + i === this.cursor ? "> " : "  "}${marker}${skill.name}${skill.category ? ` · ${skill.category}` : ""}`;
			return start + i === this.cursor ? this.color("selected", text) : text;
		});
		const hint = [
			`${this.keys.getKeys("tui.select.confirm").join("/")} ${this.options.selected === undefined ? "insert" : "apply"}`,
			`${this.keys.getKeys("tui.select.cancel").join("/")} cancel`,
			`${this.keys.getKeys("app.skillBrowser.favorite").join("/")} favorite`,
			...(this.options.selected === undefined
				? []
				: [`${this.keys.getKeys("app.activeSkills.toggle").join("/")} toggle`]),
		].join("  ");
		return [
			this.color("title", this.options.selected === undefined ? "Skills" : `Active skills (${this.selected.size})`),
			...this.search.render(width),
			...(rows.length ? rows : [this.color("description", "No matching skills")]),
			this.color("description", skills[this.cursor]?.description ?? ""),
			this.color("hint", `${skills.length} skills  ${hint}`),
		]
			.slice(0, this.tui.terminal.rows)
			.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.search.invalidate();
	}
}
