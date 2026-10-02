const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [mode, directory] = process.argv.slice(2);
if (mode === "output") {
	process.stdout.write("a".repeat(200));
	process.stderr.write("stderr\n");
	process.stdin.on("end", () => process.stdout.write("EOF\n"));
	process.stdin.resume();
} else if (mode === "descendant" || mode === "orphan-pipe" || mode === "orphan-no-pipe" || mode === "ignores-term") {
	const child = spawn(process.execPath, [__filename, mode === "ignores-term" ? "ignore-term-hold" : "hold"], { stdio: mode === "ignores-term" || mode === "orphan-no-pipe" ? "ignore" : "inherit" });
	writeFileSync(join(directory, "child.pid"), String(child.pid));
	if (mode === "orphan-pipe" || mode === "orphan-no-pipe") child.unref();
	else setInterval(() => {}, 1000);
} else if (mode === "hold" || mode === "ignore-term-hold") { if (mode === "ignore-term-hold") process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else process.exitCode = 2;
