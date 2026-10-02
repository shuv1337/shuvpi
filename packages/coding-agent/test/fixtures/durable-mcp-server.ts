import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const callsFile = process.argv[2];
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
	const message = JSON.parse(line) as {
		id?: number;
		method: string;
		params?: { name: string; arguments: { text: string } };
	};
	if (message.id === undefined) continue;
	let result: unknown;
	if (message.method === "initialize") {
		result = {
			protocolVersion: "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "durable-fixture", version: "1" },
		};
	} else if (message.method === "tools/list") {
		result = {
			tools: [
				{
					name: "echo",
					description: "Count and echo",
					inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
					outputSchema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"] },
					annotations: { readOnlyHint: true },
				},
			],
		};
	} else if (message.method === "tools/call") {
		const text = message.params!.arguments.text;
		appendFileSync(callsFile, `${JSON.stringify({ text })}\n`);
		result = {
			content: [{ type: "text", text }],
			structuredContent: { echo: text },
			...(text === "server-error" ? { isError: true } : {}),
		};
	} else result = {};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
