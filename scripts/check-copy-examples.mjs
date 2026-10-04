import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ignoredDirectories = new Set([".git", "dist", "node_modules", "vendor"]);

function collectMarkdownFiles(directory, files) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectMarkdownFiles(join(directory, entry.name), files);
			}
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(join(directory, entry.name));
		}
	}
}

function tokenize(line) {
	const tokens = [];
	for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
		tokens.push(match[1] ?? match[2] ?? match[3]);
	}
	return tokens;
}

function normalizeOperand(operand) {
	let path = operand;
	if (path.length > 1) path = path.replace(/\/+$/, "");
	if (path.startsWith("./")) path = path.slice(2);
	return path;
}

function operands(tokens) {
	const result = [];
	let flagsDone = false;
	for (const token of tokens) {
		if (!flagsDone && token === "--") {
			flagsDone = true;
			continue;
		}
		if (!flagsDone && token.startsWith("-") && !token.includes("/")) continue;
		result.push(token);
	}
	return result;
}

function commandOperands(line) {
	const withoutPrompt = line.trim().replace(/^(?:\$\s*)/, "");
	if (!/^cp(?:\s|$)/.test(withoutPrompt)) return undefined;
	const tokens = tokenize(withoutPrompt);
	if (tokens[0] !== "cp") return undefined;
	return operands(tokens.slice(1));
}

const files = [];
collectMarkdownFiles(".", files);
const failures = [];

for (const file of files.sort()) {
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const ops = commandOperands(lines[index]);
		if (!ops || ops.length < 2) continue;
		const destination = normalizeOperand(ops[ops.length - 1]);
		for (const source of ops.slice(0, -1)) {
			if (normalizeOperand(source) === destination) {
				failures.push(`${file}:${index + 1}: cp copies ${source} onto itself`);
			}
		}
	}
}

if (failures.length > 0) {
	console.error("Documentation cp examples must not use the same source and destination:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
