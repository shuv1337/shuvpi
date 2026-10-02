import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getKeybindings, truncateToWidth } from "@shuv1337/shuvpi-tui";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";

function readHistory(path: string): string[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || !("history" in parsed) || !Array.isArray(parsed.history)) return [];
		return parsed.history
			.filter((value): value is string => typeof value === "string" && !!value.trim())
			.slice(0, 12);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function projectPrompts(ctx: ExtensionContext): string[] {
	const prompts: Array<{ text: string; timestamp: number }> = [];
	const collect = (value: unknown) => {
		if (
			!value ||
			typeof value !== "object" ||
			!("type" in value) ||
			value.type !== "message" ||
			!("message" in value)
		)
			return;
		const message = value.message;
		if (
			!message ||
			typeof message !== "object" ||
			!("role" in message) ||
			message.role !== "user" ||
			!("content" in message)
		)
			return;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.flatMap((part: unknown) =>
								part &&
								typeof part === "object" &&
								"type" in part &&
								part.type === "text" &&
								"text" in part &&
								typeof part.text === "string"
									? [part.text]
									: [],
							)
							.join("\n")
					: "";
		if (text.trim())
			prompts.push({
				text,
				timestamp: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0,
			});
	};
	for (const entry of ctx.sessionManager.getEntries()) collect(entry);
	const directory = ctx.sessionManager.getSessionDir();
	if (directory) {
		let files: string[] = [];
		try {
			files = readdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
			const lines = readFileSync(join(directory, file), "utf8").split("\n");
			let header: unknown;
			try {
				header = JSON.parse(lines[0]);
			} catch {
				continue;
			}
			if (!header || typeof header !== "object" || !("cwd" in header) || header.cwd !== ctx.sessionManager.getCwd())
				continue;
			for (const line of lines.slice(1)) {
				// A session can be active in another process; its final line may still be incomplete.
				try {
					if (line) collect(JSON.parse(line));
				} catch {
					/* Skip malformed history records. */
				}
			}
		}
	}
	return [...new Set(prompts.sort((a, b) => b.timestamp - a.timestamp).map((entry) => entry.text))].slice(0, 50);
}

export function createPromptHistoryExtension(options: { agentDir?: string } = {}): ExtensionFactory {
	return (pi) => {
		let stashed: string | undefined;
		let unsubscribe: (() => void) | undefined;
		let selecting = false;
		const historyPath = () => join(options.agentDir ?? getAgentDir(), "powerline-footer", "stash-history.json");
		const stash = (ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			const current = ctx.ui.getEditorText();
			if (!current.trim()) {
				if (stashed !== undefined) {
					ctx.ui.setEditorText(stashed);
					stashed = undefined;
					ctx.ui.setStatus("stash", undefined);
				} else ctx.ui.notify("Nothing to stash", "info");
				return;
			}
			try {
				const path = historyPath();
				const history = [current, ...readHistory(path).filter((entry) => entry !== current)].slice(0, 12);
				mkdirSync(dirname(path), { recursive: true });
				const temporary = `${path}.${randomUUID()}.tmp`;
				try {
					writeFileSync(temporary, `${JSON.stringify({ version: 1, history })}\n`, { flag: "wx", mode: 0o600 });
					renameSync(temporary, path);
				} finally {
					rmSync(temporary, { force: true });
				}
				stashed = current;
				ctx.ui.setEditorText("");
				ctx.ui.setStatus("stash", "stash");
			} catch (error) {
				ctx.ui.notify(`Could not stash prompt: ${String(error)}`, "error");
			}
		};
		const history = async (ctx: ExtensionContext) => {
			if (!ctx.hasUI || selecting) return;
			selecting = true;
			try {
				const saved = readHistory(historyPath());
				const recent = projectPrompts(ctx);
				const sources = [
					...(saved.length ? ["Stashed prompts"] : []),
					...(recent.length ? ["Recent project prompts"] : []),
				];
				if (!sources.length) {
					ctx.ui.notify("No prompt history yet", "info");
					return;
				}
				const source = sources.length === 1 ? sources[0] : await ctx.ui.select("Prompt history", sources);
				if (!source) return;
				const entries = source === "Stashed prompts" ? saved : recent;
				const labels = entries.map(
					(entry, i) => `${i + 1}. ${truncateToWidth(entry.replace(/\s+/g, " ").trim(), 72, "…")}`,
				);
				const selected = await ctx.ui.select(source, labels);
				if (!selected) return;
				const entry = entries[labels.indexOf(selected)];
				if (entry === undefined) return;
				const current = ctx.ui.getEditorText();
				const action = current.trim()
					? await ctx.ui.select("Insert prompt", ["Replace", "Append", "Cancel"])
					: "Replace";
				// Preserve typing that occurred while the choice dialog was open.
				if (ctx.ui.getEditorText() !== current) {
					ctx.ui.notify("The draft changed; select the prompt again", "warning");
					return;
				}
				if (action === "Replace") ctx.ui.setEditorText(entry);
				else if (action === "Append")
					ctx.ui.setEditorText(
						`${current}${current.endsWith("\n") || entry.startsWith("\n") ? "" : "\n"}${entry}`,
					);
			} catch (error) {
				ctx.ui.notify(`Could not read prompt history: ${String(error)}`, "warning");
			} finally {
				selecting = false;
			}
		};
		pi.registerCommand("stash", {
			description: "Stash or restore the current prompt",
			handler: async (_args, ctx) => stash(ctx),
		});
		pi.registerCommand("stash-history", {
			description: "Browse saved and recent project prompts",
			handler: async (_args, ctx) => history(ctx),
		});
		pi.on("session_start", (_event, ctx) => {
			unsubscribe?.();
			stashed = undefined;
			if (!ctx.hasUI) return;
			ctx.ui.setStatus("stash", undefined);
			unsubscribe = ctx.ui.onTerminalInput((data) => {
				if (selecting) return;
				if (getKeybindings().matches(data, "app.promptStash.toggle")) {
					stash(ctx);
					return { consume: true };
				}
				if (getKeybindings().matches(data, "app.promptStash.history")) {
					void history(ctx);
					return { consume: true };
				}
			});
		});
		pi.on("agent_end", (_event, ctx) => {
			if (ctx.hasUI && stashed !== undefined && !ctx.ui.getEditorText().trim()) {
				ctx.ui.setEditorText(stashed);
				stashed = undefined;
				ctx.ui.setStatus("stash", undefined);
			}
		});
		pi.on("session_shutdown", () => {
			unsubscribe?.();
			unsubscribe = undefined;
		});
	};
}
