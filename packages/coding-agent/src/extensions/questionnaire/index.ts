import { type Static, StringEnum, Type } from "@shuv1337/shuvpi-ai";
import {
	type Component,
	CURSOR_MARKER,
	Editor,
	Input,
	type Keybinding,
	type KeybindingsManager,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@shuv1337/shuvpi-tui";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { getEditorTheme, type Theme } from "../../modes/interactive/theme/theme.ts";

const OptionSchema = Type.Object({
	value: Type.String(),
	label: Type.String(),
	description: Type.Optional(Type.String({ description: "Short option summary" })),
	details: Type.Optional(Type.String({ description: "Long rationale shown when focused" })),
});
const QuestionSchema = Type.Object({
	id: Type.String(),
	prompt: Type.String(),
	context: Type.Optional(Type.String({ description: "Background and trade-offs, shown above the choices" })),
	type: StringEnum(["single", "multi", "text"]),
	options: Type.Optional(Type.Array(OptionSchema)),
	allowOther: Type.Optional(Type.Boolean()),
	min: Type.Optional(Type.Integer({ minimum: 0 })),
	max: Type.Optional(Type.Integer({ minimum: 0 })),
	placeholder: Type.Optional(Type.String()),
	multiline: Type.Optional(Type.Boolean()),
});
export const QuestionnaireSchema = Type.Object({
	title: Type.Optional(Type.String()),
	questions: Type.Array(QuestionSchema, { minItems: 1 }),
});
export type QuestionnaireParams = Static<typeof QuestionnaireSchema>;
type Question = Static<typeof QuestionSchema>;
type AnswerItem = { value: string; label: string; wasCustom?: boolean };
export type QuestionnaireAnswer =
	| ({ id: string; type: "single" } & AnswerItem)
	| { id: string; type: "multi"; values: AnswerItem[] }
	| { id: string; type: "text"; value: string };
export interface QuestionnaireResult {
	title?: string;
	answers: QuestionnaireAnswer[];
	cancelled: boolean;
}
interface QuestionState {
	focus: number;
	selected: Set<number>;
	custom: AnswerItem[];
	text: string;
}

/** A bounded viewport keeps every context, description and detail line reachable. */
export class Questionnaire implements Component {
	private readonly params: QuestionnaireParams;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (result: QuestionnaireResult) => void;
	private readonly states: QuestionState[];
	private readonly answers: Array<QuestionnaireAnswer | undefined>;
	private index = 0;
	private scroll = 0;
	private pageSize = 1;
	private totalLines = 0;
	private revealFocus = false;
	private input: Input | Editor | undefined;
	private customInput = false;
	private error = "";
	private finished = false;

	constructor(
		params: QuestionnaireParams,
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: (result: QuestionnaireResult) => void,
	) {
		this.params = params;
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.states = params.questions.map(() => ({ focus: 0, selected: new Set(), custom: [], text: "" }));
		this.answers = new Array(params.questions.length);
		this.openQuestion();
	}

	cancel(): void {
		this.finish(true);
	}

	private finish(cancelled: boolean): void {
		if (this.finished) return;
		this.finished = true;
		this.done({
			title: this.params.title,
			answers: this.answers.filter((answer) => answer !== undefined),
			cancelled,
		});
	}

	private openQuestion(): void {
		this.scroll = 0;
		this.error = "";
		this.revealFocus = false;
		this.customInput = false;
		this.input = undefined;
		if (this.params.questions[this.index].type === "text") this.openInput(false);
	}

	private openInput(custom: boolean): void {
		const question = this.params.questions[this.index];
		this.customInput = custom;
		const input = question.multiline
			? new Editor(this.tui, getEditorTheme())
			: new Input({ placeholder: question.placeholder });
		const text = custom ? "" : this.states[this.index].text;
		if (input instanceof Editor) input.setText(text);
		else input.setValue(text);
		input.focused = true;
		input.onSubmit = (value) => {
			if (custom) {
				value = value.trim();
				if (!value) {
					this.error = "Enter a response";
					return;
				}
				const state = this.states[this.index];
				const existing = state.custom.findIndex((item) => item.value === value);
				if (existing < 0) state.custom.push({ value, label: value, wasCustom: true });
				const choice = (question.options?.length ?? 0) + (existing < 0 ? state.custom.length - 1 : existing);
				state.focus = choice;
				if (question.type === "single")
					this.advance({ id: question.id, type: "single", value, label: value, wasCustom: true });
				else {
					this.input = undefined;
					this.customInput = false;
					if (!state.selected.has(choice)) this.toggle(choice);
					this.revealFocus = true;
				}
			} else {
				this.states[this.index].text = value;
				this.advance({ id: question.id, type: "text", value });
			}
		};
		this.input = input;
	}

	private advance(answer: QuestionnaireAnswer): void {
		this.answers[this.index] = answer;
		if (this.index === this.params.questions.length - 1) this.finish(false);
		else {
			this.index++;
			this.openQuestion();
		}
	}

	private toggle(index: number): void {
		const state = this.states[this.index];
		const max = this.params.questions[this.index].max ?? Number.POSITIVE_INFINITY;
		this.error = "";
		if (state.selected.has(index)) state.selected.delete(index);
		else if (state.selected.size >= max) this.error = `Select at most ${max}`;
		else state.selected.add(index);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		const question = this.params.questions[this.index];
		const state = this.states[this.index];
		if (this.keys.matches(data, "tui.select.cancel")) {
			if (this.customInput) {
				this.customInput = false;
				this.input = undefined;
				this.error = "";
			} else if (this.index > 0) {
				if (this.input) state.text = this.input instanceof Editor ? this.input.getText() : this.input.getValue();
				this.index--;
				this.openQuestion();
			} else this.cancel();
		} else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll -= this.pageSize;
		else if (this.keys.matches(data, "tui.select.pageDown")) this.scroll += this.pageSize;
		else if (this.input) this.input.handleInput(data);
		else {
			const options = [...(question.options ?? []), ...state.custom];
			const count = options.length + (question.allowOther ? 1 : 0);
			if (this.keys.matches(data, "tui.select.up")) {
				state.focus = Math.max(0, state.focus - 1);
				this.revealFocus = true;
			} else if (this.keys.matches(data, "tui.select.down")) {
				state.focus = Math.min(count - 1, state.focus + 1);
				this.revealFocus = true;
			} else if (
				this.keys.matches(data, "tui.select.confirm") ||
				this.keys.matches(data, "app.questionnaire.toggle")
			) {
				if (question.type === "multi" && this.keys.matches(data, "tui.select.confirm")) {
					const min = question.min ?? 0;
					if (state.selected.size < min) this.error = `Select at least ${min}`;
					else
						this.advance({
							id: question.id,
							type: "multi",
							values: [...state.selected]
								.sort((a, b) => a - b)
								.map((i) => {
									const option = options[i];
									return {
										value: option.value,
										label: option.label,
										...("wasCustom" in option ? { wasCustom: option.wasCustom } : {}),
									};
								}),
						});
				} else if (state.focus === options.length) this.openInput(true);
				else if (question.type === "multi") this.toggle(state.focus);
				else {
					state.selected = new Set([state.focus]);
					const option = options[state.focus];
					this.advance({
						id: question.id,
						type: "single",
						value: option.value,
						label: option.label,
						...("wasCustom" in option ? { wasCustom: option.wasCustom } : {}),
					});
				}
			}
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const rows = this.tui.terminal.rows;
		if (width <= 0 || rows <= 0) return [];
		const question = this.params.questions[this.index];
		const state = this.states[this.index];
		const body = [
			...wrapTextWithAnsi(this.theme.fg("text", question.prompt), width),
			...(question.context ? ["", ...wrapTextWithAnsi(this.theme.fg("muted", question.context), width)] : []),
		];
		const options = [...(question.options ?? []), ...state.custom];
		const optionStarts: number[] = [];
		if (question.type !== "text") {
			body.push("");
			for (const [index, option] of [
				...options,
				...(question.allowOther ? [{ value: "", label: "Other response" }] : []),
			].entries()) {
				optionStarts.push(body.length);
				const marker = `${index === state.focus ? ">" : " "} ${question.type === "multi" ? (state.selected.has(index) ? "[x] " : "[ ] ") : ""}`;
				body.push(
					...wrapTextWithAnsi(
						this.theme.fg(index === state.focus ? "accent" : "text", marker + option.label),
						width,
					),
				);
				if ("description" in option && option.description)
					body.push(...wrapTextWithAnsi(this.theme.fg("muted", option.description), width));
				if (index === state.focus && "details" in option && option.details)
					body.push(...wrapTextWithAnsi(this.theme.fg("muted", option.details), width));
			}
		}
		const inputLines = this.input?.render(width) ?? [];
		const inputBudget = Math.max(0, Math.min(inputLines.length, Math.floor(rows / 2)));
		const cursorLine = inputLines.findIndex((line) => line.includes(CURSOR_MARKER));
		const inputStart = Math.max(
			0,
			Math.min(Math.max(0, cursorLine - inputBudget + 1), inputLines.length - inputBudget),
		);
		this.pageSize = Math.max(0, rows - 3 - inputBudget);
		this.totalLines = body.length;
		if (this.revealFocus) {
			const target = optionStarts[state.focus] ?? 0;
			if (target < this.scroll || target >= this.scroll + this.pageSize) this.scroll = target;
			this.revealFocus = false;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, this.totalLines - this.pageSize));
		const actions: Array<[Keybinding, string]> = [
			["tui.select.cancel", this.customInput || this.index > 0 ? "back" : "cancel"],
			["tui.select.pageUp", "scroll up"],
			["tui.select.pageDown", "scroll down"],
			[this.input ? "tui.input.submit" : "tui.select.confirm", "confirm"],
		];
		if (!this.input) actions.push(["tui.select.up", "up"], ["tui.select.down", "down"]);
		if (!this.input && question.type === "multi") actions.push(["app.questionnaire.toggle", "toggle"]);
		const hints = actions
			.flatMap(([action, label]) => {
				const keys = this.keys.getKeys(action);
				return keys.length ? [`${keys.join("/")} ${label}`] : [];
			})
			.join("  ");
		return [
			this.theme.fg(
				"accent",
				`${this.params.title ?? "Questions"} (${this.index + 1}/${this.params.questions.length})`,
			),
			...body.slice(this.scroll, this.scroll + this.pageSize),
			...inputLines.slice(inputStart, inputStart + inputBudget),
			this.error
				? this.theme.fg("warning", this.error)
				: this.theme.fg(
						"dim",
						`${question.type === "multi" ? `${state.selected.size} selected · ` : ""}Lines ${Math.min(this.scroll + 1, body.length)}–${Math.min(this.scroll + this.pageSize, body.length)} / ${body.length}`,
					),
			this.theme.fg("dim", hints),
		]
			.slice(0, rows)
			.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.input?.invalidate();
	}
}

function validateQuestions(questions: Question[]): void {
	if (questions.length === 0) throw new Error("Provide at least one question");
	const ids = new Set<string>();
	for (const question of questions) {
		if (!question.id.trim() || ids.has(question.id)) throw new Error("Question IDs must be nonempty and unique");
		ids.add(question.id);
		if (question.type === "text") continue;
		if (!question.options?.length) throw new Error(`Question ${question.id} requires options`);
		if (new Set(question.options.map((option) => option.value)).size !== question.options.length)
			throw new Error(`Question ${question.id} has duplicate option values`);
		if (
			question.type === "multi" &&
			((question.min ?? 0) > (question.max ?? Infinity) ||
				(!question.allowOther && (question.min ?? 0) > question.options.length))
		)
			throw new Error(`Question ${question.id} has impossible selection limits`);
	}
}

function formatAnswers(result: QuestionnaireResult): string {
	return result.cancelled
		? "Questionnaire cancelled"
		: result.answers
				.map(
					(answer) =>
						`${answer.id}: ${answer.type === "multi" ? answer.values.map((value) => value.label).join(", ") : answer.type === "single" ? answer.label : answer.value}`,
				)
				.join("\n");
}

export function createQuestionnaireExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool<typeof QuestionnaireSchema, QuestionnaireResult>({
			name: "ask_user",
			label: "Ask user",
			description:
				"Ask structured single-choice, multiple-choice or text questions. Supports custom responses and back navigation. Interactive sessions only.",
			promptSnippet: "Ask the user structured questions and return normalized answers.",
			promptGuidelines: [
				"Keep prompts and option labels short. Put background in context and longer option rationale in details.",
			],
			parameters: QuestionnaireSchema,
			async execute(_id, params, signal, _update, ctx) {
				if (!ctx.hasUI) throw new Error("ask_user requires an interactive UI");
				validateQuestions(params.questions);
				let cancel: (() => void) | undefined;
				try {
					const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, keys, done) => {
						const questionnaire = new Questionnaire(params, tui, theme, keys, done);
						cancel = () => questionnaire.cancel();
						signal?.addEventListener("abort", cancel, { once: true });
						if (signal?.aborted) cancel();
						return questionnaire;
					});
					const details = result ?? { title: params.title, answers: [], cancelled: true };
					return { content: [{ type: "text", text: formatAnswers(details) }], details };
				} finally {
					if (cancel) signal?.removeEventListener("abort", cancel);
				}
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", `ask_user ${args.title ?? ""}`), 0, 0);
			},
			renderResult(result) {
				return new Text(
					result.details
						? formatAnswers(result.details)
						: result.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
					0,
					0,
				);
			},
		});
	};
}
