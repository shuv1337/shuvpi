import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Envelope } from "../gen/pi_codex_runtime_pb.js";
import { RuntimeProtocolConnection } from "../protocol/connection.ts";

export interface UnixRuntimeServerOptions {
	socketPath: string;
	serverVersion: string;
	onEnvelope: (connection: RuntimeProtocolConnection, envelope: Envelope) => void;
	onConnectionError?: (error: Error) => void;
}

export class UnixRuntimeServer {
	private readonly options: UnixRuntimeServerOptions;
	private readonly connections = new Set<RuntimeProtocolConnection>();
	private server: Server | undefined;

	constructor(options: UnixRuntimeServerOptions) {
		this.options = options;
	}

	async listen(): Promise<void> {
		if (this.server) {
			throw new Error("runtime server is already listening");
		}
		await prepareSocketPath(this.options.socketPath);

		const server = createServer((socket) => this.acceptSocket(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.options.socketPath);
		});
		chmodSync(this.options.socketPath, 0o600);
	}

	async close(): Promise<void> {
		const server = this.server;
		if (!server) {
			return;
		}
		this.server = undefined;
		for (const connection of this.connections) {
			connection.close();
		}
		this.connections.clear();

		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		removeSocketIfPresent(this.options.socketPath);
	}

	private acceptSocket(socket: Socket): void {
		let protocol: RuntimeProtocolConnection | undefined;
		protocol = new RuntimeProtocolConnection({
			serverVersion: this.options.serverVersion,
			transport: {
				write: (frame) => socket.write(frame),
				close: () => socket.end(),
			},
			onEnvelope: (envelope) => {
				if (protocol) {
					this.options.onEnvelope(protocol, envelope);
				}
			},
			onError: this.options.onConnectionError,
		});
		this.connections.add(protocol);
		socket.on("data", (chunk) => protocol?.receive(chunk));
		socket.on("error", (error) => this.options.onConnectionError?.(error));
		socket.on("close", () => {
			if (protocol) {
				this.connections.delete(protocol);
			}
		});
	}
}

async function prepareSocketPath(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}
	if (!lstatSync(socketPath).isSocket()) {
		throw new Error(`refusing to replace non-socket path: ${socketPath}`);
	}

	const active = await new Promise<boolean>((resolve, reject) => {
		const probe = createConnection(socketPath);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", (error: NodeJS.ErrnoException) => {
			probe.destroy();
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
				resolve(false);
				return;
			}
			reject(error);
		});
	});
	if (active) {
		throw new Error(`runtime socket is already in use: ${socketPath}`);
	}
	removeSocketIfPresent(socketPath);
}

function removeSocketIfPresent(socketPath: string): void {
	if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) {
		unlinkSync(socketPath);
	}
}
