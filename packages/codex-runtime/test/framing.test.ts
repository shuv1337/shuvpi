import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { type Envelope, EnvelopeSchema, HandshakeRequestSchema } from "../src/gen/pi_codex_runtime_pb.ts";
import { encodeFrame, FrameDecoder, FrameSizeError, MAX_FRAME_BYTES } from "../src/protocol/framing.ts";

function handshakeEnvelope(clientName: string): Envelope {
	return create(EnvelopeSchema, {
		protocolVersion: 1,
		payload: {
			case: "handshakeRequest",
			value: create(HandshakeRequestSchema, {
				minimumVersion: 1,
				maximumVersion: 1,
				clientName,
				clientVersion: "test",
			}),
		},
	});
}

describe("protobuf frame transport", () => {
	it("round-trips an envelope", () => {
		const decoded = new FrameDecoder().push(encodeFrame(handshakeEnvelope("codex-test")));

		expect(decoded).toHaveLength(1);
		expect(decoded[0].payload.case).toBe("handshakeRequest");
		if (decoded[0].payload.case === "handshakeRequest") {
			expect(decoded[0].payload.value.clientName).toBe("codex-test");
		}
	});

	it("handles a frame delivered one byte at a time", () => {
		const decoder = new FrameDecoder();
		const frame = encodeFrame(handshakeEnvelope("partial"));
		const decoded: Envelope[] = [];
		for (const byte of frame) {
			decoded.push(...decoder.push(Uint8Array.of(byte)));
		}

		expect(decoded).toHaveLength(1);
		expect(decoded[0].payload.case).toBe("handshakeRequest");
	});

	it("decodes coalesced frames", () => {
		const first = encodeFrame(handshakeEnvelope("first"));
		const second = encodeFrame(handshakeEnvelope("second"));
		const combined = new Uint8Array(first.byteLength + second.byteLength);
		combined.set(first);
		combined.set(second, first.byteLength);

		const decoded = new FrameDecoder().push(combined);
		expect(decoded).toHaveLength(2);
		expect(decoded.map((envelope) => envelope.payload.value)).toMatchObject([
			{ clientName: "first" },
			{ clientName: "second" },
		]);
	});

	it("rejects an oversized frame before allocating its body", () => {
		const header = new Uint8Array(4);
		new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);

		expect(() => new FrameDecoder().push(header)).toThrow(FrameSizeError);
	});

	it("rejects malformed protobuf payloads", () => {
		const malformed = Uint8Array.of(0, 0, 0, 1, 0xff);

		expect(() => new FrameDecoder().push(malformed)).toThrow();
	});
});
