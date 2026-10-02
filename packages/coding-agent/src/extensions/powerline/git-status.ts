import { execFile } from "node:child_process";
import type { GitStatus } from "./types.ts";

/** One footer's asynchronous worktree counters; drawing never waits for git. */
export class GitStatusMonitor {
	private readonly cwd: string;
	private readonly onChange: () => void;
	private readonly lifetime = new AbortController();
	private pending: Promise<void> | undefined;
	private counts = { staged: 0, unstaged: 0, untracked: 0 };

	constructor(cwd: string, onChange: () => void) {
		this.cwd = cwd;
		this.onChange = onChange;
	}

	get(branch: string | null): GitStatus {
		return { branch, ...this.counts };
	}

	refresh(): Promise<void> {
		if (this.lifetime.signal.aborted) return Promise.resolve();
		if (this.pending) return this.pending;
		this.pending = new Promise<void>((resolve) => {
			execFile(
				"git",
				["--no-optional-locks", "status", "--porcelain=v1", "-z"],
				{
					cwd: this.cwd,
					encoding: "utf8",
					timeout: 2000,
					maxBuffer: 4 * 1024 * 1024,
					signal: this.lifetime.signal,
				},
				(error, stdout) => {
					if (!this.lifetime.signal.aborted) {
						const counts = { staged: 0, unstaged: 0, untracked: 0 };
						const records = error ? [] : stdout.split("\0");
						for (let i = 0; i < records.length; i++) {
							const record = records[i];
							if (record.length < 3) continue;
							const x = record[0],
								y = record[1];
							if (x === "?" && y === "?") counts.untracked++;
							else {
								if (x !== " " && x !== "?") counts.staged++;
								if (y !== " " && y !== "?") counts.unstaged++;
								// A rename/copy has a second NUL-delimited pathname, not a status record.
								if (x === "R" || x === "C" || y === "R" || y === "C") i++;
							}
						}
						this.counts = counts;
						this.onChange();
					}
					resolve();
				},
			);
		}).finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	dispose(): void {
		this.lifetime.abort();
	}
}
