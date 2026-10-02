import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { requestWorkflowOwner, WorkflowOwnerUnavailableError } from "./owner.ts";
import {
	isWorkflowJsonObject,
	WORKFLOW_OWNER_PROTOCOL_VERSION,
	type WorkflowJsonValue,
	type WorkflowOwnerOperation,
} from "./protocol.ts";

export interface BackgroundOwnerCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly readyTimeoutMs?: number;
}

export interface BackgroundOwnerConnection {
	readonly ownerPid?: number;
	readonly started: boolean;
	request(operation: WorkflowOwnerOperation): Promise<WorkflowJsonValue>;
}

/**
 * Connect to the session's owner, starting one detached process if needed. The detached process is independent of the
 * TUI process lifetime; all subsequent commands travel over its private versioned socket.
 */
export async function connectBackgroundWorkflowOwner(
	socketPath: string,
	owner: BackgroundOwnerCommand,
): Promise<BackgroundOwnerConnection> {
	const existing = await health(socketPath);
	if (existing !== false) return connection(socketPath, existing ?? undefined, false);
	const child = spawn(owner.command, [...owner.args], {
		cwd: owner.cwd,
		env: { ...process.env, ...owner.env },
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	const timeoutMs = owner.readyTimeoutMs ?? 10_000;
	const deadline = Date.now() + timeoutMs;
	let exited: string | undefined;
	let exitedAt: number | undefined;
	child.once("error", (error) => {
		exited = `could not start owner process: ${error.message}`;
		exitedAt = Date.now();
	});
	child.once("exit", (code, signal) => {
		exited = `owner process exited before becoming ready (code ${code ?? "none"}, signal ${signal ?? "none"})`;
		exitedAt = Date.now();
	});
	while (Date.now() < deadline) {
		const ownerPid = await health(socketPath);
		if (ownerPid !== false) return connection(socketPath, ownerPid ?? undefined, ownerPid === child.pid);
		if (exited !== undefined && exitedAt !== undefined && Date.now() - exitedAt >= 250)
			throw new WorkflowOwnerUnavailableError(exited);
		await delay(50);
	}
	if (exited !== undefined) throw new WorkflowOwnerUnavailableError(exited);
	throw new WorkflowOwnerUnavailableError(`Workflow owner did not become ready within ${timeoutMs} ms`);
}

/** A plain client for a background owner that is already running. */
export function workflowOwnerClient(socketPath: string): BackgroundOwnerConnection {
	return connection(socketPath, undefined, false);
}

function connection(socketPath: string, ownerPid: number | undefined, started: boolean): BackgroundOwnerConnection {
	return {
		...(ownerPid === undefined ? {} : { ownerPid }),
		started,
		request: (operation) => requestWorkflowOwner(socketPath, operation),
	};
}

async function health(socketPath: string): Promise<number | null | false> {
	try {
		const value = await requestWorkflowOwner(socketPath, { type: "health" }, { timeoutMs: 500 });
		if (!isWorkflowJsonObject(value) || value.status !== "ready" || value.version !== WORKFLOW_OWNER_PROTOCOL_VERSION)
			return false;
		return typeof value.ownerPid === "number" && Number.isSafeInteger(value.ownerPid) ? value.ownerPid : null;
	} catch {
		return false;
	}
}
