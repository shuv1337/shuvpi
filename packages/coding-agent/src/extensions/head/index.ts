import { type Component, type KeybindingsManager, Markdown, truncateToWidth } from "@shuv1337/shuvpi-tui";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { AppKeybinding } from "../../core/keybindings.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";

/** Scrollable text view used by the optional /head command. */
export class HeadViewer implements Component {
	private scroll = 0;
	private cachedWidth = -1;
	private cachedLines: string[] = [];
	private readonly markdown: Markdown;
	private readonly entryId: string;
	private readonly tui: { terminal: { rows: number }; requestRender(): void };
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly close: () => void;

	constructor(
		text: string,
		entryId: string,
		tui: { terminal: { rows: number }; requestRender(): void },
		theme: Theme,
		keys: KeybindingsManager,
		close: () => void,
	) {
		this.markdown = new Markdown(text, 1, 0, getMarkdownTheme());
		this.entryId = entryId;
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.close = close;
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "app.head.close")) {
			this.close();
			return;
		}
		if (this.keys.matches(data, "app.head.down")) this.scroll++;
		else if (this.keys.matches(data, "app.head.up")) this.scroll--;
		else if (this.keys.matches(data, "app.head.pageDown")) this.scroll += this.pageSize();
		else if (this.keys.matches(data, "app.head.pageUp")) this.scroll -= this.pageSize();
		else if (this.keys.matches(data, "app.head.top")) this.scroll = 0;
		else if (this.keys.matches(data, "app.head.bottom")) this.scroll = this.cachedLines.length;
		else return;
		this.clampScroll();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0 || this.tui.terminal.rows <= 0) return [];
		if (this.cachedWidth !== width) {
			this.cachedLines = this.markdown.render(width);
			this.cachedWidth = width;
		}
		this.clampScroll();
		const page = this.pageSize();
		const total = this.cachedLines.length;
		const visible = this.cachedLines.slice(this.scroll, this.scroll + page);
		while (visible.length < page) visible.push("");
		const hintActions: Array<[AppKeybinding, string]> = [
			["app.head.up", "up"],
			["app.head.down", "down"],
			["app.head.pageUp", "page up"],
			["app.head.pageDown", "page down"],
			["app.head.top", "top"],
			["app.head.bottom", "bottom"],
			["app.head.close", "close"],
		];
		const hints = hintActions
			.flatMap(([action, label]) => {
				const keys = this.keys.getKeys(action);
				return keys.length ? [`${keys.join("/")} ${label}`] : [];
			})
			.join("  ");
		return [
			this.theme.fg("accent", `Last response (${this.entryId.slice(0, 8)})`),
			...visible,
			this.theme.fg(
				"muted",
				`Lines ${Math.min(this.scroll + 1, total)}–${Math.min(this.scroll + page, total)} / ${total}`,
			),
			this.theme.fg("dim", hints),
		]
			.slice(0, this.tui.terminal.rows)
			.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.markdown.invalidate();
	}

	private pageSize(): number {
		return Math.max(0, this.tui.terminal.rows - 3);
	}
	private clampScroll(): void {
		this.scroll = Math.max(0, Math.min(this.scroll, this.cachedLines.length - this.pageSize()));
	}
}

/** Explicitly register this factory to enable /head. It is not loaded by default. */
export function createHeadExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("head", {
			description: "View the last assistant response",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("/head requires interactive mode", "error");
					return;
				}
				for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
					if (entry.type !== "message" || entry.message.role !== "assistant") continue;
					const text = entry.message.content
						.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
						.join("\n\n");
					if (!text) continue;
					await ctx.ui.custom<void>(
						(tui, theme, keys, done) => new HeadViewer(text, entry.id, tui, theme, keys, () => done(undefined)),
						{
							overlay: true,
							overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
						},
					);
					return;
				}
				ctx.ui.notify("No assistant response found", "warning");
			},
		});
	};
}
