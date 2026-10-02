import type { BashCommandRecord } from "./types.ts";

/** The running command is bounded too, including one long line and blank output. */
export class BashTranscriptStore {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private commands: BashCommandRecord[] = [];

	constructor(maxLines = 500, maxBytes = 128 * 1024) {
		this.maxLines = Math.max(1, maxLines);
		this.maxBytes = Math.max(64, maxBytes);
	}

	startCommand(id: string, command: string, cwdAtStart: string): void {
		this.commands.push({ id, command, cwdAtStart, output: "", exitCode: null, truncated: false });
		this.enforceLimits();
	}

	appendOutput(id: string, chunk: string): void {
		const entry = this.commands.find((candidate) => candidate.id === id);
		if (!entry) return;
		entry.output += chunk;
		this.enforceLimits();
	}

	finishCommand(id: string, exitCode: number): void {
		const entry = this.commands.find((candidate) => candidate.id === id);
		if (entry) entry.exitCode = exitCode;
	}

	clear(): void {
		this.commands = [];
	}

	getSnapshot(): BashCommandRecord[] {
		return this.commands.map((entry) => ({ ...entry }));
	}

	private enforceLimits(): void {
		let bytes = 0;
		let lines = 0;
		for (let index = this.commands.length - 1; index >= 0; index--) {
			const entry = this.commands[index];
			const remainingBytes = this.maxBytes - bytes;
			const remainingLines = this.maxLines - lines;
			if (remainingBytes <= 0 || remainingLines <= 0) {
				this.commands.splice(0, index + 1);
				break;
			}
			// Count the command as a line as well, so silent commands cannot grow the store forever.
			const output = entry.output.split("\n");
			if (output.length + 1 > remainingLines) {
				entry.output = remainingLines <= 1 ? "" : output.slice(-(remainingLines - 1)).join("\n");
				entry.truncated = true;
			}
			const data = Buffer.from(entry.output);
			if (data.length > remainingBytes) {
				let start = data.length - remainingBytes;
				while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
				entry.output = data.subarray(start).toString("utf8");
				entry.truncated = true;
			}
			bytes += Buffer.byteLength(entry.output);
			lines += entry.output.split("\n").length + 1;
		}
	}
}
