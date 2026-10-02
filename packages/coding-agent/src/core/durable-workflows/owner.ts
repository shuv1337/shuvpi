import { randomUUID } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	isWorkflowJsonValue,
	isWorkflowOwnerRequest,
	isWorkflowOwnerResponse,
	WORKFLOW_OWNER_MAX_FRAME_BYTES,
	WORKFLOW_OWNER_PROTOCOL_VERSION,
	type WorkflowJsonValue,
	type WorkflowOwnerOperation,
	type WorkflowOwnerRequest,
	type WorkflowOwnerResponse,
} from "./protocol.ts";

const OWNER_PROBE_TIMEOUT_MS = 750;

export interface WorkflowOwnerOptions {
	readonly socketPath: string;
	readonly handle: (operation: WorkflowOwnerOperation) => Promise<WorkflowJsonValue>;
	readonly maxFrameBytes?: number;
}

export interface WorkflowOwner {
	close(): Promise<void>;
}

export class WorkflowOwnerUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowOwnerUnavailableError";
	}
}

/**
 * Owns the private Unix socket for the lifetime of the background process. A held SQLite write transaction
 * serializes acquisition and stale-socket cleanup; the kernel releases it only after process death, so heartbeat
 * age is never used to steal ownership.
 */
export async function startWorkflowOwner(options: WorkflowOwnerOptions): Promise<WorkflowOwner> {
	const maxFrameBytes = options.maxFrameBytes ?? WORKFLOW_OWNER_MAX_FRAME_BYTES;
	if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024) {
		throw new RangeError("Workflow owner frame limit must be at least 1024 bytes");
	}
	await ensurePrivateDirectory(dirname(options.socketPath));
	const lockDatabase = new DatabaseSync(`${options.socketPath}.lock.sqlite`, { timeout: 0 });
	try {
		// BEGIN IMMEDIATE is the atomic cross-process ownership gate. Keep the transaction open for the
		// owner's lifetime; the kernel releases it on process death, including SIGKILL, and SIGSTOP
		// cannot make a live owner appear stale.
		lockDatabase.exec("BEGIN IMMEDIATE");
	} catch (error) {
		lockDatabase.close();
		if (isSqliteBusy(error)) {
			throw new WorkflowOwnerUnavailableError(`A workflow owner already holds ${options.socketPath}`);
		}
		throw error;
	}
	let acquired = false;
	try {
		const server = createServer((socket) => handleConnection(socket, options.handle, maxFrameBytes));
		try {
			await listen(server, options.socketPath);
		} catch (error) {
			if (!isNodeError(error, "EADDRINUSE")) throw error;
			await removeStaleSocket(options.socketPath, maxFrameBytes);
			await listen(server, options.socketPath);
		}
		acquired = true;
		const clients = new Set<Socket>();
		server.on("connection", (socket) => {
			clients.add(socket);
			socket.once("close", () => clients.delete(socket));
		});
		let closing: Promise<void> | undefined;
		return {
			close() {
				closing ??= (async () => {
					try {
						for (const client of clients) client.destroy();
						await new Promise<void>((resolve, reject) => {
							server.close((error) => (error === undefined ? resolve() : reject(error)));
						});
						await unlink(options.socketPath).catch((error: unknown) => {
							if (!isNodeError(error, "ENOENT")) throw error;
						});
					} finally {
						lockDatabase.exec("ROLLBACK");
						lockDatabase.close();
					}
				})();
				return closing;
			},
		};
	} finally {
		if (!acquired) {
			try {
				lockDatabase.exec("ROLLBACK");
			} finally {
				lockDatabase.close();
			}
		}
	}
}

async function removeStaleSocket(socketPath: string, maxFrameBytes: number): Promise<void> {
	const stale = await probeExistingOwner(socketPath, maxFrameBytes);
	if (!stale) {
		throw new WorkflowOwnerUnavailableError(
			`A workflow owner holds ${socketPath} but did not answer; ownership remains with that process`,
		);
	}
	const file = await lstat(socketPath).catch((error: unknown) => {
		if (isNodeError(error, "ENOENT")) return undefined;
		throw error;
	});
	if (file === undefined) return;
	if (!file.isSocket()) {
		throw new WorkflowOwnerUnavailableError(`Workflow owner path is occupied by a non-socket: ${socketPath}`);
	}
	await unlink(socketPath).catch((error: unknown) => {
		if (!isNodeError(error, "ENOENT")) throw error;
	});
}

/** Send one bounded operation to an already running owner. */
export async function requestWorkflowOwner(
	socketPath: string,
	operation: WorkflowOwnerOperation,
	options: { readonly timeoutMs?: number; readonly maxFrameBytes?: number } = {},
): Promise<WorkflowJsonValue> {
	const request: WorkflowOwnerRequest = {
		version: WORKFLOW_OWNER_PROTOCOL_VERSION,
		requestId: randomUUID(),
		operation,
	};
	if (!isWorkflowJsonValue(request)) throw new TypeError("Workflow owner request must contain JSON values only");
	const maxFrameBytes = options.maxFrameBytes ?? WORKFLOW_OWNER_MAX_FRAME_BYTES;
	const encoded = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(encoded) > maxFrameBytes)
		throw new RangeError("Workflow owner request exceeds its frame limit");
	const timeoutMs = options.timeoutMs ?? 30_000;
	return exchange(socketPath, encoded, request.requestId, timeoutMs, maxFrameBytes);
}

