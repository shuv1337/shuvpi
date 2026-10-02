import {
	type AutocompleteProvider,
	type EditorTheme,
	isKeyRelease,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@shuv1337/shuvpi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { CustomEditor } from "../../modes/interactive/components/custom-editor.ts";
import {
	BashAutocompleteProvider,
	getOneOffBashCommandContext,
	ModeAwareAutocompleteProvider,
	OneOffBashAutocompleteProvider,
} from "./completion.ts";
import type { GhostSuggestion } from "./types.ts";

interface BashEditorOptions {
	active: () => boolean;
	running: () => boolean;
	toggle: () => void;
	exit: () => void;
	interrupt: () => void;
	submit: (command: string) => void;
	notify: (message: string) => void;
	history: (prefix: string) => string[];
	ghost: (text: string, signal: AbortSignal) => Promise<GhostSuggestion | null>;
}

export class BashModeEditor extends CustomEditor {
	private readonly keys: KeybindingsManager;
	private readonly options: BashEditorOptions;
	private ghost: GhostSuggestion | null = null;
	private ghostAbort: AbortController | undefined;
	private shellHistoryIndex = -1;
	private shellHistoryItems: string[] = [];
	private shellHistoryDraft = "";
	private pasting = false;

	constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, options: BashEditorOptions) {
		super(tui, theme, keys);
		this.keys = keys;
		this.options = options;
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		// The host supplies the full current chain, including native skill providers, on every rebuild.
		super.setAutocompleteProvider(
			new ModeAwareAutocompleteProvider(
				provider,
				new BashAutocompleteProvider(),
				new OneOffBashAutocompleteProvider(),
				this.options.active,
			),
		);
	}

	resetMode(): void {
		this.shellHistoryIndex = -1;
		this.shellHistoryItems = [];
		this.shellHistoryDraft = "";
		this.refreshGhost();
	}

	dispose(): void {
		this.ghostAbort?.abort();
	}

	refreshGhost(): void {
		this.ghostAbort?.abort();
		this.ghost = null;
		const text = this.getExpandedText();
		if ((!this.options.active() && !getOneOffBashCommandContext(text)) || text.includes("\n")) return;
		const controller = new AbortController();
		this.ghostAbort = controller;
		void this.options
			.ghost(text, controller.signal)
			.then((ghost) => {
				if (controller.signal.aborted) return;
				this.ghost = ghost;
				this.tui.requestRender();
			})
			.catch(() => {
				// A completion source is optional; it must not prevent command entry.
			});
	}

	override handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const paste = this.pasting || data.includes("\u001b[200~");
		if (paste) {
			this.pasting = !data.includes("\u001b[201~");
			super.handleInput(data);
			if (!this.pasting) this.resetMode();
			return;
		}
		if (this.keys.matches(data, "app.bashMode.toggle")) {
			this.options.toggle();
			return;
		}
		const active = this.options.active();
		if (active && this.keys.matches(data, "app.interrupt") && !this.isShowingAutocomplete()) {
			this.options.exit();
			return;
		}
		if (active && this.keys.matches(data, "app.clear") && this.options.running()) {
			this.options.interrupt();
			return;
		}
		if (active && !this.isShowingAutocomplete()) {
			const cursor = this.getCursor();
			const previous =
				this.keys.matches(data, "tui.editor.historyPrevious") ||
				(this.keys.matches(data, "tui.editor.cursorUp") && cursor.line === 0);
			const next =
				this.keys.matches(data, "tui.editor.historyNext") ||
				(this.keys.matches(data, "tui.editor.cursorDown") && cursor.line === this.getLines().length - 1);
			if (previous || next) {
				this.navigateHistoryEntry(previous ? -1 : 1);
				return;
			}
		}
		if (
			(active || getOneOffBashCommandContext(this.getText())) &&
			(this.keys.matches(data, "tui.input.tab") || this.keys.matches(data, "tui.editor.cursorRight")) &&
			this.acceptGhost()
		)
			return;
		if (active && this.keys.matches(data, "tui.input.submit") && !this.keys.matches(data, "tui.input.newLine")) {
			if (this.options.running()) {
				this.options.notify("Shell command already running");
				return;
			}
			const command = this.getExpandedText().trim();
			if (!command) return;
			this.setText("");
			this.resetMode();
			this.options.submit(command);
			return;
		}
		const before = this.getText();
		super.handleInput(data);
		if (before !== this.getText()) this.resetMode();
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const lines = super.render(width).map((line) => truncateToWidth(line, width, ""));
		const text = this.getText();
		const cursor = this.getCursor();
		if (
			!this.ghost ||
			text.includes("\n") ||
			cursor.line !== 0 ||
			cursor.col !== text.length ||
			!this.ghost.value.startsWith(text) ||
			this.ghost.value === text ||
			lines.length !== 3
		)
			return lines;
		const cursorBlock = "\u001b[7m \u001b[0m";
		const position = lines[1].indexOf(cursorBlock);
		if (position < 0) return lines;
		// Preserve the host's padding and hardware cursor marker; only replace its empty cursor/padding cells.
		const prefix = lines[1].slice(0, position);
		const remaining = width - visibleWidth(prefix);
		const suffix = truncateToWidth(this.ghost.value.slice(text.length), remaining, "", true);
		if (!suffix) return lines;
		const first = [...new Intl.Segmenter().segment(suffix)][0]?.segment ?? "";
		lines[1] = `${prefix}\u001b[7m${first}\u001b[0m\u001b[38;5;244m${suffix.slice(first.length)}\u001b[0m${" ".repeat(Math.max(0, remaining - visibleWidth(suffix)))}`;
		return lines;
	}

	private acceptGhost(): boolean {
		const text = this.getExpandedText();
		const cursor = this.getCursor();
		if (
			!this.ghost ||
			text.includes("\n") ||
			cursor.line !== 0 ||
			cursor.col !== text.length ||
			!this.ghost.value.startsWith(text) ||
			this.ghost.value === text
		)
			return false;
		this.setText(this.ghost.value);
		this.ghostAbort?.abort();
		this.ghost = null;
		return true;
	}

	private navigateHistoryEntry(direction: -1 | 1): void {
		if (this.shellHistoryIndex === -1) {
			if (direction > 0) return;
			this.shellHistoryDraft = this.getExpandedText();
			this.shellHistoryItems = this.options.history(this.shellHistoryDraft);
		}
		if (!this.shellHistoryItems.length) return;
		this.shellHistoryIndex = Math.max(
			-1,
			Math.min(this.shellHistoryItems.length - 1, this.shellHistoryIndex - direction),
		);
		this.setText(
			this.shellHistoryIndex < 0 ? this.shellHistoryDraft : this.shellHistoryItems[this.shellHistoryIndex],
		);
		this.ghostAbort?.abort();
		this.ghost = null;
	}
}
