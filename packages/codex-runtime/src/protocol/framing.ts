import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { type Envelope, EnvelopeSchema } from "../gen/pi_codex_runtime_pb.ts";

const FRAME_HEADER_BYTES = 4;

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameSizeError extends Error {
	readonly frameBytes: number;

	constructor(frameBytes: number) {
		super(`protobuf frame size ${frameBytes} exceeds the ${MAX_FRAME_BYTES} byte limit`);
		this.name = "FrameSizeError";
		this.frameBytes = frameBytes;
	}
}

export function encodeFrame(envelope: Envelope): Uint8Array {
	const payload = toBinary(EnvelopeSchema, envelope);
	if (payload.byteLength > MAX_FRAME_BYTES) {
		throw new FrameSizeError(payload.byteLength);
	}

	const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
	new DataView(frame.buffer, frame.byteOffset, FRAME_HEADER_BYTES).setUint32(0, payload.byteLength, false);
	frame.set(payload, FRAME_HEADER_BYTES);
	return frame;
}

export class FrameDecoder {
	private pending = new Uint8Array(0);

	push(chunk: Uint8Array): Envelope[] {
		if (chunk.byteLength === 0) {
			return [];
		}

		const combined = new Uint8Array(this.pending.byteLength + chunk.byteLength);
		combined.set(this.pending);
		combined.set(chunk, this.pending.byteLength);

		const envelopes: Envelope[] = [];
		let offset = 0;
		while (combined.byteLength - offset >= FRAME_HEADER_BYTES) {
			const frameBytes = new DataView(combined.buffer, combined.byteOffset + offset, FRAME_HEADER_BYTES).getUint32(
				0,
				false,
			);
			if (frameBytes > MAX_FRAME_BYTES) {
				throw new FrameSizeError(frameBytes);
			}
			const frameEnd = offset + FRAME_HEADER_BYTES + frameBytes;
			if (frameEnd > combined.byteLength) {
				break;
			}

			const payload = combined.subarray(offset + FRAME_HEADER_BYTES, frameEnd);
			envelopes.push(fromBinary(EnvelopeSchema, payload));
			offset = frameEnd;
		}

		this.pending = combined.slice(offset);
		return envelopes;
	}
}
