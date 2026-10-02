import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@shuv1337/shuvpi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobManager } from "../src/core/background-jobs/manager.ts";
import { JobOutputView } from "../src/core/background-jobs/view.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";

const managers: BackgroundJobManager[] = [];
const directories: string[] = [];
const fixture = fileURLToPath(new URL("./fixtures/background-job.cjs", import.meta.url));
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
});
function manager(bytes?: number) {
	const value = new BackgroundJobManager({ retainedBytes: bytes });
	managers.push(value);
	return value;
}
function command(mode: string, extra = "") {
	return `${process.execPath} ${fixture} ${mode} ${extra}`;
}

describe("session-owned background processes", () => {
	it("captures mixed output, EOF stdin, exit code and bounded tails exactly once", async () => {
		const jobs = manager(64);
		const completed = vi.fn();
		jobs.onSettled(completed);
		const job = jobs.start(command("output"), tmpdir());
		const result = await jobs.wait(job.id);
		expect(result).toMatchObject({ status: "done", exitCode: 0, truncated: true, stderr: "stderr\n" });
		expect(result.stdout).toContain("EOF");
		expect(result.stdoutBytes).toBeGreaterThan(64);
		expect(completed).toHaveBeenCalledOnce();
		expect(await jobs.wait(job.id)).toEqual(result);
	});
	it("enforces eight concurrent starts and aborts a waiter without killing the job", async () => {
		const jobs = manager();
		const started = Array.from({ length: 8 }, () => jobs.start(command("hold"), tmpdir()));
		expect(() => jobs.start(command("hold"), tmpdir())).toThrow("8");
		const controller = new AbortController();
		const waiting = jobs.wait(started[0]!.id, controller.signal);
		controller.abort(new Error("wait cancelled"));
		await expect(waiting).rejects.toThrow("wait cancelled");
		expect(jobs.get(started[0]!.id).status).toBe("running");
		await jobs.close();
		expect(jobs.list().every((job) => job.status === "killed")).toBe(true);
		expect(() => jobs.start("true", tmpdir())).toThrow("closed");
	});
	it.each(["descendant", "orphan-pipe", "orphan-no-pipe", "ignores-term"])(
		"cleans descendant processes for %s and releases waiters",
		async (mode) => {
			const directory = await mkdtemp(join(tmpdir(), "bg-tree-"));
			directories.push(directory);
			const jobs = manager();
			const job = jobs.start(command(mode, directory), directory);
			let pid = 0;
			await vi.waitFor(async () => {
				pid = Number(await readFile(join(directory, "child.pid"), "utf8"));
				expect(pid).toBeGreaterThan(0);
			});
			if (!mode.startsWith("orphan")) await jobs.kill(job.id);
			await jobs.wait(job.id);
			await vi.waitFor(async () => {
				const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "State:\tZ");
				expect(status).toMatch(/State:\s+Z/);
			});
		},
	);
	it("renders ANSI output at narrow sizes and uses configurable exit/navigation keys", () => {
		const done = vi.fn();
		const rerender = vi.fn();
		let rows = 3;
		const keys = new KeybindingsManager({ "tui.select.cancel": "x" });
		const view = new JobOutputView(
			() => Array.from({ length: 20 }, (_, i) => `\u001b[31mline ${i} ${"long".repeat(25)}\u001b[0m`).join("\n"),
			() => rows,
			keys,
			done,
			rerender,
		);
		for (const width of [1, 8, 24])
			expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		view.handleInput("\u001b[6~");
		expect(rerender).toHaveBeenCalled();
		rows = 1;
		expect(view.render(8)).toHaveLength(1);
		view.handleInput("x");
		expect(done).toHaveBeenCalledOnce();
	});
});
