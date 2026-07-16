import { create } from "@bufbuild/protobuf";
import {
	type Envelope,
	EnvelopeSchema,
	HandshakeResponseSchema,
	RuntimeErrorSchema,
} from "../gen/pi_codex_runtime_pb.ts";
import { encodeFrame, FrameDecoder } from "./framing.ts";
import { SHUVPI_CODEX_PROTOCOL_VERSION } from "./version.ts";

export interface ProtocolTransport {
	write(frame: Uint8Array): void;
	close(): void;
}

export interface RuntimeProtocolConnectionOptions {
	transport: ProtocolTransport;
	serverVersion: string;
	onEnvelope: (envelope: Envelope) => void;
	onError?: (error: Error) => void;
}

export class ProtocolStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProtocolStateError";
	}
}

export class RuntimeProtocolConnection {
	private readonly decoder = new FrameDecoder();
	private readonly options: RuntimeProtocolConnectionOptions;
	private negotiated = false;
	private closed = false;

	constructor(options: RuntimeProtocolConnectionOptions) {
		this.options = options;
	}

	receive(chunk: Uint8Array): void {
		if (this.closed) {
			return;
		}

		try {
			for (const envelope of this.decoder.push(chunk)) {
				this.receiveEnvelope(envelope);
				if (this.closed) {
					break;
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	send(envelope: Envelope): void {
		if (this.closed) {
			throw new ProtocolStateError("cannot write to a closed runtime connection");
		}
		if (!this.negotiated && envelope.payload.case !== "handshakeResponse") {
			throw new ProtocolStateError("cannot send runtime traffic before protocol negotiation");
		}
		this.options.transport.write(encodeFrame(envelope));
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.options.transport.close();
	}

	private receiveEnvelope(envelope: Envelope): void {
		if (!this.negotiated) {
			this.receiveHandshake(envelope);
			return;
		}
		if (envelope.protocolVersion !== SHUVPI_CODEX_PROTOCOL_VERSION) {
			throw new ProtocolStateError(
				`received protocol version ${envelope.protocolVersion} after negotiating ${SHUVPI_CODEX_PROTOCOL_VERSION}`,
			);
		}
		if (envelope.payload.case === "handshakeRequest" || envelope.payload.case === "handshakeResponse") {
			throw new ProtocolStateError("received a second protocol handshake");
		}
		this.options.onEnvelope(envelope);
	}

	private receiveHandshake(envelope: Envelope): void {
		if (envelope.payload.case !== "handshakeRequest") {
			throw new ProtocolStateError("the first frame must be a handshake request");
		}

		const request = envelope.payload.value;
		if (
			request.minimumVersion > SHUVPI_CODEX_PROTOCOL_VERSION ||
			request.maximumVersion < SHUVPI_CODEX_PROTOCOL_VERSION
		) {
			this.options.transport.write(
				encodeFrame(
					create(EnvelopeSchema, {
						protocolVersion: SHUVPI_CODEX_PROTOCOL_VERSION,
						payload: {
							case: "handshakeResponse",
							value: create(HandshakeResponseSchema, {
								serverName: "pi-codex-runtime",
								serverVersion: this.options.serverVersion,
								error: create(RuntimeErrorSchema, {
									code: "unsupported_protocol_version",
									message: `server supports protocol ${SHUVPI_CODEX_PROTOCOL_VERSION}; client requested ${request.minimumVersion}-${request.maximumVersion}`,
								}),
							}),
						},
					}),
				),
			);
			this.close();
			return;
		}

		this.negotiated = true;
		this.send(
			create(EnvelopeSchema, {
				protocolVersion: SHUVPI_CODEX_PROTOCOL_VERSION,
				payload: {
					case: "handshakeResponse",
					value: create(HandshakeResponseSchema, {
						selectedVersion: SHUVPI_CODEX_PROTOCOL_VERSION,
						serverName: "pi-codex-runtime",
						serverVersion: this.options.serverVersion,
						capabilities: ["sessions", "streaming-events", "host-tools"],
					}),
				},
			}),
		);
	}

	private fail(error: Error): void {
		this.options.onError?.(error);
		this.close();
	}
}
