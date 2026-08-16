/**
 * Open in Editor Extension
 *
 * Makes file paths from session history selectable and opens them in a configurable editor.
 *
 * Features:
 * - /open command: Fuzzy-searchable file path picker from session history
 * - ctrl+shift+o shortcut: Quick access to the same picker (avoids ctrl+o conflict)
 * - Extracts paths from tool calls, tool results, and message text
 * - Handles quoted paths, spaces, ~ expansion, symlinks, and :line[:col] suffixes
 * - Supports directory paths and argument tab-completion for /open
 * - Configurable editor: VS Code (default), terminal editors (vim/nvim/hx/etc.), or "auto" ($VISUAL/$EDITOR)
 * - Terminal editors open in tmux/zellij panes when available
 *
 * Config (three-level merge):
 * 1. .shuvpi/pi-open-in-editor.json (project)
 * 2. ~/.shuvpi/agent/pi-open-in-editor.json (global)
 * 3. ~/.shuvpi/agent/settings.json → "openInEditor" key
 * 4. Defaults: { editor: "vscode" }
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@shuv1337/shuvpi-coding-agent";
import { matchesKey, truncateToWidth, type AutocompleteItem, visibleWidth } from "@shuv1337/shuvpi-tui";
import type { Component } from "@shuv1337/shuvpi-tui";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

type PathKind = "file" | "directory" | "missing";

interface ExtractedPath {
	absolutePath: string;
	displayPath: string;
	line?: number;
	col?: number;
	source: string;
	timestamp: number;
	exists: boolean;
	kind: PathKind;
	dedupeKey: string;
}

interface EditorConfig {
	editor: string;
}

interface EditorDef {
	displayName: string;
	gui: boolean;
	buildArgs(filePath: string, line?: number, col?: number): string[];
}

const KNOWN_EDITORS: Record<string, EditorDef> = {
	code: {
		displayName: "VS Code",
		gui: true,
		buildArgs: (p, l, c) => l ? ["-g", `${p}:${l}${c ? `:${c}` : ""}`] : [p],
	},
	"code-insiders": {
		displayName: "VS Code Insiders",
		gui: true,
		buildArgs: (p, l, c) => l ? ["-g", `${p}:${l}${c ? `:${c}` : ""}`] : [p],
	},
	cursor: {
		displayName: "Cursor",
		gui: true,
		buildArgs: (p, l, c) => l ? ["-g", `${p}:${l}${c ? `:${c}` : ""}`] : [p],
	},
	zed: {
		displayName: "Zed",
		gui: true,
		buildArgs: (p, l, c) => l ? [`${p}:${l}${c ? `:${c}` : ""}`] : [p],
	},
	subl: {
		displayName: "Sublime Text",
		gui: true,
		buildArgs: (p, l, c) => l ? [`${p}:${l}${c ? `:${c}` : ""}`] : [p],
	},
	vim: {
		displayName: "Vim",
		gui: false,
		buildArgs: (p, l) => l ? [`+${l}`, p] : [p],
	},
	nvim: {
		displayName: "Neovim",
		gui: false,
		buildArgs: (p, l) => l ? [`+${l}`, p] : [p],
	},
	vi: {
		displayName: "Vi",
		gui: false,
		buildArgs: (p, l) => l ? [`+${l}`, p] : [p],
	},
	hx: {
		displayName: "Helix",
		gui: false,
		buildArgs: (p, l, c) => l ? [`${p}:${l}${c ? `:${c}` : ""}`] : [p],
	},
	helix: {
		displayName: "Helix",
		gui: false,
		buildArgs: (p, l, c) => l ? [`${p}:${l}${c ? `:${c}` : ""}`] : [p],
	},
	nano: {
		displayName: "Nano",
		gui: false,
		buildArgs: (p, l, c) => l ? [`+${l}${c ? `,${c}` : ""}`, p] : [p],
	},
	emacs: {
		displayName: "Emacs",
		gui: false,
		buildArgs: (p, l, c) => l ? [`+${l}${c ? `:${c}` : ""}`, p] : [p],
	},
	micro: {
		displayName: "Micro",
		gui: false,
		buildArgs: (p, l) => l ? [`+${l}`, p] : [p],
	},
	"xdg-open": {
		displayName: "System Default",
		gui: true,
		buildArgs: (p) => [p],
	},
	open: {
		displayName: "System Default",
		gui: true,
		buildArgs: (p) => [p],
	},
};

const DEFAULT_EDITOR_CONFIG: EditorConfig = { editor: "vscode" };

function readJsonFile(filePath: string): Record<string, unknown> | null {
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function loadEditorConfig(cwd: string): EditorConfig {
	const projectPath = path.join(cwd, ".shuvpi", "pi-open-in-editor.json");
	const extensionGlobalPath = path.join(homedir(), ".shuvpi", "agent", "pi-open-in-editor.json");
	const mainSettingsPath = path.join(homedir(), ".shuvpi", "agent", "settings.json");

	let settingsConfig: Partial<EditorConfig> = {};
	const mainSettings = readJsonFile(mainSettingsPath);
	if (mainSettings && typeof mainSettings.openInEditor === "object" && mainSettings.openInEditor !== null) {
		settingsConfig = mainSettings.openInEditor as Partial<EditorConfig>;
	}

	const extensionConfig = readJsonFile(extensionGlobalPath) as Partial<EditorConfig> | null;
	const projectConfig = readJsonFile(projectPath) as Partial<EditorConfig> | null;

	const merged = { ...DEFAULT_EDITOR_CONFIG, ...settingsConfig, ...(extensionConfig ?? {}), ...(projectConfig ?? {}) };
	return { editor: typeof merged.editor === "string" ? merged.editor : DEFAULT_EDITOR_CONFIG.editor };
}

function resolveEditor(config: EditorConfig): { command: string; def: EditorDef } {
	if (config.editor === "vscode") {
		return { command: "code", def: KNOWN_EDITORS.code };
	}

	if (config.editor === "auto") {
		const envEditor = process.env.VISUAL || process.env.EDITOR;
		if (envEditor) {
			const command = path.basename(envEditor);
			const def = KNOWN_EDITORS[command];
			if (def) return { command, def };
			return { command, def: { displayName: command, gui: false, buildArgs: (p) => [p] } };
		}
		const fallback = process.platform === "darwin" ? "open" : "xdg-open";
		return { command: fallback, def: KNOWN_EDITORS[fallback] };
	}

	const command = config.editor;
	const def = KNOWN_EDITORS[command];
	if (def) return { command, def };
	return { command, def: { displayName: command, gui: false, buildArgs: (p) => [p] } };
}

interface ExtensionState {
	cache?: {
		signature: string;
		paths: ExtractedPath[];
	};
	recentPaths: Map<string, ExtractedPath>;
	lastCollectedPaths: ExtractedPath[];
	currentCwd: string;
	editorConfig: EditorConfig;
}

const MAX_TEXT_SCAN_CHARS = 100_000;
const MAX_RECENT_PATHS = 300;
const MAX_COMPLETION_ITEMS = 20;

const WINDOWS_ABSOLUTE_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const URL_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;
const POSITION_SUFFIX_PATTERN = /^(.*?)(?::(\d+))(?::(\d+))?:?$/;

function parseTimestamp(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

function splitDisplayPath(displayPath: string): { dir: string; base: string } {
	const normalized = displayPath.replace(/\\/g, "/");
	const trimmed = normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	const idx = trimmed.lastIndexOf("/");
	if (idx < 0) return { dir: ".", base: trimmed || displayPath };
	const dir = idx === 0 ? "/" : trimmed.slice(0, idx);
	const base = trimmed.slice(idx + 1) || trimmed;
	return { dir, base };
}

function isCaseInsensitivePath(p: string): boolean {
	return process.platform === "win32" || WINDOWS_ABSOLUTE_PATTERN.test(p);
}

function toDedupeKey(p: string): string {
	const normalized = WINDOWS_ABSOLUTE_PATTERN.test(p) && process.platform !== "win32"
		? p.replace(/\//g, "\\")
		: path.normalize(p);
	return isCaseInsensitivePath(normalized) ? normalized.toLowerCase() : normalized;
}

function toDisplayPath(absolutePath: string, cwd: string): string {
	if (WINDOWS_ABSOLUTE_PATTERN.test(absolutePath) && process.platform !== "win32") return absolutePath;
	try {
		const relative = path.relative(cwd, absolutePath);
		if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
		if (relative === "") return ".";
	} catch {
		// Fall back to absolute path.
	}
	return absolutePath;
}

function pathStats(absolutePath: string): { exists: boolean; kind: PathKind; canonicalPath: string } {
	try {
		const stats = statSync(absolutePath);
		let canonicalPath = absolutePath;
		try {
			canonicalPath = realpathSync(absolutePath);
		} catch {
			// Keep resolved path if realpath fails.
		}
		return {
			exists: true,
			kind: stats.isDirectory() ? "directory" : "file",
			canonicalPath,
		};
	} catch {
		return { exists: false, kind: "missing", canonicalPath: absolutePath };
	}
}

function tokenizeText(text: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | "`" | null = null;
	let escaping = false;

	const flush = () => {
		const trimmed = token.trim();
		if (trimmed) tokens.push(trimmed);
		token = "";
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (escaping) {
			token += ch;
			escaping = false;
			continue;
		}

		if (ch === "\\") {
			const next = text[i + 1];
			if (quote || (next && /\s/.test(next))) {
				escaping = true;
				continue;
			}
			token += ch;
			continue;
		}

		if (quote) {
			if (ch === quote) {
				flush();
				quote = null;
			} else {
				token += ch;
			}
			continue;
		}

		if (ch === '"' || ch === "'" || ch === "`") {
			flush();
			quote = ch;
			continue;
		}

		if (/\s/.test(ch)) {
			flush();
			continue;
		}

		token += ch;
	}

	flush();
	return tokens;
}

function normalizeCandidateToken(rawToken: string): string {
	let token = rawToken.trim();
	if (!token) return "";

	token = token.replace(/^[@]+/, "");
	token = token.replace(/\\ /g, " ");

	while (/^[([{<"'`]/.test(token)) token = token.slice(1);
	while (/[)\]}>,"'`;!?]$/.test(token)) token = token.slice(0, -1);
	while (token.endsWith(".") && token.length > 1) token = token.slice(0, -1);

	const keyValue = token.match(/^[A-Za-z_][A-Za-z0-9_-]{1,32}[:=](.+)$/);
	if (keyValue?.[1]) token = keyValue[1].trim();

	return token;
}

function looksLikePathCandidate(value: string, allowBareFileNames: boolean): boolean {
	if (!value) return false;
	if (value.includes("\0")) return false;
	if (URL_PATTERN.test(value)) return false;
	if (/^--?[A-Za-z0-9]/.test(value)) return false;
	if (/[*?{}]/.test(value)) return false;

	if (value === "~") return true;
	if (/^~[\\/]/.test(value)) return true;
	if (/^\.\.?(?:[\\/]|$)/.test(value)) return true;
	if (WINDOWS_ABSOLUTE_PATTERN.test(value)) return true;
	if (value.includes("/") || value.includes("\\")) return true;
	if (allowBareFileNames && /^[^\\/:*?"<>|\s][^\\/:*?"<>|]*\.[A-Za-z0-9]{1,16}$/.test(value)) return true;

	return false;
}

function decodeFileUri(fileUri: string): string | null {
	try {
		const uri = new URL(fileUri);
		if (uri.protocol !== "file:") return null;
		let decoded = decodeURIComponent(uri.pathname);
		if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
		if (process.platform === "win32") decoded = decoded.replace(/\//g, "\\");
		return decoded;
	} catch {
		return null;
	}
}

function parsePathAndPosition(rawValue: string, allowBareFileNames: boolean): { pathValue: string; line?: number; col?: number } | null {
	let value = normalizeCandidateToken(rawValue);
	if (!value) return null;

	if (value.startsWith("file://")) {
		const decoded = decodeFileUri(value);
		if (!decoded) return null;
		value = decoded;
	}

	let line: number | undefined;
	let col: number | undefined;

	const match = value.match(POSITION_SUFFIX_PATTERN);
	if (match) {
		const maybePath = match[1];
		const parsedLine = Number.parseInt(match[2], 10);
		const parsedCol = match[3] ? Number.parseInt(match[3], 10) : undefined;
		if (
			Number.isFinite(parsedLine)
			&& parsedLine > 0
			&& looksLikePathCandidate(maybePath, allowBareFileNames)
		) {
			value = maybePath;
			line = parsedLine;
			if (parsedCol && Number.isFinite(parsedCol) && parsedCol > 0) col = parsedCol;
		}
	}

	if (!looksLikePathCandidate(value, allowBareFileNames)) return null;
	return { pathValue: value, line, col };
}

function resolvePathValue(pathValue: string, cwd: string): string {
	let normalized = pathValue;

	if (normalized === "~") {
		normalized = homedir();
	} else if (/^~[\\/]/.test(normalized)) {
		normalized = path.join(homedir(), normalized.slice(2));
	}

	if (WINDOWS_ABSOLUTE_PATTERN.test(normalized) && process.platform !== "win32") {
		return normalized.replace(/\//g, "\\");
	}

	if (path.isAbsolute(normalized)) return path.normalize(normalized);
	return path.resolve(cwd, normalized);
}

function buildExtractedPath(
	rawValue: string,
	cwd: string,
	source: string,
	timestamp: number,
	options: { allowBareFileNames?: boolean; line?: number; col?: number } = {},
): ExtractedPath | null {
	const parsed = parsePathAndPosition(rawValue, options.allowBareFileNames ?? false);
	if (!parsed) return null;

	const absolutePath = resolvePathValue(parsed.pathValue, cwd);
	const { exists, kind, canonicalPath } = pathStats(absolutePath);
	const dedupeKey = toDedupeKey(exists ? canonicalPath : absolutePath);

	return {
		absolutePath,
		displayPath: toDisplayPath(absolutePath, cwd),
		line: options.line ?? parsed.line,
		col: options.col ?? parsed.col,
		source,
		timestamp,
		exists,
		kind,
		dedupeKey,
	};
}

function mergeExtractedPath(map: Map<string, ExtractedPath>, next: ExtractedPath): void {
	const current = map.get(next.dedupeKey);
	if (!current) {
		map.set(next.dedupeKey, next);
		return;
	}

	const preferNext = next.timestamp > current.timestamp || (!current.exists && next.exists);
	if (preferNext) {
		map.set(next.dedupeKey, {
			...next,
			line: next.line ?? current.line,
			col: next.col ?? current.col,
		});
		return;
	}

	if (!current.line && next.line) current.line = next.line;
	if (!current.col && next.col) current.col = next.col;
	if (current.source === "assistant" && next.source !== "assistant") current.source = next.source;
	if (!current.exists && next.exists) {
		current.exists = true;
		current.kind = next.kind;
	}
}

function sortPaths(paths: ExtractedPath[]): void {
	const group = (p: ExtractedPath): number => {
		if (p.exists && p.kind === "file") return 0;
		if (p.exists && p.kind === "directory") return 1;
		return 2;
	};

	paths.sort((a, b) => {
		const ga = group(a);
		const gb = group(b);
		if (ga !== gb) return ga - gb;
		if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
		return a.displayPath.localeCompare(b.displayPath);
	});
}

function collectTextCandidates(text: string): string[] {
	const scanned = text.length > MAX_TEXT_SCAN_CHARS ? text.slice(0, MAX_TEXT_SCAN_CHARS) : text;
	const candidates = tokenizeText(scanned);

	for (const match of scanned.matchAll(/\(([^()\n]+)\)/g)) {
		const value = match[1];
		if (value.includes("/") || value.includes("\\")) candidates.push(value);
	}

	return candidates;
}

function extractPathsFromText(
	text: string,
	cwd: string,
	source: string,
	timestamp: number,
	allowBareFileNames = false,
): ExtractedPath[] {
	const deduped = new Map<string, ExtractedPath>();
	for (const candidate of collectTextCandidates(text)) {
		const extracted = buildExtractedPath(candidate, cwd, source, timestamp, { allowBareFileNames });
		if (!extracted) continue;
		mergeExtractedPath(deduped, extracted);
	}
	return Array.from(deduped.values());
}

function addPathFromUnknown(
	value: unknown,
	cwd: string,
	source: string,
	timestamp: number,
	target: Map<string, ExtractedPath>,
	options: { line?: number; col?: number } = {},
): void {
	if (typeof value === "string") {
		const extracted = buildExtractedPath(value, cwd, source, timestamp, { allowBareFileNames: true, ...options });
		if (extracted) mergeExtractedPath(target, extracted);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item !== "string") continue;
			const extracted = buildExtractedPath(item, cwd, source, timestamp, { allowBareFileNames: true, ...options });
			if (extracted) mergeExtractedPath(target, extracted);
		}
	}
}

function extractPathsFromToolArgs(
	args: Record<string, unknown>,
	toolName: string,
	cwd: string,
	timestamp: number,
): ExtractedPath[] {
	const deduped = new Map<string, ExtractedPath>();
	const source = toolName || "tool";
	const lineFromOffset = typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0
		? Math.trunc(args.offset)
		: undefined;

	switch (toolName) {
		case "read":
		case "write":
			addPathFromUnknown(args.path, cwd, source, timestamp, deduped, { line: lineFromOffset });
			addPathFromUnknown(args.filePath, cwd, source, timestamp, deduped);
			break;
		case "edit":
			addPathFromUnknown(args.path, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.file, cwd, source, timestamp, deduped);
			break;
		case "bash":
			if (typeof args.command === "string") {
				for (const extracted of extractPathsFromText(args.command, cwd, source, timestamp)) {
					mergeExtractedPath(deduped, extracted);
				}
			}
			if (typeof args.cmd === "string") {
				for (const extracted of extractPathsFromText(args.cmd, cwd, source, timestamp)) {
					mergeExtractedPath(deduped, extracted);
				}
			}
			break;
		case "grep":
			addPathFromUnknown(args.path, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.glob, cwd, source, timestamp, deduped);
			break;
		case "find":
		case "ls":
			addPathFromUnknown(args.path, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.paths, cwd, source, timestamp, deduped);
			break;
		default:
			addPathFromUnknown(args.path, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.file, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.filePath, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.dir, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.directory, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.target, cwd, source, timestamp, deduped);
			addPathFromUnknown(args.paths, cwd, source, timestamp, deduped);
			break;
	}

	return Array.from(deduped.values());
}

function extractPathsFromToolResult(content: unknown, toolName: string, cwd: string, timestamp: number): ExtractedPath[] {
	const deduped = new Map<string, ExtractedPath>();
	const source = `${toolName || "tool"} result`;

	const consumeText = (text: string) => {
		for (const extracted of extractPathsFromText(text, cwd, source, timestamp)) {
			mergeExtractedPath(deduped, extracted);
		}
	};

	if (typeof content === "string") {
		consumeText(content);
		return Array.from(deduped.values());
	}

	if (!Array.isArray(content)) return [];
	for (const block of content) {
		if (typeof block === "string") {
			consumeText(block);
			continue;
		}
		if (!block || typeof block !== "object") continue;
		const maybeText = block as { type?: unknown; text?: unknown };
		if (maybeText.type === "text" && typeof maybeText.text === "string") {
			consumeText(maybeText.text);
		}
	}

	return Array.from(deduped.values());
}

function extractPathsFromMessage(message: unknown, cwd: string, timestamp: number): ExtractedPath[] {
	if (!message || typeof message !== "object") return [];
	const msg = message as { role?: unknown; content?: unknown };
	if (!Array.isArray(msg.content)) return [];

	const roleSource = msg.role === "user" ? "user" : "assistant";
	const deduped = new Map<string, ExtractedPath>();

	for (const part of msg.content) {
		if (!part || typeof part !== "object") continue;
		const chunk = part as {
			type?: unknown;
			text?: unknown;
			input?: unknown;
			name?: unknown;
			toolName?: unknown;
			content?: unknown;
			tool_use_id?: unknown;
		};

		if (chunk.type === "text" && typeof chunk.text === "string") {
			for (const extracted of extractPathsFromText(chunk.text, cwd, roleSource, timestamp)) {
				mergeExtractedPath(deduped, extracted);
			}
		}

		if (chunk.type === "tool_use") {
			const toolName = typeof chunk.name === "string" ? chunk.name : "tool";
			const args = chunk.input && typeof chunk.input === "object" ? chunk.input as Record<string, unknown> : {};
			for (const extracted of extractPathsFromToolArgs(args, toolName, cwd, timestamp)) {
				mergeExtractedPath(deduped, extracted);
			}
		}

		if (chunk.type === "tool_result") {
			const toolName = typeof chunk.toolName === "string"
				? chunk.toolName
				: typeof chunk.name === "string"
					? chunk.name
					: typeof chunk.tool_use_id === "string"
						? chunk.tool_use_id
						: "tool";
			for (const extracted of extractPathsFromToolResult(chunk.content, toolName, cwd, timestamp)) {
				mergeExtractedPath(deduped, extracted);
			}
		}
	}

	return Array.from(deduped.values());
}

function buildEntriesSignature(ctx: ExtensionContext | ExtensionCommandContext): { signature: string; entries: readonly unknown[] } {
	const entries = ctx.sessionManager.getEntries();
	const last = entries.length > 0 ? entries[entries.length - 1] as { id?: unknown; timestamp?: unknown; type?: unknown } : undefined;
	const signature = [
		ctx.cwd,
		entries.length,
		typeof last?.id === "string" ? last.id : "",
		typeof last?.timestamp === "string" || typeof last?.timestamp === "number" ? String(last.timestamp) : "",
		typeof last?.type === "string" ? last.type : "",
	].join("|");
	return { signature, entries };
}

function collectAllPaths(ctx: ExtensionContext | ExtensionCommandContext, state: ExtensionState): ExtractedPath[] {
	const { signature, entries } = buildEntriesSignature(ctx);
	let basePaths: ExtractedPath[];

	if (state.cache?.signature === signature) {
		basePaths = state.cache.paths;
	} else {
		const deduped = new Map<string, ExtractedPath>();
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const msgEntry = entry as { type?: unknown; timestamp?: unknown; message?: unknown };
			if (msgEntry.type !== "message") continue;
			const timestamp = parseTimestamp(msgEntry.timestamp);
			for (const extracted of extractPathsFromMessage(msgEntry.message, ctx.cwd, timestamp)) {
				mergeExtractedPath(deduped, extracted);
			}
		}

		basePaths = Array.from(deduped.values());
		state.cache = { signature, paths: basePaths };
	}

	const merged = new Map<string, ExtractedPath>();
	for (const item of basePaths) mergeExtractedPath(merged, item);
	for (const item of state.recentPaths.values()) mergeExtractedPath(merged, item);

	const allPaths = Array.from(merged.values());
	sortPaths(allPaths);
	state.lastCollectedPaths = allPaths;
	state.currentCwd = ctx.cwd;
	return allPaths;
}

function resetState(state: ExtensionState, cwd: string): void {
	state.cache = undefined;
	state.recentPaths.clear();
	state.lastCollectedPaths = [];
	state.currentCwd = cwd;
}

function addRecentPaths(state: ExtensionState, paths: ExtractedPath[]): void {
	for (const extracted of paths) {
		const current = state.recentPaths.get(extracted.dedupeKey);
		if (!current || extracted.timestamp >= current.timestamp) {
			state.recentPaths.set(extracted.dedupeKey, extracted);
		}
	}

	while (state.recentPaths.size > MAX_RECENT_PATHS) {
		let oldestKey: string | undefined;
		let oldestTimestamp = Number.POSITIVE_INFINITY;
		for (const [key, value] of state.recentPaths) {
			if (value.timestamp < oldestTimestamp) {
				oldestTimestamp = value.timestamp;
				oldestKey = key;
			}
		}
		if (!oldestKey) break;
		state.recentPaths.delete(oldestKey);
	}
}

function formatPathForOpen(ep: ExtractedPath): string {
	const suffix = ep.kind === "directory" || !ep.line ? "" : `:${ep.line}${ep.col ? `:${ep.col}` : ""}`;
	const base = ep.kind === "directory" && !ep.displayPath.endsWith("/") && !ep.displayPath.endsWith("\\")
		? `${ep.displayPath}/`
		: ep.displayPath;
	return `${base}${suffix}`;
}

function parseDirectPathArgument(args: string, cwd: string): ExtractedPath | null {
	const timestamp = Date.now();
	const direct = buildExtractedPath(args, cwd, "command", timestamp, { allowBareFileNames: true });
	if (direct) return direct;
	const extracted = extractPathsFromText(args, cwd, "command", timestamp, true);
	return extracted[0] ?? null;
}

function getFilesystemCompletions(prefix: string, cwd: string, limit: number): AutocompleteItem[] {
	if (limit <= 0) return [];

	const normalizedPrefix = normalizeCandidateToken(prefix || ".");
	if (!normalizedPrefix) return [];
	if (!looksLikePathCandidate(normalizedPrefix, true)) return [];

	let expanded = normalizedPrefix;
	if (expanded === "~") {
		expanded = homedir();
	} else if (/^~[\\/]/.test(expanded)) {
		expanded = path.join(homedir(), expanded.slice(2));
	}

	if (WINDOWS_ABSOLUTE_PATTERN.test(expanded) && process.platform !== "win32") return [];

	const hasTrailingSlash = /[\\/]$/.test(expanded);
	const absoluteInput = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	const dirPath = hasTrailingSlash ? absoluteInput : path.dirname(absoluteInput);
	const namePrefix = hasTrailingSlash ? "" : path.basename(absoluteInput).toLowerCase();

	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}

	const sorted = entries
		.filter((entry) => !namePrefix || entry.name.toLowerCase().startsWith(namePrefix))
		.sort((a, b) => {
			if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

	const items: AutocompleteItem[] = [];
	for (const entry of sorted) {
		const full = path.join(dirPath, entry.name);
		const display = toDisplayPath(full, cwd);
		const value = entry.isDirectory() ? `${display}/` : display;
		items.push({
			value,
			label: value,
			description: entry.isDirectory() ? "directory" : "file",
		});
		if (items.length >= limit) break;
	}

	return items;
}

function getOpenArgumentCompletions(prefix: string, state: ExtensionState): AutocompleteItem[] | null {
	const query = normalizeCandidateToken(prefix).toLowerCase();
	const items: AutocompleteItem[] = [];
	const seenValues = new Set<string>();

	for (const ep of state.lastCollectedPaths) {
		const value = formatPathForOpen(ep);
		const haystackDisplay = value.toLowerCase();
		const haystackAbsolute = ep.absolutePath.toLowerCase();
		if (query && !haystackDisplay.includes(query) && !haystackAbsolute.includes(query)) continue;
		if (seenValues.has(value)) continue;
		seenValues.add(value);

		items.push({
			value,
			label: value,
			description: ep.kind === "directory" ? "session directory" : ep.kind === "file" ? "session file" : "session path",
		});
		if (items.length >= MAX_COMPLETION_ITEMS) break;
	}

	const fsCompletions = getFilesystemCompletions(prefix, state.currentCwd, MAX_COMPLETION_ITEMS - items.length);
	for (const item of fsCompletions) {
		if (seenValues.has(item.value)) continue;
		seenValues.add(item.value);
		items.push(item);
		if (items.length >= MAX_COMPLETION_ITEMS) break;
	}

	return items.length > 0 ? items : null;
}

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();

	if (lt.includes(lq)) {
		return 1000 + (lq.length / Math.max(lt.length, 1)) * 500;
	}

	const basename = lt.split(/[\\/]/).pop() || lt;
	if (basename.includes(lq)) {
		return 800 + (lq.length / Math.max(basename.length, 1)) * 400;
	}

	let score = 0;
	let qi = 0;
	let consecutive = 0;

	for (let ti = 0; ti < lt.length && qi < lq.length; ti++) {
		if (lt[ti] === lq[qi]) {
			score += 10 + consecutive * 5;
			if (
				ti === 0
				|| lt[ti - 1] === "/"
				|| lt[ti - 1] === "\\"
				|| lt[ti - 1] === "."
				|| lt[ti - 1] === "-"
				|| lt[ti - 1] === "_"
			) {
				score += 15;
			}
			consecutive++;
			qi++;
		} else {
			consecutive = 0;
		}
	}

	return qi === lq.length ? score : 0;
}

class PathPickerComponent implements Component {
	private readonly paths: ExtractedPath[];
	private filtered: ExtractedPath[];
	private selected = 0;
	private query = "";
	private scrollOffset = 0;
	private maxVisible = 12;
	private requestRender: (() => void) | null = null;

	private readonly editorDisplayName: string;

	constructor(
		paths: ExtractedPath[],
		private readonly done: (path: ExtractedPath | null) => void,
		editorDisplayName: string,
	) {
		this.paths = paths;
		this.filtered = paths;
		this.editorDisplayName = editorDisplayName;
	}

	setRequestRender(fn: () => void): void {
		this.requestRender = fn;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}

		if (matchesKey(data, "return")) {
			if (this.filtered.length === 0) {
				this.done(null);
				return;
			}
			this.done(this.filtered[this.selected] || null);
			return;
		}

		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.adjustScroll();
			this.requestRender?.();
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filtered.length === 0) {
				this.selected = 0;
			} else {
				this.selected = Math.min(this.filtered.length - 1, this.selected + 1);
			}
			this.adjustScroll();
			this.requestRender?.();
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

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.updateFilter();
			this.requestRender?.();
		}
	}

	private updateFilter(): void {
		if (!this.query.trim()) {
			this.filtered = this.paths;
		} else {
			const scored = this.paths
				.map((p) => {
					const score = Math.max(
						fuzzyScore(this.query, p.displayPath),
						fuzzyScore(this.query, p.absolutePath) * 0.8,
						fuzzyScore(this.query, p.source) * 0.3,
					);
					return { path: p, score };
				})
				.filter((item) => item.score > 0)
				.sort((a, b) => {
					if (a.score !== b.score) return b.score - a.score;
					if (a.path.exists !== b.path.exists) return a.path.exists ? -1 : 1;
					return b.path.timestamp - a.path.timestamp;
				});
			this.filtered = scored.map((item) => item.path);
		}

		this.selected = 0;
		this.scrollOffset = 0;
	}

	private adjustScroll(): void {
		if (this.selected < this.scrollOffset) {
			this.scrollOffset = this.selected;
		} else if (this.selected >= this.scrollOffset + this.maxVisible) {
			this.scrollOffset = this.selected - this.maxVisible + 1;
		}
	}

	render(width: number): string[] {
		const boxWidth = Math.max(40, Math.min(90, width - 2));
		const innerW = Math.max(20, boxWidth - 2);
		const lines: string[] = [];

		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
		const border = (s: string) => dim(s);

		const row = (content: string) => {
			const truncated = truncateToWidth(` ${content}`, innerW, "...");
			const padLen = Math.max(0, innerW - visibleWidth(truncated));
			return border("│") + truncated + " ".repeat(padLen) + border("│");
		};

		const titleText = ` Open in ${this.editorDisplayName} (${this.filtered.length}/${this.paths.length}) `;
		const bLen = Math.max(0, innerW - visibleWidth(titleText));
		const left = Math.floor(bLen / 2);
		const right = bLen - left;
		lines.push(border("╭" + "─".repeat(left)) + dim(titleText) + border("─".repeat(right) + "╮"));

		const cursor = cyan("│");
		const queryDisplay = this.query
			? `${this.query}${cursor}`
			: `${cursor}${dim(italic("type to filter..."))}`;
		lines.push(row(`${dim("◎")}  ${queryDisplay}`));
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		if (this.filtered.length === 0) {
			lines.push(row(dim(italic("No matching paths found"))));
		} else {
			const endIdx = Math.min(this.scrollOffset + this.maxVisible, this.filtered.length);
			for (let i = this.scrollOffset; i < endIdx; i++) {
				const ep = this.filtered[i];
				const isSelected = i === this.selected;
				const prefix = isSelected ? cyan("▸") : dim("·");
				const existsIndicator = !ep.exists ? red("○") : ep.kind === "directory" ? yellow("◆") : green("●");
				const { dir, base } = splitDisplayPath(ep.displayPath);
				const baseWithSlash = ep.kind === "directory" && !base.endsWith("/") ? `${base}/` : base;
				const pathDisplay = dir === "."
					? (isSelected ? cyan(bold(baseWithSlash)) : baseWithSlash)
					: (isSelected
						? dim(`${dir}/`) + cyan(bold(baseWithSlash))
						: dim(`${dir}/`) + baseWithSlash);
				const lineInfo = ep.line && ep.kind !== "directory" ? dim(`:${ep.line}${ep.col ? `:${ep.col}` : ""}`) : "";
				const sourceTag = dim(`[${ep.source}]`);
				lines.push(row(`${prefix} ${existsIndicator} ${pathDisplay}${lineInfo} ${sourceTag}`));
			}

			if (this.filtered.length > this.maxVisible) {
				lines.push(row(dim(`${this.selected + 1}/${this.filtered.length}`)));
			}
		}

		lines.push(border("├" + "─".repeat(innerW) + "┤"));
		lines.push(row(dim(`${italic("↑↓")} navigate  ${italic("enter")} open  ${italic("esc")} cancel`)));
		lines.push(border("╰" + "─".repeat(innerW) + "╯"));

		return lines;
	}

	invalidate(): void {}
}

function openInVSCodeLegacy(ep: ExtractedPath): { success: boolean; error?: string } {
	const candidates = process.platform === "win32"
		? ["code.cmd", "code", "code-insiders.cmd", "code-insiders"]
		: ["code", "code-insiders"];

	const openTarget = ep.line && ep.kind !== "directory"
		? `${ep.absolutePath}:${ep.line}${ep.col ? `:${ep.col}` : ""}`
		: ep.absolutePath;
	const args = ep.line && ep.kind !== "directory" ? ["-g", openTarget] : [openTarget];

	let lastError: string | undefined;
	for (const command of candidates) {
		const result = spawnSync(command, args, {
			stdio: "ignore",
			timeout: 5000,
			windowsHide: true,
		});

		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				lastError = `${command} not found`;
				continue;
			}
			return { success: false, error: result.error.message };
		}

		if (result.status === 0) return { success: true };
		lastError = `command "${command}" exited with code ${result.status ?? "unknown"}`;
	}

	return {
		success: false,
		error: lastError ?? "VS Code CLI not found. Install it via Command Palette: 'Shell Command: Install code command in PATH'.",
	};
}

function spawnGuiEditor(argv: string[]): { success: boolean; error?: string } {
	const [command, ...args] = argv;
	const result = spawnSync(command, args, {
		stdio: "ignore",
		timeout: 5000,
		windowsHide: true,
	});

	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { success: false, error: `${command} not found in PATH` };
		return { success: false, error: result.error.message };
	}

	if (result.status !== 0) {
		return { success: false, error: `"${command}" exited with code ${result.status ?? "unknown"}` };
	}

	return { success: true };
}

function openTerminalEditor(argv: string[]): { success: boolean; error?: string } {
	if (process.env.TMUX) {
		const result = spawnSync("tmux", ["split-window", "-h", ...argv], {
			stdio: "ignore",
			timeout: 5000,
		});
		if (result.error) return { success: false, error: result.error.message };
		if (result.status !== 0) return { success: false, error: `tmux split-window exited with code ${result.status}` };
		return { success: true };
	}

	if (process.env.ZELLIJ) {
		const result = spawnSync("zellij", ["action", "new-pane", "--", ...argv], {
			stdio: "ignore",
			timeout: 5000,
		});
		if (result.error) return { success: false, error: result.error.message };
		if (result.status !== 0) return { success: false, error: `zellij new-pane exited with code ${result.status}` };
		return { success: true };
	}

	return { success: false, error: `No multiplexer detected. Run manually: ${argv.join(" ")}` };
}

function openInEditor(ep: ExtractedPath, config: EditorConfig): { success: boolean; error?: string; displayName: string } {
	if (config.editor === "vscode") {
		const result = openInVSCodeLegacy(ep);
		return { ...result, displayName: "VS Code" };
	}

	const { command, def } = resolveEditor(config);
	const line = ep.kind !== "directory" ? ep.line : undefined;
	const col = ep.kind !== "directory" ? ep.col : undefined;
	const argv = [command, ...def.buildArgs(ep.absolutePath, line, col)];

	if (def.gui) {
		return { ...spawnGuiEditor(argv), displayName: def.displayName };
	}

	return { ...openTerminalEditor(argv), displayName: def.displayName };
}

async function showPathPicker(
	ctx: ExtensionContext | ExtensionCommandContext,
	state: ExtensionState,
): Promise<void> {
	if (!ctx.hasUI) return;

	const paths = collectAllPaths(ctx, state);
	if (paths.length === 0) {
		ctx.ui.notify("No file or directory paths found in session history.", "info");
		return;
	}

	const { def } = resolveEditor(state.editorConfig);

	const selected = await ctx.ui.custom<ExtractedPath | null>(
		(tui, _theme, _kb, done) => {
			const picker = new PathPickerComponent(paths, (result) => done(result), def.displayName);
			picker.setRequestRender(() => tui.requestRender());
			return picker;
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: 90 } },
	);

	if (!selected) return;

	if (!selected.exists) {
		const confirmed = await ctx.ui.confirm(
			"Path not found",
			`${selected.displayPath} does not exist on disk. Open anyway?`,
		);
		if (!confirmed) return;
	}

	const result = openInEditor(selected, state.editorConfig);
	if (result.success) {
		ctx.ui.notify(`Opened ${formatPathForOpen(selected)} in ${result.displayName}`, "info");
	} else {
		ctx.ui.notify(`Failed to open in ${result.displayName}: ${result.error}`, "error");
	}
}

export default function openInEditorExtension(pi: ExtensionAPI): void {
	const state: ExtensionState = {
		recentPaths: new Map(),
		lastCollectedPaths: [],
		currentCwd: process.cwd(),
		editorConfig: loadEditorConfig(process.cwd()),
	};

	pi.registerCommand("open", {
		description: "Open a file or directory path from session history in your configured editor",
		getArgumentCompletions: (prefix: string) => getOpenArgumentCompletions(prefix, state),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			state.currentCwd = ctx.cwd;

			if (args.trim()) {
				const parsed = parseDirectPathArgument(args.trim(), ctx.cwd);
				if (!parsed) {
					ctx.ui.notify("Could not parse a valid path from /open arguments.", "error");
					return;
				}

				const result = openInEditor(parsed, state.editorConfig);
				if (result.success) {
					ctx.ui.notify(`Opened ${formatPathForOpen(parsed)} in ${result.displayName}`, "info");
				} else {
					ctx.ui.notify(`Failed to open in ${result.displayName}: ${result.error}`, "error");
				}
				return;
			}

			await showPathPicker(ctx, state);
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Open file from session history in editor",
		handler: async (ctx: ExtensionContext) => {
			await showPathPicker(ctx, state);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		resetState(state, ctx.cwd);
		state.editorConfig = loadEditorConfig(ctx.cwd);
	});

	pi.on("session_switch", (_event, ctx) => {
		resetState(state, ctx.cwd);
		state.editorConfig = loadEditorConfig(ctx.cwd);
	});

	pi.on("session_shutdown", () => {
		resetState(state, process.cwd());
	});

	pi.on("tool_result", (event, ctx) => {
		state.currentCwd = ctx.cwd;
		const timestamp = Date.now();
		const fromArgs = extractPathsFromToolArgs(event.input ?? {}, event.toolName, ctx.cwd, timestamp);
		const fromResult = extractPathsFromToolResult(event.content, event.toolName, ctx.cwd, timestamp);
		addRecentPaths(state, [...fromArgs, ...fromResult]);
	});
}
