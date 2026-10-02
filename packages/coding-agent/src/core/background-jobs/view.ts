import { type Component, type KeybindingsManager, truncateToWidth } from "@shuv1337/shuvpi-tui";

/** Read-only output overlay shared by the process and child-agent views. */
export class JobOutputView implements Component {
	private offset = 0;
	private readonly text: () => string;
	private readonly rows: () => number;
	private readonly keys: KeybindingsManager;
	private readonly done: () => void;
	private readonly renderAgain: () => void;
	constructor(
		text: () => string,
		rows: () => number,
		keys: KeybindingsManager,
		done: () => void,
		renderAgain: () => void,
	) {
		this.text = text;
		this.rows = rows;
		this.keys = keys;
		this.done = done;
		this.renderAgain = renderAgain;
	}
	render(width: number): string[] {
		const lines = this.text().split("\n");
		const rows = Math.max(0, this.rows());
		this.offset = Math.max(0, Math.min(this.offset, lines.length - rows));
		return lines
			.slice(this.offset, this.offset + rows)
			.map((line) => truncateToWidth(line.replace(/\r/g, ""), width, ""));
	}
	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "tui.select.confirm")) {
			this.done();
			return;
		}
		if (this.keys.matches(data, "tui.select.up")) this.offset--;
		else if (this.keys.matches(data, "tui.select.down")) this.offset++;
		else if (this.keys.matches(data, "tui.select.pageUp")) this.offset -= this.rows();
		else if (this.keys.matches(data, "tui.select.pageDown")) this.offset += this.rows();
		else return;
		this.renderAgain();
	}
	invalidate(): void {}
}
