import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getThemeByName,
	setRegisteredThemes,
	setTheme,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-json.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

describe("theme picker", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-picker-"));
		const agentDir = join(tempRoot, "agent");
		vi.stubEnv("SHUVPI_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		setRegisteredThemes([]);
	});

	afterEach(() => {
		setRegisteredThemes([]);
		rmSync(tempRoot, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it.each(["nightowl", "nightowl-light"])("selects the built-in %s theme and resolves its palette", (name) => {
		const source = getAvailableThemesWithPaths().find((entry) => entry.name === name);
		expect(source?.path).toBeDefined();
		const json = validateThemeJson(name, JSON.parse(readFileSync(source!.path!, "utf8")));
		expect(json.name).toBe(name);
		expect(setTheme(name)).toEqual({ success: true });
		expect(theme.name).toBe(name);
		expect(getThemeByName(name)?.appearance).toBe(name === "nightowl" ? "dark" : "light");
		for (const token of ["thinkingXhigh", "thinkingMax", "toolOutput", "toolDiffAdded", "toolDiffRemoved"] as const) {
			expect(theme.fg(token, "sample")).toContain("sample");
			expect(theme.colors[token]).toBeDefined();
		}
	});

	it("uses custom theme content names instead of file names", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "bar",
		};

		const themePath = join(process.env.SHUVPI_CODING_AGENT_DIR!, "themes", "foo.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		expect(getAvailableThemes()).toContain("bar");
		expect(getAvailableThemes()).not.toContain("foo");
		expect(getAvailableThemesWithPaths()).toContainEqual({ name: "bar", path: themePath });
		expect(getAvailableThemesWithPaths().some((theme) => theme.name === "foo")).toBe(false);
	});
});
