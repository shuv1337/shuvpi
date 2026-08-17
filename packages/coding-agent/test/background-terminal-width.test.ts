import type { Theme } from "@shuv1337/shuvpi-coding-agent";
import { visibleWidth } from "@shuv1337/shuvpi-tui";
import { describe, expect, it } from "vitest";
import { createBackgroundTerminalStatusWidget } from "../vendor/pi-shuv/vendor/background-terminals/index.ts";

const theme = {
	fg: (_color, text) => `\x1b[31m${text}\x1b[39m`,
} as Pick<Theme, "fg">;

describe("background terminal status widget", () => {
	it.each([
		[1, 43],
		[2, 43],
		[12, 43],
		[2, 1],
	])("fits a narrow terminal with %i running terminals at width %i", (running, width) => {
		const widget = createBackgroundTerminalStatusWidget(theme, running);
		const [line] = widget.render(width);

		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
