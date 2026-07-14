import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Envelope,
	EnvelopeSchema,
	HandshakeRequestSchema,
	RuntimeRequestSchema,
	StatusRequestSchema,
} from "../src/gen/pi_codex_runtime_pb.ts";
import { encodeFrame, FrameDecoder } from "../src/protocol/framing.ts";
import { UnixRuntimeServer } from "../src/server/unix-runtime-server.ts";

describe("UnixRuntimeServer", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("negotiates over a mode-0600 Unix socket and forwards requests", async () => {
		const directory = join(tmpdir(), `pi-codex-runtime-${process.pid}-${Date.now()}`);
		mkdirSync(directory, { recursive: true });
		const socketPath = join(directory, "runtime.sock");
		const received: Envelope[] = [];
		const server = new UnixRuntimeServer({
			socketPath,
			serverVersion: "0.80.6",
			onEnvelope: (_connection, envelope) => received.push(envelope),
		});
		await server.listen();
		cleanups.push(async () => {
			await server.close();
			rmSync(directory, { recursive: true, force: true });
		});

		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
		const socket = await connect(socketPath);
		cleanups.push(() => {
			socket.destroy();
		});
		const nextEnvelope = envelopeReader(socket);
		socket.write(
			encodeFrame(
				create(EnvelopeSchema, {
					payload: {
						case: "handshakeRequest",
						value: create(HandshakeRequestSchema, {
							minimumVersion: 1,
							maximumVersion: 1,
							clientName: "rust-provider-test",
						}),
					},
				}),
			),
		);

		const handshake = await nextEnvelope();
		expect(handshake.payload.case).toBe("handshakeResponse");
		socket.write(
			encodeFrame(
				create(EnvelopeSchema, {
					protocolVersion: 1,
					payload: {
						case: "request",
						value: create(RuntimeRequestSchema, {
							requestId: "status-1",
							sessionId: "session-1",
							command: { case: "status", value: create(StatusRequestSchema) },
						}),
					},
				}),
			),
		);
		await expect.poll(() => received.length).toBe(1);
		expect(received[0].payload.case).toBe("request");
	});
});

function connect(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function envelopeReader(socket: Socket): () => Promise<Envelope> {
	const decoder = new FrameDecoder();
	const pending: Envelope[] = [];
	const waiters: Array<(envelope: Envelope) => void> = [];
	socket.on("data", (chunk) => {
		for (const envelope of decoder.push(chunk)) {
			const waiter = waiters.shift();
			if (waiter) {
				waiter(envelope);
			} else {
				pending.push(envelope);
			}
		}
	});
	return () => {
		const envelope = pending.shift();
		if (envelope) {
			return Promise.resolve(envelope);
		}
		return new Promise((resolve) => waiters.push(resolve));
	};
}
