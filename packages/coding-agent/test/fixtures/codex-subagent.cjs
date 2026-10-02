const { createInterface } = require("node:readline");
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const log = process.argv[2];
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(`${log}.pid`, String(descendant.pid));
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let turn = 0;
let active;
const finish = (status = "completed") => {
	write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: active, status } } });
};
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	appendFileSync(log, `${line}\n`);
	if (message.method === "initialize") write({ id: message.id, result: { userAgent: "fake-codex/1" } });
	if (message.method === "thread/start") write({ id: message.id, result: { thread: { id: "thread-1" } } });
	if (message.method === "turn/start") {
		if (active) {
			write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: active } } });
			write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: active, delta: ":stale" } });
			finish();
		}
		active = `turn-${++turn}`;
		if (message.params.input[0].text === "error") {
			write({ id: message.id, error: { code: -32000, message: "fixture failure" } });
			return;
		}
		write({ id: message.id, result: { turn: { id: active } } });
		write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: active } } });
		write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: active, delta: "initial" } });
		if (message.params.input[0].text !== "hold") setTimeout(finish, 20);
	}
	if (message.method === "turn/steer") {
		write({ id: message.id, result: { turnId: active } });
		write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: active, delta: ":steered" } });
		setTimeout(finish, 20);
	}
	if (message.method === "turn/interrupt") { write({ id: message.id, result: {} }); finish("interrupted"); }
});
