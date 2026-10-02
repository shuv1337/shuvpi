import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@shuv1337/shuvpi-ai/compat";
import { type Component, getKeybindings, isKeyRelease, truncateToWidth, visibleWidth } from "@shuv1337/shuvpi-tui";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals } from "../../core/usage-totals.ts";
import { CustomEditor } from "../../modes/interactive/components/custom-editor.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { GitStatusMonitor } from "./git-status.ts";
import {
	collectHiddenExtensionStatusKeys,
	getNotificationExtensionStatuses,
	mergeSegmentOptions,
	mergeSegmentsWithCustomItems,
	nextPowerlineSettingWithPreset,
	type PowerlineConfig,
	parsePowerlineConfig,
} from "./powerline-config.ts";
import { getPreset, PRESETS } from "./presets.ts";
import { renderSegment } from "./segments.ts";
import { getSeparator } from "./separators.ts";
import { getDefaultColors } from "./theme.ts";
import type { SegmentContext, StatusLinePreset } from "./types.ts";

const PRESET_NAMES = Object.keys(PRESETS) as StatusLinePreset[];

function readSettings(file: string): Record<string, unknown> {
	try {
		const data: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid settings in ${file}`);
		return data as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function mergedPowerline(base: unknown, override: unknown): unknown {
	if (override === undefined) return base;
	if (
		!base ||
		!override ||
		typeof base !== "object" ||
		typeof override !== "object" ||
		Array.isArray(base) ||
		Array.isArray(override)
	)
		return override;
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) result[key] = mergedPowerline(result[key], value);
	return result;
}

/** Fits the selected segments in two rows, including at widths smaller than one segment. */
export function renderPowerline(context: SegmentContext, config: PowerlineConfig, width: number): string[] {
	if (width <= 0) return [];
	const preset = getPreset(config.preset);
	const layout = mergeSegmentsWithCustomItems(preset, config.customItems, config);
	const separator = context.theme.fg("dim", ` ${getSeparator(preset.separator).left} `);
	const lines: string[] = [];
	let row = "";
	for (const id of [...layout.leftSegments, ...layout.rightSegments, ...layout.secondarySegments]) {
		const segment = renderSegment(id, context);
		if (!segment.visible || !segment.content) continue;
		const content = segment.content.replace(/[\r\n\t]/g, " ");
		const joined = row ? `${row}${separator}${content}` : content;
		if (visibleWidth(joined) <= width) row = joined;
		else {
			if (row) lines.push(row);
			if (lines.length === 2) {
				row = "";
				break;
			}
			row = truncateToWidth(content, width, width > 1 ? "…" : "");
		}
	}
	if (row && lines.length < 2) lines.push(row);
	for (const status of getNotificationExtensionStatuses(
		context.extensionStatuses,
		context.hiddenExtensionStatusKeys,
	)) {
		lines.push(truncateToWidth(status.replace(/[\r\n\t]/g, " "), width, width > 1 ? "…" : ""));
	}
	return lines;
}

export interface PowerlineOptions {
	agentDir?: string;
}

/** Default footer through the public UI surface, shared by fullscreen and inline mode. */
export function createPowerlineExtension(options: PowerlineOptions = {}): ExtensionFactory {
	return (pi) => {
		let config = parsePowerlineConfig(undefined, PRESET_NAMES);
		let enabled = true;
		let ctx: ExtensionContext | undefined;
		let live: AssistantMessage | undefined;
		let sessionStart = Date.now();
		let repaint: (() => void) | undefined;
		let dispose: (() => void) | undefined;
		let git: GitStatusMonitor | undefined;
		let autoCompact = true;
		let cachedSession = "";
		let cachedLeaf: string | null | undefined;
		let cachedUsage = createUsageTotals();
		let persistedMessages = new WeakSet<object>();
		let cachedContextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
		let cachedModel: ExtensionContext["model"];
		let showLastPrompt = true;
		let lastPrompt = "";
		const paths = (cwd: string) => [
			join(options.agentDir ?? getAgentDir(), "settings.json"),
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
		];

		const install = (context: ExtensionContext) => {
			dispose?.();
			ctx = context;
			if (!context.hasUI || context.mode !== "tui" || !enabled) return;
			context.ui.setFooter((tui, theme, footerData) => {
				repaint = () => tui.requestRender();
				git = new GitStatusMonitor(context.cwd, repaint);
				const refresh = () => {
					const polling = mergeSegmentOptions(getPreset(config.preset).segmentOptions, config.segmentOptions).git
						?.polling;
					if (polling !== "off" && polling !== "branch") void git?.refresh();
					repaint?.();
				};
				const unsubscribe = footerData.onBranchChange(refresh);
				const timer = setInterval(refresh, 1000);
				timer.unref();
				refresh();
				let closed = false;
				const copyDraft = async (cut: boolean) => {
					const text = context.ui.getEditorText();
					if (!text.trim()) {
						context.ui.notify("Editor is empty", "info");
						return;
					}
					const sessionId = context.sessionManager.getSessionId();
					try {
						await copyToClipboard(text);
						if (closed || context.sessionManager.getSessionId() !== sessionId) return;
						if (cut && context.ui.getEditorText() === text) context.ui.setEditorText("");
						context.ui.notify(cut && context.ui.getEditorText() === "" ? "Cut draft" : "Copied draft", "info");
					} catch (error) {
						if (!closed) context.ui.notify(String(error), "error");
					}
				};
				const unsubscribeInput = context.ui.onTerminalInput((data) => {
					// Both native renderers expose this public method; third-party TUI implementations may not.
					const focused: unknown =
						"getFocusedComponent" in tui && typeof tui.getFocusedComponent === "function"
							? tui.getFocusedComponent()
							: undefined;
					if (closed || isKeyRelease(data) || !(focused instanceof CustomEditor)) return;
					const keys = getKeybindings();
					const cut = keys.matches(data, "app.editor.cutDraft");
					if (!cut && !keys.matches(data, "app.editor.copyDraft")) return;
					void copyDraft(cut);
					return { consume: true };
				});
				const close = () => {
					if (closed) return;
					closed = true;
					clearInterval(timer);
					unsubscribe();
					unsubscribeInput();
					git?.dispose();
					git = undefined;
					repaint = undefined;
				};
				dispose = close;
				return {
					dispose: close,
					invalidate() {},
					render: (width) => {
						if (closed || !ctx) return [];
						const state = buildContext(ctx, theme, footerData);
						const lines = renderPowerline(state, config, width);
						if (showLastPrompt && lastPrompt && !state.shellModeActive && width > 12) {
							lines.push(theme.fg("dim", truncateToWidth(`↳ ${lastPrompt}`, width, "…")));
						}
						return lines;
					},
				} satisfies Component & { dispose(): void };
			});
		};

		const buildContext = (
			context: ExtensionContext,
			theme: Theme,
			footer: ReadonlyFooterDataProvider,
		): SegmentContext => {
			const sessionId = context.sessionManager.getSessionId();
			const leaf = context.sessionManager.getLeafId();
			const changed = cachedSession !== sessionId || cachedLeaf !== leaf;
			if (changed) {
				cachedSession = sessionId;
				cachedLeaf = leaf;
				cachedUsage = createUsageTotals();
				persistedMessages = new WeakSet<object>();
				lastPrompt = "";
				for (const entry of context.sessionManager.getBranch()) {
					if (entry.type === "message" && entry.message.role === "user") {
						const content = entry.message.content;
						lastPrompt = (
							typeof content === "string"
								? content
								: content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join(" ")
						)
							.replace(/\s+/g, " ")
							.trim();
					}
				}
				for (const entry of context.sessionManager.getEntries()) {
					if (entry.type === "usage") addUsageToTotals(cachedUsage, entry.usage);
					else if (entry.type === "message") {
						persistedMessages.add(entry.message);
						if (
							entry.message.role === "assistant" ||
							(entry.message.role === "toolResult" && entry.message.usage)
						)
							addUsageToTotals(cachedUsage, entry.message.usage!);
					} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage)
						addUsageToTotals(cachedUsage, entry.usage);
				}
			}
			if (changed || cachedModel !== context.model) {
				cachedModel = context.model;
				cachedContextUsage = context.getContextUsage();
			}
			const usageStats = { ...cachedUsage };
			const livePersisted = !!live && persistedMessages.has(live);
			if (live && !livePersisted) addUsageToTotals(usageStats, live.usage);
			const usage = cachedContextUsage;
			const contextWindow = usage?.contextWindow ?? context.model?.contextWindow ?? 0;
			const contextTokens =
				live && !livePersisted
					? live.usage.input + live.usage.output + live.usage.cacheRead + live.usage.cacheWrite
					: (usage?.tokens ?? null);
			const preset = getPreset(config.preset);
			const segmentOptions = mergeSegmentOptions(preset.segmentOptions, config.segmentOptions);
			const statuses = footer.getExtensionStatuses();
			const shellStatus = statuses.get("bash-mode");
			const showCounters = segmentOptions.git?.polling !== "off" && segmentOptions.git?.polling !== "branch";
			return {
				model: context.model,
				thinkingLevel: context.thinkingLevel ?? pi.getThinkingLevel(),
				sessionId: context.sessionManager.getSessionId(),
				cwd: context.cwd,
				usageStats,
				contextTokens,
				contextPercent: contextTokens === null || !contextWindow ? null : (contextTokens / contextWindow) * 100,
				contextWindow,
				autoCompactEnabled: autoCompact,
				customCompactionEnabled: statuses.has("compact-policy"),
				usingSubscription:
					!!context.model &&
					(context.model.provider === "kimi-coding" ||
						(context.modelRegistry.isUsingOAuth(context.model) &&
							context.modelRegistry.getProvider(context.model.provider)?.auth?.oauth?.isSubscription === true)),
				sessionStartTime: sessionStart,
				shellModeActive: !!shellStatus,
				shellRunning: shellStatus?.includes("running") ?? false,
				shellName: shellStatus ? "shell" : null,
				shellCwd: null,
				git:
					showCounters && git
						? git.get(footer.getGitBranch())
						: { branch: footer.getGitBranch(), staged: 0, unstaged: 0, untracked: 0 },
				extensionStatuses: statuses,
				hiddenExtensionStatusKeys: collectHiddenExtensionStatusKeys(config.customItems),
				customItemsById: new Map(config.customItems.map((item) => [item.id, item])),
				options: segmentOptions,
				theme,
				colors: preset.colors ?? getDefaultColors(),
			};
		};

		pi.on("session_start", (_event, context) => {
			live = undefined;
			cachedLeaf = undefined;
			sessionStart = Date.parse(context.sessionManager.getHeader()?.timestamp ?? "") || Date.now();
			try {
				const [global, project] = paths(context.cwd).map(readSettings);
				config = parsePowerlineConfig(mergedPowerline(global.powerline, project.powerline), PRESET_NAMES);
				showLastPrompt = (project.showLastPrompt ?? global.showLastPrompt) !== false;
				const compaction = mergedPowerline(global.compaction, project.compaction);
				autoCompact =
					!compaction ||
					typeof compaction !== "object" ||
					!("enabled" in compaction) ||
					compaction.enabled !== false;
				if (config.invalidDisabledSegments.length || config.invalidLayoutSegments.length)
					context.ui.notify("Unknown powerline segments were ignored", "warning");
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
			install(context);
		});
		pi.on("message_update", (event, context) => {
			ctx = context;
			if (event.message.role === "assistant") live = event.message;
			repaint?.();
		});
		pi.on("message_end", (event, context) => {
			ctx = context;
			live = event.message.role === "assistant" ? event.message : undefined;
			repaint?.();
		});
		pi.on("agent_end", (_event, context) => {
			ctx = context;
			live = undefined;
			repaint?.();
		});
		pi.on("model_select", (_event, context) => {
			ctx = context;
			repaint?.();
		});
		pi.on("thinking_level_select", (_event, context) => {
			ctx = context;
			repaint?.();
		});
		pi.on("session_tree", (_event, context) => {
			ctx = context;
			live = undefined;
			cachedLeaf = undefined;
			repaint?.();
		});
		pi.on("tool_result", () => {
			const polling = mergeSegmentOptions(getPreset(config.preset).segmentOptions, config.segmentOptions).git
				?.polling;
			if (polling !== "off" && polling !== "branch") void git?.refresh();
			repaint?.();
		});
		pi.on("session_shutdown", () => {
			dispose?.();
			dispose = undefined;
			ctx = undefined;
		});
		pi.registerCommand("powerline", {
			description: "Toggle the footer or select a preset",
			handler: async (args, context) => {
				const preset = args.trim().toLowerCase();
				if (!preset) {
					enabled = !enabled;
					if (enabled) install(context);
					else {
						dispose?.();
						context.ui.setFooter(undefined);
					}
					return;
				}
				if (!Object.hasOwn(PRESETS, preset)) {
					context.ui.notify(`Presets: ${PRESET_NAMES.join(", ")}`, "info");
					return;
				}
				config.preset = preset as StatusLinePreset;
				try {
					const [globalPath, projectPath] = paths(context.cwd);
					const project = readSettings(projectPath);
					const path = Object.hasOwn(project, "powerline") ? projectPath : globalPath;
					const settings = path === projectPath ? project : readSettings(globalPath);
					settings.powerline = nextPowerlineSettingWithPreset(settings.powerline, config.preset);
					mkdirSync(dirname(path), { recursive: true });
					const temporary = `${path}.${randomUUID()}.tmp`;
					try {
						writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
						renameSync(temporary, path);
					} finally {
						rmSync(temporary, { force: true });
					}
				} catch (error) {
					context.ui.notify(`Preset applied but could not be saved: ${String(error)}`, "warning");
				}
				if (enabled) install(context);
			},
		});
	};
}
