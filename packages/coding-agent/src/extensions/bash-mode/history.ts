import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir } from "../../config.ts";

interface HistoryEntry {
	command: string;
	cwd: string;
	timestamp: number;
}

function historyPath(cwd: string, agentDir: string): string {
	return join(agentDir, "bash-mode", "history", `${createHash("sha256").update(cwd).digest("hex")}.json`);
}

export function readProjectHistory(cwd: string, agentDir = getAgentDir()): HistoryEntry[] {
	try {
		const value: unknown = JSON.parse(readFileSync(historyPath(cwd, agentDir), "utf8"));
		if (!Array.isArray(value)) return [];
		return value
			.filter(
				(entry): entry is HistoryEntry =>
					entry !== null &&
					typeof entry === "object" &&
					typeof entry.command === "string" &&
					typeof entry.cwd === "string" &&
					typeof entry.timestamp === "number" &&
					Number.isFinite(entry.timestamp),
			)
			.sort((a, b) => b.timestamp - a.timestamp);
	} catch {
		return [];
	}
}

export function appendProjectHistory(cwd: string, command: string, entryCwd: string, agentDir = getAgentDir()): void {
	if (!command.trim()) return;
	const path = historyPath(cwd, agentDir);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const entries = [
			{ command: command.trim(), cwd: entryCwd, timestamp: Date.now() },
			...readProjectHistory(cwd, agentDir).filter((entry) => entry.command !== command.trim()),
		].slice(0, 500);
		mkdirSync(join(agentDir, "bash-mode", "history"), { recursive: true, mode: 0o700 });
		writeFileSync(temporary, `${JSON.stringify(entries)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch {
		// History is a best-effort completion cache; a failed save must not fail the shell command.
	} finally {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// An inaccessible or invalid history directory can also prevent temporary-file cleanup.
		}
	}
}

export function readGlobalShellHistory(shellPath: string, explicitPath?: string | null): string[] {
	if (explicitPath === null) return [];
	const shellName = basename(shellPath).toLowerCase();
	const path =
		explicitPath ??
		process.env.HISTFILE ??
		(shellName.includes("fish")
			? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "fish", "fish_history")
			: join(homedir(), shellName.includes("zsh") ? ".zsh_history" : ".bash_history"));
	let fd: number | undefined;
	try {
		if (!existsSync(path)) return [];
		const size = statSync(path).size;
		const start = Math.max(0, size - 2 * 1024 * 1024);
		const data = Buffer.alloc(size - start);
		fd = openSync(path, "r");
		const count = readSync(fd, data, 0, data.length, start);
		const lines = data.subarray(0, count).toString("utf8").split("\n");
		if (start > 0) lines.shift();
		return lines
			.map((line) => {
				if (shellName.includes("fish")) return /^\s*-\s*cmd:\s*(.+)$/.exec(line)?.[1] ?? "";
				if (shellName.includes("zsh")) return line.replace(/^: \d+:\d+;/, "");
				return /^#\d+$/.test(line) ? "" : line;
			})
			.map((line) => line.trim())
			.filter(Boolean)
			.reverse();
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function matchHistoryEntries(entries: string[], prefix: string, limit: number): string[] {
	return [
		...new Set(
			entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0 && entry.startsWith(prefix.trim())),
		),
	].slice(0, limit);
}
