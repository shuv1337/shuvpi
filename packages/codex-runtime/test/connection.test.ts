import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type Envelope,
	EnvelopeSchema,
	HandshakeRequestSchema,
	RuntimeRequestSchema,
	StatusRequestSchema,
} from "../src/gen/pi_codex_runtime_pb.ts";
import { ProtocolStateError, type ProtocolTransport, RuntimeProtocolConnection } from "../src/protocol/connection.ts";
import { encodeFrame, FrameDecoder } from "../src/protocol/framing.ts";

class RecordingTransport implements ProtocolTransport {
	readonly writes: Uint8Array[] = [];
	closed = false;

	write(frame: Uint8Array): void {
		this.writes.push(frame);
	}

	close(): void {
		this.closed = true;
	}
}

function handshake(minimumVersion = 2, maximumVersion = 2): Envelope {
	return create(EnvelopeSchema, {
		payload: {
			case: "handshakeRequest",
			value: create(HandshakeRequestSchema, {
				minimumVersion,
				maximumVersion,
				clientName: "codex-test",
				clientVersion: "test",
			}),
		},
	});
}

function statusRequest(): Envelope {
	return create(EnvelopeSchema, {
		protocolVersion: 2,
		payload: {
			case: "request",
			value: create(RuntimeRequestSchema, {
				requestId: "request-1",
				sessionId: "session-1",
				command: { case: "status", value: create(StatusRequestSchema) },
			}),
		},
	});
}

function decodeWrite(transport: RecordingTransport): Envelope {
	const decoded = new FrameDecoder().push(transport.writes.at(-1) ?? new Uint8Array());
	expect(decoded).toHaveLength(1);
	return decoded[0];
}

describe("runtime protocol negotiation", () => {
	it("negotiates version 2 before delivering runtime traffic", () => {
		const transport = new RecordingTransport();
		const received: Envelope[] = [];
		const connection = new RuntimeProtocolConnection({
			transport,
			serverVersion: "0.80.6",
			onEnvelope: (envelope) => received.push(envelope),
		});

		connection.receive(encodeFrame(handshake()));
		const response = decodeWrite(transport);
		expect(response.payload.case).toBe("handshakeResponse");
		if (response.payload.case === "handshakeResponse") {
			expect(response.payload.value.selectedVersion).toBe(2);
			expect(response.payload.value.capabilities).toContain("host-tools");
		}

		connection.receive(encodeFrame(statusRequest()));
		expect(received).toHaveLength(1);
		expect(received[0].payload.case).toBe("request");
		expect(transport.closed).toBe(false);
	});

	it("returns a structured rejection for incompatible versions", () => {
		const transport = new RecordingTransport();
		const connection = new RuntimeProtocolConnection({
			transport,
			serverVersion: "0.80.6",
			onEnvelope: () => undefined,
		});

		connection.receive(encodeFrame(handshake(1, 1)));
		const response = decodeWrite(transport);
		expect(response.payload.case).toBe("handshakeResponse");
		if (response.payload.case === "handshakeResponse") {
			expect(response.payload.value.selectedVersion).toBe(0);
			expect(response.payload.value.error?.code).toBe("unsupported_protocol_version");
		}
		expect(transport.closed).toBe(true);
	});

	it("closes when runtime traffic arrives before the handshake", () => {
		const transport = new RecordingTransport();
		const errors: Error[] = [];
		const connection = new RuntimeProtocolConnection({
			transport,
			serverVersion: "0.80.6",
			onEnvelope: () => undefined,
			onError: (error) => errors.push(error),
		});

		connection.receive(encodeFrame(statusRequest()));
		expect(errors[0]).toBeInstanceOf(ProtocolStateError);
		expect(transport.closed).toBe(true);
	});
});
