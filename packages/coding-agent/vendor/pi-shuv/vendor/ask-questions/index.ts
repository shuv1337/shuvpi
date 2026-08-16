/**
 * Structured Questions Extension
 *
 * Provides a tool for asking structured questions with single-select,
 * multi-select, and free-text inputs. Supports back-navigation
 * between questions before final submission.
 *
 * Rendering design (no information is ever truncated):
 * - Question `prompt` and optional long-form `context` are fully word-wrapped.
 * - Option labels and descriptions are fully word-wrapped and stacked
 *   (label line(s) + indented dim description line(s)) — no column truncation.
 * - Optional per-option `details` (long-form rationale) is shown in a
 *   detail pane below the list for the focused option only (PgUp/PgDn scroll).
 * - The option list is a height-capped scrolling window that keeps the
 *   focused option in view and shows an (n/total) indicator when clipped.
 */

import type { ExtensionAPI, ExtensionContext } from "@shuv1337/shuvpi-coding-agent";
import { StringEnum } from "@shuv1337/shuvpi-ai";
import { Type, type Static } from "@shuv1337/shuvpi-ai";
import {
	Editor,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@shuv1337/shuvpi-tui";

// Schema
const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected" }),
	label: Type.String({ description: "Label shown to the user (fully displayed, word-wrapped — no length limit)" }),
	description: Type.Optional(
		Type.String({
			description:
				"Short summary shown beneath the label (fully displayed, word-wrapped). Keep to 1-2 sentences; put longer rationale in `details`.",
		}),
	),
	details: Type.Optional(
		Type.String({
			description:
				"Long-form rationale/trade-offs for this option. Shown in a detail pane when the user focuses the option. Use freely for in-depth information.",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	prompt: Type.String({ description: "The question itself. Keep it to the actual question; put background/analysis in `context`." }),
	context: Type.Optional(
		Type.String({
			description:
				"Long-form background shown above the options: analysis, recommendations, trade-offs. Fully displayed and word-wrapped — no length limit.",
		}),
	),
	type: StringEnum(["single", "multi", "text"] as const),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for single/multi questions" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a custom response option" })),
	min: Type.Optional(Type.Number({ description: "Minimum selections (multi only)" })),
	max: Type.Optional(Type.Number({ description: "Maximum selections (multi only)" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for text input" })),
	multiline: Type.Optional(Type.Boolean({ description: "Use a multi-line editor for text input" })),
});

const StructuredQuestionsParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional dialog title" })),
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// Types

type QuestionOption = Static<typeof OptionSchema>;

type Question = Static<typeof QuestionSchema>;

type StructuredQuestionsParamsType = Static<typeof StructuredQuestionsParams>;

interface SingleAnswer {
	id: string;
	type: "single";
	value: string;
	label: string;
	wasCustom?: boolean;
}

interface MultiAnswerItem {
	value: string;
	label: string;
	wasCustom?: boolean;
}

interface MultiAnswer {
	id: string;
	type: "multi";
	values: MultiAnswerItem[];
}

interface TextAnswer {
	id: string;
	type: "text";
	value: string;
}

type StructuredAnswer = SingleAnswer | MultiAnswer | TextAnswer;

interface StructuredQuestionsResult {
	title?: string;
	answers: StructuredAnswer[];
	cancelled: boolean;
}

interface DisplayOption extends QuestionOption {
	isOther?: boolean;
	isCustom?: boolean;
}

// Minimal theme surface used by the renderers (matches the theme passed to ctx.ui.custom)
interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

// Back-navigation sentinel
const BACK = Symbol("back");

// Helpers

function progressText(current: number, total: number): string {
	return total > 1 ? `(${current + 1}/${total})` : "";
}

function buildHintText(actions: string[], canGoBack: boolean): string {
	const escAction = canGoBack ? "Esc back" : "Esc cancel";
	return [...actions, escAction].join(" • ");
}

function errorResult(message: string, title?: string): { content: { type: "text"; text: string }[]; details: StructuredQuestionsResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { title, answers: [], cancelled: true },
	};
}

function formatAnswer(answer: StructuredAnswer): string {
	switch (answer.type) {
		case "single":
			return `${answer.id}: ${answer.label}${answer.wasCustom ? " (custom)" : ""}`;
		case "multi":
			return `${answer.id}: ${answer.values
				.map((value) => `${value.label}${value.wasCustom ? " (custom)" : ""}`)
				.join(", ")}`;
		case "text":
			return `${answer.id}: ${answer.value}`;
		default:
			return "";
	}
}

// Shared rendering helpers

/** Wrap styled text at width; every returned line is <= width visible chars. */
function wrapStyled(text: string, width: number, style: (s: string) => string): string[] {
	return wrapTextWithAnsi(style(text), Math.max(4, width));
}

/**
 * Header block: top border, title/progress, context (fully wrapped), prompt (fully wrapped).
 */
function buildHeaderLines(
	width: number,
	theme: ThemeLike,
	title: string | undefined,
	progress: string | undefined,
	context: string | undefined,
	prompt: string,
): string[] {
	const lines: string[] = [];
	lines.push(theme.fg("accent", "─".repeat(width)));
	if (title || progress) {
		let header = "";
		if (title) header += theme.fg("accent", theme.bold(title));
		if (progress) header += (header ? " " : "") + theme.fg("dim", progress);
		lines.push(truncateToWidth(` ${header}`, width));
	}
	if (context) {
		for (const line of wrapStyled(context, width - 2, (s) => theme.fg("muted", s))) {
			lines.push(` ${line}`);
		}
		lines.push("");
	}
	for (const line of wrapStyled(prompt, width - 2, (s) => theme.fg("text", s))) {
		lines.push(` ${line}`);
	}
	lines.push("");
	return lines;
}

/**
 * Build one option's fully-wrapped block:
 *   → [☑ ]label line 1
 *          label continuation…
 *          description (dim, wrapped)
 */
function buildOptionBlock(
	opt: DisplayOption,
	focused: boolean,
	width: number,
	theme: ThemeLike,
	mode: "single" | "multi",
	checked: boolean,
	inputMode: boolean,
): string[] {
	const marker = focused ? "→ " : "  ";
	const checkbox = mode === "multi" ? (checked ? "☑ " : "☐ ") : "";
	const prefix = marker + checkbox;
	const prefixWidth = visibleWidth(prefix);
	const indent = " ".repeat(prefixWidth);
	const styledPrefix = focused ? theme.fg("accent", prefix) : prefix;

	const labelText = opt.isOther && inputMode ? `${opt.label} ✎` : opt.label;
	const labelColor = focused ? "accent" : "text";
	const contentWidth = Math.max(4, width - prefixWidth - 1);

	const lines: string[] = [];
	const labelLines = wrapStyled(labelText, contentWidth, (s) => theme.fg(labelColor, s));
	labelLines.forEach((line, i) => {
		lines.push((i === 0 ? styledPrefix : indent) + line);
	});

	if (opt.description) {
		for (const line of wrapStyled(opt.description, contentWidth, (s) => theme.fg("muted", s))) {
			lines.push(indent + line);
		}
	}

	return lines;
}

/**
 * Windowed option list. Mutates state.scrollTop to keep the focused block in view.
 * Returns at most maxLines lines (plus nothing else — indicator is included when clipped).
 */
function buildOptionListLines(
	options: DisplayOption[],
	focusIdx: number,
	width: number,
	theme: ThemeLike,
	mode: "single" | "multi",
	selected: Set<string> | null,
	inputMode: boolean,
	maxLines: number,
	state: { scrollTop: number },
): string[] {
	const blocks = options.map((opt, i) =>
		buildOptionBlock(opt, i === focusIdx, width, theme, mode, selected?.has(opt.value) ?? false, inputMode),
	);

	const starts: number[] = [];
	let total = 0;
	for (const block of blocks) {
		starts.push(total);
		total += block.length;
	}

	const all = blocks.flat();
	if (total <= maxLines) {
		state.scrollTop = 0;
		return all;
	}

	// Reserve a line for the scroll indicator
	const windowSize = Math.max(1, maxLines - 1);
	const fStart = starts[focusIdx] ?? 0;
	const fEnd = fStart + (blocks[focusIdx]?.length ?? 1);

	let scrollTop = state.scrollTop;
	if (fEnd - fStart >= windowSize) {
		scrollTop = fStart;
	} else if (fStart < scrollTop) {
		scrollTop = fStart;
	} else if (fEnd > scrollTop + windowSize) {
		scrollTop = fEnd - windowSize;
	}
	scrollTop = Math.max(0, Math.min(scrollTop, total - windowSize));
	state.scrollTop = scrollTop;

	const lines = all.slice(scrollTop, scrollTop + windowSize);
	lines.push(theme.fg("dim", truncateToWidth(`  (${focusIdx + 1}/${options.length} options — ↑↓ to scroll)`, width - 2, "")));
	return lines;
}

/**
 * Detail pane for the focused option's long-form `details`.
 * Fully wrapped, capped in height, scrollable with PgUp/PgDn.
 */
function buildDetailPaneLines(
	opt: DisplayOption | undefined,
	width: number,
	theme: ThemeLike,
	paneCap: number,
	state: { paneScroll: number },
): string[] {
	if (!opt?.details) {
		state.paneScroll = 0;
		return [];
	}

	const wrapped = wrapStyled(opt.details, width - 4, (s) => theme.fg("muted", s));
	const lines: string[] = [];
	lines.push(theme.fg("dim", truncateToWidth(` · details ${"─".repeat(Math.max(0, width - 12))}`, width, "")));

	if (wrapped.length <= paneCap) {
		state.paneScroll = 0;
		for (const line of wrapped) lines.push(`   ${line}`);
		return lines;
	}

	const bodyCap = Math.max(1, paneCap - 1);
	const maxScroll = wrapped.length - bodyCap;
	state.paneScroll = Math.max(0, Math.min(state.paneScroll, maxScroll));

	for (const line of wrapped.slice(state.paneScroll, state.paneScroll + bodyCap)) {
		lines.push(`   ${line}`);
	}
	const below = wrapped.length - (state.paneScroll + bodyCap);
	const parts: string[] = [];
	if (state.paneScroll > 0) parts.push(`↑${state.paneScroll} PgUp`);
	if (below > 0) parts.push(`↓${below} PgDn`);
	lines.push(theme.fg("dim", truncateToWidth(`   … ${parts.join(" • ")}`, width, "")));
	return lines;
}

/** How many rows the option list may use, given the rest of the frame. */
function listBudget(rows: number, fixedLines: number): number {
	const budget = Math.max(10, rows - 6) - fixedLines;
	return Math.max(4, budget);
}

/** Cap for the detail pane height. */
function detailPaneCap(rows: number): number {
	return Math.max(3, Math.floor(rows * 0.25));
}

// Question renderers

async function askSingle(
	ctx: ExtensionContext,
	question: Question,
	title?: string,
	canGoBack = false,
	previousAnswer?: SingleAnswer | null,
	progress?: string,
): Promise<SingleAnswer | typeof BACK | null> {
	const baseOptions = question.options ?? [];
	if (baseOptions.length === 0) return null;

	const options: DisplayOption[] = baseOptions.map((opt) => ({ ...opt }));
	if (question.allowOther) {
		options.push({ value: "__other__", label: "Type something...", description: "Enter a custom response", isOther: true });
	}

	// Loop so cancelling the "Other" custom input returns to the option list
	while (true) {
		const selection = await ctx.ui.custom<string | typeof BACK | null>((tui, theme, _kb, done) => {
			let focusIdx = 0;
			const scrollState = { scrollTop: 0 };
			const paneState = { paneScroll: 0 };

			// Pre-select previous answer
			if (previousAnswer) {
				const idx = previousAnswer.wasCustom
					? options.findIndex((opt) => opt.isOther)
					: options.findIndex((opt) => opt.value === previousAnswer.value);
				if (idx >= 0) focusIdx = idx;
			}

			function render(width: number): string[] {
				const rows = tui.terminal?.rows || 24;
				const lines: string[] = [];
				const add = (line: string) => lines.push(truncateToWidth(line, width));

				for (const line of buildHeaderLines(width, theme, title, progress, question.context, question.prompt)) {
					add(line);
				}

				const paneCap = detailPaneCap(rows);
				const paneLines = buildDetailPaneLines(options[focusIdx], width, theme, paneCap, paneState);

				// fixed = header + pane + hint + bottom border
				const fixed = lines.length + paneLines.length + 2;
				const maxList = listBudget(rows, fixed);

				for (const line of buildOptionListLines(options, focusIdx, width, theme, "single", null, false, maxList, scrollState)) {
					add(line);
				}
				for (const line of paneLines) add(line);

				add(theme.fg("dim", ` ${buildHintText(["↑↓ navigate", "Enter select"], canGoBack)}`));
				add(theme.fg("accent", "─".repeat(width)));
				return lines;
			}

			function handleInput(data: string) {
				if (matchesKey(data, Key.up)) {
					focusIdx = focusIdx === 0 ? options.length - 1 : focusIdx - 1;
					paneState.paneScroll = 0;
				} else if (matchesKey(data, Key.down)) {
					focusIdx = focusIdx === options.length - 1 ? 0 : focusIdx + 1;
					paneState.paneScroll = 0;
				} else if (matchesKey(data, Key.pageDown)) {
					paneState.paneScroll += 3;
				} else if (matchesKey(data, Key.pageUp)) {
					paneState.paneScroll = Math.max(0, paneState.paneScroll - 3);
				} else if (matchesKey(data, Key.enter)) {
					const opt = options[focusIdx];
					if (opt) done(opt.value);
					return;
				} else if (matchesKey(data, Key.escape)) {
					done(canGoBack ? BACK : null);
					return;
				}
				tui.requestRender();
			}

			return { render, invalidate: () => {}, handleInput };
		});

		if (selection === BACK) return BACK;
		if (!selection) return null;

		if (selection === "__other__") {
			const prefill = previousAnswer?.wasCustom ? previousAnswer.value : "";
			const custom = question.multiline
				? await ctx.ui.editor(question.prompt, prefill)
				: await ctx.ui.input(question.prompt, question.placeholder ?? "");
			if (!custom?.trim()) continue; // Back to option list, not cancel
			return {
				id: question.id,
				type: "single",
				value: custom.trim(),
				label: custom.trim(),
				wasCustom: true,
			};
		}

		const selectedOption = options.find((opt) => opt.value === selection) ?? {
			value: selection,
			label: selection,
		};

		return {
			id: question.id,
			type: "single",
			value: selectedOption.value,
			label: selectedOption.label,
			wasCustom: false,
		};
	}
}

async function askText(
	ctx: ExtensionContext,
	question: Question,
	title?: string,
	canGoBack = false,
	previousAnswer?: TextAnswer | null,
	progress?: string,
): Promise<TextAnswer | typeof BACK | null> {
	// Multiline without context: use the built-in full-screen editor with prefill
	if (question.multiline && !question.context) {
		const prefill = previousAnswer?.value ?? "";
		const value = await ctx.ui.editor(question.prompt, prefill);
		if (value === undefined || !value.trim()) {
			return canGoBack ? BACK : null;
		}
		return { id: question.id, type: "text", value: value.trim() };
	}

	// Inline editor with fully-wrapped context/prompt + prefill + back support.
	// The embedded Editor supports newlines via Shift+Enter, so multiline
	// questions with context also work here.
	const result = await ctx.ui.custom<string | typeof BACK | null>((tui, theme, _kb, done) => {
		let errorMessage: string | null = null;
		let cachedLines: string[] | undefined;

		const editor = new Editor(tui, {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		});

		if (previousAnswer) {
			editor.setText(previousAnswer.value);
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				errorMessage = "Please enter a response";
				cachedLines = undefined;
				tui.requestRender();
				return;
			}
			done(trimmed);
		};

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (line: string) => lines.push(truncateToWidth(line, width));

			for (const line of buildHeaderLines(width, theme, title, progress, question.context, question.prompt)) {
				add(line);
			}

			if (question.placeholder && !previousAnswer) {
				for (const line of wrapStyled(question.placeholder, width - 2, (s) => theme.fg("dim", s))) {
					add(` ${line}`);
				}
			}

			for (const line of editor.render(width - 2)) {
				add(` ${line}`);
			}

			if (errorMessage) {
				add(theme.fg("warning", ` ${errorMessage}`));
			}

			lines.push("");
			const actions = question.multiline ? ["Enter submit", "Shift+Enter newline"] : ["Enter submit"];
			add(theme.fg("dim", ` ${buildHintText(actions, canGoBack)}`));
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput: (data) => {
				if (matchesKey(data, Key.escape)) {
					done(canGoBack ? BACK : null);
					return;
				}
				errorMessage = null;
				cachedLines = undefined;
				editor.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (result === BACK) return BACK;
	if (!result) return null;
	return { id: question.id, type: "text", value: result };
}

async function askMulti(
	ctx: ExtensionContext,
	question: Question,
	title?: string,
	canGoBack = false,
	previousAnswer?: MultiAnswer | null,
	progress?: string,
): Promise<MultiAnswer | typeof BACK | null> {
	const baseOptions = question.options ?? [];
	if (baseOptions.length === 0) return null;

	const allowOther = question.allowOther === true;
	const minSelections = Math.max(0, question.min ?? 0);
	const maxSelections = question.max === undefined ? Number.POSITIVE_INFINITY : Math.max(0, question.max);
	const maxAllowed = maxSelections < minSelections ? minSelections : maxSelections;

	const result = await ctx.ui.custom<MultiAnswerItem[] | typeof BACK | null>((tui, theme, _kb, done) => {
		let focusIdx = 0;
		let inputMode = false;
		let errorMessage: string | null = null;
		const scrollState = { scrollTop: 0 };
		const paneState = { paneScroll: 0 };
		const selected = new Set<string>();
		const customOptions: DisplayOption[] = [];

		// Pre-populate from previous answer
		if (previousAnswer) {
			for (const item of previousAnswer.values) {
				selected.add(item.value);
				if (item.wasCustom) {
					customOptions.push({ value: item.value, label: item.label, isCustom: true });
				}
			}
		}

		const editor = new Editor(tui, {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		});

		function refresh() {
			tui.requestRender();
		}

		function allOptions(): DisplayOption[] {
			const list: DisplayOption[] = [...baseOptions, ...customOptions];
			if (allowOther) {
				list.push({ value: "__other__", label: "Type something...", description: "Enter a custom response", isOther: true });
			}
			return list;
		}

		function selectionCount(): number {
			return selected.size;
		}

		function setError(message: string | null) {
			errorMessage = message;
		}

		function toggleOption(option: DisplayOption) {
			if (option.isOther) {
				inputMode = true;
				setError(null);
				refresh();
				return;
			}

			if (selected.has(option.value)) {
				selected.delete(option.value);
				setError(null);
				refresh();
				return;
			}

			if (selectionCount() >= maxAllowed) {
				setError(`Select up to ${maxAllowed} option${maxAllowed === 1 ? "" : "s"}.`);
				refresh();
				return;
			}

			selected.add(option.value);
			setError(null);
			refresh();
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				inputMode = false;
				editor.setText("");
				setError(null);
				refresh();
				return;
			}

			if (selectionCount() >= maxAllowed) {
				setError(`Select up to ${maxAllowed} option${maxAllowed === 1 ? "" : "s"}.`);
				refresh();
				return;
			}

			const existing = [...baseOptions, ...customOptions].find((opt) => opt.value === trimmed);
			if (!existing) {
				customOptions.push({ value: trimmed, label: trimmed, isCustom: true });
			}
			selected.add(trimmed);
			inputMode = false;
			editor.setText("");
			setError(null);
			focusIdx = Math.min(allOptions().length - 1, focusIdx);
			refresh();
		};

		function confirmSelection() {
			if (selectionCount() < minSelections) {
				setError(`Select at least ${minSelections} option${minSelections === 1 ? "" : "s"}.`);
				refresh();
				return;
			}

			const options = allOptions().filter((opt) => selected.has(opt.value) && !opt.isOther);
			done(
				options.map((opt) => ({
					value: opt.value,
					label: opt.label,
					wasCustom: opt.isCustom,
				})),
			);
		}

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					editor.setText("");
					setError(null);
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const options = allOptions();

			if (matchesKey(data, Key.up)) {
				focusIdx = focusIdx === 0 ? options.length - 1 : focusIdx - 1;
				paneState.paneScroll = 0;
				setError(null);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				focusIdx = focusIdx === options.length - 1 ? 0 : focusIdx + 1;
				paneState.paneScroll = 0;
				setError(null);
				refresh();
				return;
			}

			if (matchesKey(data, Key.pageDown)) {
				paneState.paneScroll += 3;
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				paneState.paneScroll = Math.max(0, paneState.paneScroll - 3);
				refresh();
				return;
			}

			if (matchesKey(data, Key.space)) {
				const option = options[focusIdx];
				if (option) toggleOption(option);
				return;
			}

			if (matchesKey(data, Key.enter)) {
				confirmSelection();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done(canGoBack ? BACK : null);
			}
		}

		function render(width: number): string[] {
			const rows = tui.terminal?.rows || 24;
			const lines: string[] = [];
			const add = (line: string) => lines.push(truncateToWidth(line, width));
			const options = allOptions();

			for (const line of buildHeaderLines(width, theme, title, progress, question.context, question.prompt)) {
				add(line);
			}

			const paneCap = detailPaneCap(rows);
			const paneLines = buildDetailPaneLines(options[focusIdx], width, theme, paneCap, paneState);

			// fixed = header + pane + editor (if input mode) + selection info + error + hint + border
			const editorLines = inputMode ? editor.render(width - 2) : [];
			const fixed = lines.length + paneLines.length + editorLines.length + (inputMode ? 2 : 0) + (errorMessage ? 1 : 0) + 3;
			const maxList = listBudget(rows, fixed);

			for (const line of buildOptionListLines(options, focusIdx, width, theme, "multi", selected, inputMode, maxList, scrollState)) {
				add(line);
			}
			for (const line of paneLines) add(line);

			if (inputMode) {
				lines.push("");
				add(theme.fg("muted", " Your answer:"));
				for (const line of editorLines) {
					add(` ${line}`);
				}
			}

			lines.push("");

			const selectionInfo = `Selected ${selectionCount()}${Number.isFinite(maxAllowed) ? ` / ${maxAllowed}` : ""}`;
			add(theme.fg("dim", ` ${selectionInfo}`));

			if (errorMessage) {
				add(theme.fg("warning", ` ${errorMessage}`));
			}

			add(theme.fg("dim", ` ${buildHintText(["↑↓ navigate", "Space toggle", "Enter confirm"], canGoBack)}`));
			add(theme.fg("accent", "─".repeat(width)));

			return lines;
		}

		return {
			render,
			invalidate: () => {},
			handleInput,
		};
	});

	if (result === BACK) return BACK;
	if (!result) return null;
	return {
		id: question.id,
		type: "multi",
		values: result,
	};
}

// Main questionnaire runner

async function runStructuredQuestions(
	ctx: ExtensionContext,
	params: StructuredQuestionsParamsType,
): Promise<{ content: { type: "text"; text: string }[]; details: StructuredQuestionsResult }> {
	if (!ctx.hasUI) {
		return errorResult("Error: UI not available (running in non-interactive mode)", params.title);
	}

	if (!params.questions.length) {
		return errorResult("Error: No questions provided", params.title);
	}

	// Validate all questions upfront before starting the interactive flow
	for (const question of params.questions) {
		const needsOptions = question.type === "single" || question.type === "multi";
		if (needsOptions && (!question.options || question.options.length === 0)) {
			return errorResult(`Error: Question "${question.id}" requires options`, params.title);
		}

		if (
			question.type === "multi" &&
			!question.allowOther &&
			question.min !== undefined &&
			question.options &&
			question.min > question.options.length
		) {
			return errorResult(
				`Error: Question "${question.id}" requires at least ${question.min} selections but only ${question.options.length} options were provided`,
				params.title,
			);
		}
	}

	// Index-based loop supporting back-navigation
	const answers: (StructuredAnswer | undefined)[] = new Array(params.questions.length);
	let questionIndex = 0;
	const total = params.questions.length;

	while (questionIndex < total) {
		const question = params.questions[questionIndex];
		const canGoBack = questionIndex > 0;
		const progress = progressText(questionIndex, total);
		const prevAnswer = answers[questionIndex] ?? null;

		let result: StructuredAnswer | typeof BACK | null = null;

		switch (question.type) {
			case "single":
				result = await askSingle(ctx, question, params.title, canGoBack, prevAnswer as SingleAnswer | null, progress);
				break;
			case "multi":
				result = await askMulti(ctx, question, params.title, canGoBack, prevAnswer as MultiAnswer | null, progress);
				break;
			case "text":
				result = await askText(ctx, question, params.title, canGoBack, prevAnswer as TextAnswer | null, progress);
				break;
			default:
				result = null;
		}

		if (result === BACK) {
			questionIndex--;
			continue;
		}

		if (!result) {
			return {
				content: [{ type: "text", text: "User cancelled the questionnaire" }],
				details: { title: params.title, answers: answers.filter((a): a is StructuredAnswer => a !== undefined), cancelled: true },
			};
		}

		answers[questionIndex] = result;
		questionIndex++;
	}

	const finalAnswers = answers.filter((a): a is StructuredAnswer => a !== undefined);
	const summary = finalAnswers.map(formatAnswer).join("\n");
	return {
		content: [{ type: "text", text: summary }],
		details: { title: params.title, answers: finalAnswers, cancelled: false } satisfies StructuredQuestionsResult,
	};
}

export default function structuredQuestionsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("demo-questions", {
		description: "Open a demo structured questions dialog",
		handler: async (_args, ctx) => {
			const result = await runStructuredQuestions(ctx, {
				title: "Structured Questions Demo",
				questions: [
					{
						id: "scope",
						prompt: "Which areas should I focus on?",
						context:
							"This demo shows long-form context: the agent can put multi-sentence background, analysis, and recommendations here. It wraps fully across lines instead of being truncated, so nothing the agent writes gets cut off mid-thought.",
						type: "multi",
						options: [
							{
								value: "frontend",
								label: "Frontend — component architecture, styling, and the full interactive rendering pipeline",
								description: "A deliberately long label and description to demonstrate that option text now wraps across multiple lines instead of being clipped at a fixed column width.",
								details:
									"This long-form details field is shown in a scrollable pane below the list only while this option is focused. It can hold paragraphs of rationale, trade-offs, and caveats without inflating the always-visible list height. Use PgUp/PgDn to scroll when it overflows the pane cap.",
							},
							{ value: "backend", label: "Backend", description: "APIs and persistence" },
							{ value: "tests", label: "Tests" },
						],
						allowOther: true,
						min: 1,
					},
					{
						id: "priority",
						prompt: "What's the priority?",
						type: "single",
						options: [
							{ value: "p0", label: "P0 - critical", details: "Drop everything. This blocks users right now and each hour of delay compounds the damage." },
							{ value: "p1", label: "P1 - high" },
							{ value: "p2", label: "P2 - normal" },
						],
						allowOther: true,
					},
					{
						id: "notes",
						prompt: "Anything else to consider?",
						context: "Free-text questions can carry context too — it renders above the inline editor.",
						type: "text",
						multiline: true,
					},
				],
			});

			if (!ctx.hasUI) {
				return;
			}

			if (result.details.cancelled) {
				ctx.ui.notify("Demo cancelled.", "info");
				return;
			}

			const summary = result.content.find((block) => block.type === "text")?.text ?? "Demo completed.";
			ctx.ui.notify(`Demo answers:\n${summary}`, "info");
		},
	});

	pi.registerTool({
		name: "ask_questions",
		label: "Ask Questions",
		description:
			"Ask the user structured questions (single-choice, multi-select, or free text) and return normalized answers. Supports long-form question `context` and per-option `details` — all text is fully displayed (word-wrapped, never truncated).",
		promptSnippet: "Ask the user structured questions and return normalized answers.",
		promptGuidelines: [
			"Use ask_questions when you need specific structured input instead of free-form back-and-forth.",
			"Prefer this for short clarifications, constrained choices, or normalized text responses.",
			"Put long background/analysis/recommendations in the question `context` field, keep `prompt` to the actual question.",
			"Keep option `label` short, use `description` for a 1-2 sentence summary, and put longer rationale/trade-offs in the option `details` field (shown on focus).",
			"Use interview instead when the user needs a richer multi-step form with recommendations, media, or longer decision workflows.",
		],
		parameters: StructuredQuestionsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runStructuredQuestions(ctx, params);
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			let text = theme.fg("toolTitle", theme.bold("ask_questions "));
			text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
			if (args.title) {
				text += theme.fg("dim", ` (${args.title})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as StructuredQuestionsResult | undefined;
			if (!details) {
				const content = result.content?.[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				switch (answer.type) {
					case "single":
						return (
							theme.fg("success", "✓ ") +
							theme.fg("accent", answer.id) +
							": " +
							(answer.wasCustom ? theme.fg("muted", "(custom) ") : "") +
							answer.label
						);
					case "multi":
						return (
							theme.fg("success", "✓ ") +
							theme.fg("accent", answer.id) +
							": " +
							answer.values
								.map((value) => `${value.label}${value.wasCustom ? " (custom)" : ""}`)
								.join(", ")
						);
					case "text":
						return theme.fg("success", "✓ ") + theme.fg("accent", answer.id) + ": " + answer.value;
					default:
						return "";
				}
			});

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
