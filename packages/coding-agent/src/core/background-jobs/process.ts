import { type ChildProcess, spawn } from "node:child_process";

/** Stop the entire inherited process group and bound teardown even when descendants retain stdout. */
export async function terminateProcessGroup(child: ChildProcess, graceMs = 300, leaderClosed = false): Promise<void> {
	let closed = leaderClosed;
	const finished = Promise.withResolvers<void>();
	if (leaderClosed) finished.resolve();
	const onClose = () => {
		closed = true;
		finished.resolve();
	};
	child.once("close", onClose);
	const signal = (value: NodeJS.Signals) => {
		if (process.platform === "win32" && child.pid) {
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", () => {
				try {
					child.kill(value);
				} catch {}
			});
			killer.unref();
		} else {
			try {
				if (child.pid) process.kill(-child.pid, value);
				else child.kill(value);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
					try {
						child.kill(value);
					} catch {}
				}
			}
		}
	};
	const wait = async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			finished.promise,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, graceMs);
			}),
		]);
		if (timer) clearTimeout(timer);
	};
	try {
		signal("SIGTERM");
		await wait();
		// A closed leader does not prove descendants in its process group exited.
		signal("SIGKILL");
		if (!closed) {
			await wait();
		}
	} finally {
		child.off("close", onClose);
		if (!closed) {
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.stdin?.destroy();
		}
	}
}