async function handleConnection(
	socket: Socket,
	handle: WorkflowOwnerOptions["handle"],
	maxFrameBytes: number,
): Promise<void> {
	// Clients may disconnect at any point, including while the response is being written.
	socket.on("error", () => {});
	socket.setEncoding("utf8");
	let buffer = "";
	let settled = false;
	const reject = (requestId: string, error: string): void => {
		if (settled || socket.destroyed) return;
		settled = true;
		const response: WorkflowOwnerResponse = {
			version: WORKFLOW_OWNER_PROTOCOL_VERSION,
			requestId,
			ok: false,
			error,
		};
		socket.end(`${JSON.stringify(response)}\n`);
	};
	socket.on("data", (chunk: string) => {
		if (settled) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer) > maxFrameBytes) {
			reject("", "Workflow owner request exceeds its frame limit");
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline === -1) return;
		if (newline !== buffer.length - 1) {
			reject("", "Workflow owner accepts exactly one request frame per connection");
			return;
		}
		settled = true;
		void answer(buffer.slice(0, -1), handle, socket, maxFrameBytes);
	});
	socket.once("end", () => {
		if (buffer.length > 0 && buffer.indexOf("\n") === -1) reject("", "Workflow owner request frame is incomplete");
	});
}

async function answer(
	frame: string,
	handle: WorkflowOwnerOptions["handle"],
	socket: Socket,
	maxFrameBytes: number,
): Promise<void> {
	let requestId = "";
	let response: WorkflowOwnerResponse;
	try {
		const value: unknown = JSON.parse(frame);
		if (!isWorkflowOwnerRequest(value)) throw new Error("Workflow owner request has an unsupported shape or version");
		requestId = value.requestId;
		const result =
			value.operation.type === "health"
				? { status: "ready", version: WORKFLOW_OWNER_PROTOCOL_VERSION, ownerPid: process.pid }
				: await handle(value.operation);
		if (!isWorkflowJsonValue(result)) throw new TypeError("Workflow owner handler returned a non-JSON value");
		response = { version: WORKFLOW_OWNER_PROTOCOL_VERSION, requestId, ok: true, value: result };
	} catch (error) {
		response = {
			version: WORKFLOW_OWNER_PROTOCOL_VERSION,
			requestId,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const encoded = `${JSON.stringify(response)}\n`;
	if (Buffer.byteLength(encoded) > maxFrameBytes) {
		socket.end(
			`${JSON.stringify({
				version: WORKFLOW_OWNER_PROTOCOL_VERSION,
				requestId,
				ok: false,
				error: "Workflow owner response exceeds its frame limit",
			} satisfies WorkflowOwnerResponse)}\n`,
		);
		return;
	}
	socket.end(encoded);
}

async function probeExistingOwner(socketPath: string, maxFrameBytes: number): Promise<boolean> {
	try {
		await exchange(
			socketPath,
			`${JSON.stringify({
				version: WORKFLOW_OWNER_PROTOCOL_VERSION,
				requestId: randomUUID(),
				operation: { type: "health" },
			} satisfies WorkflowOwnerRequest)}\n`,
			"",
			OWNER_PROBE_TIMEOUT_MS,
			maxFrameBytes,
		);
		return false;
	} catch (error) {
		if (error instanceof OwnerSocketError && error.code === "ECONNREFUSED") return true;
		if (error instanceof OwnerSocketError && error.code === "ENOENT") return true;
		return false;
	}
}

class OwnerSocketError extends Error {
	readonly code: string | undefined;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "OwnerSocketError";
		this.code = code;
	}
}

function exchange(
	socketPath: string,
	encoded: string,
	requestId: string,
	timeoutMs: number,
	maxFrameBytes: number,
): Promise<WorkflowJsonValue> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;
		const finish = (error?: Error, value?: WorkflowJsonValue): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			if (error !== undefined) reject(error);
			else resolve(value ?? null);
		};
		const timeout = setTimeout(
			() => finish(new OwnerSocketError(`Timed out waiting for workflow owner at ${socketPath}`)),
			timeoutMs,
		);
		socket.once("connect", () => socket.write(encoded));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > maxFrameBytes) {
				finish(new OwnerSocketError("Workflow owner response exceeds its frame limit"));
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			if (newline !== buffer.length - 1) {
				finish(new OwnerSocketError("Workflow owner sent multiple response frames"));
				return;
			}
			try {
				const response: unknown = JSON.parse(buffer.slice(0, -1));
				if (!isWorkflowOwnerResponse(response) || response.requestId !== requestId) {
					throw new OwnerSocketError("Workflow owner response version or request ID did not match");
				}
				if (!response.ok) throw new OwnerSocketError(response.error);
				finish(undefined, response.value);
			} catch (error) {
				finish(error instanceof Error ? error : new OwnerSocketError(String(error)));
			}
		});
		socket.once("error", (error: NodeJS.ErrnoException) => finish(new OwnerSocketError(error.message, error.code)));
		socket.once("end", () => {
			if (!settled) finish(new OwnerSocketError("Workflow owner closed before responding"));
		});
	});
}

async function listen(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new WorkflowOwnerUnavailableError(`Workflow owner directory is not a real directory: ${path}`);
	}
	if ((stat.mode & 0o077) !== 0) {
		throw new WorkflowOwnerUnavailableError(`Workflow owner directory must be private (mode 0700): ${path}`);
	}
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}

function isSqliteBusy(error: unknown): boolean {
	return (
		error instanceof Error &&
		(("code" in error && error.code === "ERR_SQLITE_BUSY") || error.message.includes("database is locked"))
	);
}
