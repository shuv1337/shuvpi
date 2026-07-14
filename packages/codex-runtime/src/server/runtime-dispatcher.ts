import { create } from "@bufbuild/protobuf";
import {
	AckSchema,
	type Envelope,
	EnvelopeSchema,
	HostToolRequestSchema,
	type HostToolResult,
	RuntimeErrorSchema,
	type RuntimeRequest,
	type RuntimeResponse,
	RuntimeResponseSchema,
	type SessionEvent,
	type SessionStatus,
	SpawnedSessionSchema,
} from "../gen/pi_codex_runtime_pb.ts";
import { PI_CODEX_PROTOCOL_VERSION } from "../protocol/version.ts";
import { PiSdkSessionFactory, type ResumePiSessionOptions, type SpawnPiSessionOptions } from "../sdk/pi-sdk-session.ts";

export interface RuntimeResponseSink {
	send(envelope: Envelope): void;
}

export interface RuntimeSession {
	readonly sessionLocator: string;
	readonly provider: string;
	readonly model: string;
	readonly thinkingLevel: string;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	interrupt(): Promise<void>;
	status(): SessionStatus;
	reportError(code: string, message: string, retryable?: boolean): void;
	close(): Promise<void>;
}

export interface RuntimeSessionFactory {
	spawn(options: SpawnPiSessionOptions): Promise<RuntimeSession>;
	resume(options: ResumePiSessionOptions): Promise<RuntimeSession>;
}

interface ManagedSession {
	session: RuntimeSession;
	connection: RuntimeResponseSink;
}

export class RuntimeDispatcher {
	private readonly factory: RuntimeSessionFactory;
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly pendingSessionIds = new Set<string>();
	private readonly pendingHostTools = new Map<string, PendingHostTool>();
	private nextHostToolRequestId = 0;

	constructor(factory: RuntimeSessionFactory = new PiSdkSessionFactory()) {
		this.factory = factory;
	}

	async handleEnvelope(connection: RuntimeResponseSink, envelope: Envelope): Promise<void> {
		if (envelope.payload.case === "hostToolResult") {
			this.handleHostToolResult(envelope.payload.value);
			return;
		}
		if (envelope.payload.case !== "request") {
			this.sendError(connection, "", "", "unexpected_envelope", "expected a runtime request");
			return;
		}
		await this.handleRequest(connection, envelope.payload.value);
	}

	async close(): Promise<void> {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		for (const pending of this.pendingHostTools.values()) {
			pending.reject(new Error("runtime dispatcher closed before host tool completed"));
			pending.cleanup();
		}
		this.pendingHostTools.clear();
		await Promise.allSettled(sessions.map(({ session }) => session.close()));
	}

	private async handleRequest(connection: RuntimeResponseSink, request: RuntimeRequest): Promise<void> {
		if (!request.requestId) {
			this.sendError(connection, "", request.sessionId, "invalid_request", "request_id is required");
			return;
		}
		if (!request.sessionId) {
			this.sendError(connection, request.requestId, "", "invalid_request", "session_id is required");
			return;
		}

		try {
			switch (request.command.case) {
				case "spawn":
					await this.spawn(connection, request, request.command.value);
					break;
				case "resume":
					await this.resume(connection, request, request.command.value);
					break;
				case "prompt": {
					const session = this.requireSession(request.sessionId);
					const completion = session.prompt(request.command.value.text);
					this.sendAck(connection, request);
					void completion.catch((error: unknown) =>
						session.reportError("prompt_failed", errorMessage(error), false),
					);
					break;
				}
				case "steer":
					await this.requireSession(request.sessionId).steer(request.command.value.text);
					this.sendAck(connection, request);
					break;
				case "followUp":
					await this.requireSession(request.sessionId).followUp(request.command.value.text);
					this.sendAck(connection, request);
					break;
				case "interrupt":
					await this.requireSession(request.sessionId).interrupt();
					this.sendAck(connection, request);
					break;
				case "close":
					await this.closeSession(request.sessionId);
					this.sendAck(connection, request);
					break;
				case "status":
					this.sendStatus(connection, request, this.requireSession(request.sessionId).status());
					break;
				case undefined:
					this.sendError(
						connection,
						request.requestId,
						request.sessionId,
						"invalid_request",
						"runtime command is required",
					);
					break;
			}
		} catch (error) {
			const code = error instanceof SessionNotFoundError ? "session_not_found" : "request_failed";
			this.sendError(connection, request.requestId, request.sessionId, code, errorMessage(error));
		}
	}

	private async spawn(
		connection: RuntimeResponseSink,
		request: RuntimeRequest,
		command: NonNullable<Extract<RuntimeRequest["command"], { case: "spawn" }>["value"]>,
	): Promise<void> {
		this.reserveSessionId(request.sessionId);
		try {
			const session = await this.factory.spawn({
				sessionId: request.sessionId,
				cwd: command.cwd,
				agentDir: command.agentDir || undefined,
				sessionDir: command.sessionDir || undefined,
				provider: command.provider || undefined,
				model: command.model || undefined,
				thinkingLevel: command.thinkingLevel || undefined,
				hostTools: command.hostTools,
				onHostToolCall: (toolCallId, toolName, argumentsValue, signal) =>
					this.requestHostTool(connection, request.sessionId, toolCallId, toolName, argumentsValue, signal),
				onEvent: (event) => this.sendEvent(request.sessionId, event),
			});
			this.sessions.set(request.sessionId, { session, connection });
			this.sendSpawned(connection, request, session);
		} finally {
			this.pendingSessionIds.delete(request.sessionId);
		}
	}

	private async resume(
		connection: RuntimeResponseSink,
		request: RuntimeRequest,
		command: NonNullable<Extract<RuntimeRequest["command"], { case: "resume" }>["value"]>,
	): Promise<void> {
		this.reserveSessionId(request.sessionId);
		try {
			const session = await this.factory.resume({
				sessionId: request.sessionId,
				sessionLocator: command.sessionLocator,
				cwdOverride: command.cwdOverride || undefined,
				hostTools: command.hostTools,
				onHostToolCall: (toolCallId, toolName, argumentsValue, signal) =>
					this.requestHostTool(connection, request.sessionId, toolCallId, toolName, argumentsValue, signal),
				onEvent: (event) => this.sendEvent(request.sessionId, event),
			});
			this.sessions.set(request.sessionId, { session, connection });
			this.sendSpawned(connection, request, session);
		} finally {
			this.pendingSessionIds.delete(request.sessionId);
		}
	}

	private reserveSessionId(sessionId: string): void {
		if (this.sessions.has(sessionId) || this.pendingSessionIds.has(sessionId)) {
			throw new Error(`session already exists: ${sessionId}`);
		}
		this.pendingSessionIds.add(sessionId);
	}

	private requireSession(sessionId: string): RuntimeSession {
		const managed = this.sessions.get(sessionId);
		if (!managed) {
			throw new SessionNotFoundError(sessionId);
		}
		return managed.session;
	}

	private async closeSession(sessionId: string): Promise<void> {
		const session = this.requireSession(sessionId);
		this.sessions.delete(sessionId);
		await session.close();
	}

	private requestHostTool(
		connection: RuntimeResponseSink,
		sessionId: string,
		toolCallId: string,
		toolName: string,
		argumentsValue: unknown,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		const requestId = `host-tool-${this.nextHostToolRequestId++}`;
		return new Promise((resolve, reject) => {
			const abort = () => {
				const pending = this.pendingHostTools.get(requestId);
				if (!pending) return;
				this.pendingHostTools.delete(requestId);
				pending.cleanup();
				reject(new Error(`host tool ${toolName} was aborted`));
			};
			const cleanup = () => signal?.removeEventListener("abort", abort);
			if (signal?.aborted) {
				reject(new Error(`host tool ${toolName} was aborted`));
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			this.pendingHostTools.set(requestId, { sessionId, toolCallId, resolve, reject, cleanup });
			try {
				connection.send(
					create(EnvelopeSchema, {
						protocolVersion: PI_CODEX_PROTOCOL_VERSION,
						payload: {
							case: "hostToolRequest",
							value: create(HostToolRequestSchema, {
								requestId,
								sessionId,
								toolCallId,
								toolName,
								argumentsJson: encodeJson(argumentsValue),
							}),
						},
					}),
				);
			} catch (error) {
				this.pendingHostTools.delete(requestId);
				cleanup();
				reject(error);
			}
		});
	}

	private handleHostToolResult(result: HostToolResult): void {
		const pending = this.pendingHostTools.get(result.requestId);
		if (!pending) {
			return;
		}
		this.pendingHostTools.delete(result.requestId);
		pending.cleanup();
		if (pending.sessionId !== result.sessionId || pending.toolCallId !== result.toolCallId) {
			pending.reject(new Error("host tool result correlation mismatch"));
			return;
		}
		if (result.error) {
			pending.reject(new Error(result.error.message || result.error.code || "host tool failed"));
			return;
		}
		try {
			pending.resolve(decodeJson(result.resultJson));
		} catch (error) {
			pending.reject(error);
		}
	}

	private sendEvent(sessionId: string, event: SessionEvent): void {
		const managed = this.sessions.get(sessionId);
		if (!managed) {
			return;
		}
		trySend(
			managed.connection,
			create(EnvelopeSchema, {
				protocolVersion: PI_CODEX_PROTOCOL_VERSION,
				payload: { case: "event", value: event },
			}),
		);
	}

	private sendAck(connection: RuntimeResponseSink, request: RuntimeRequest): void {
		this.sendResponse(connection, request.requestId, request.sessionId, {
			case: "ack",
			value: create(AckSchema),
		});
	}

	private sendSpawned(connection: RuntimeResponseSink, request: RuntimeRequest, session: RuntimeSession): void {
		this.sendResponse(connection, request.requestId, request.sessionId, {
			case: "spawned",
			value: create(SpawnedSessionSchema, {
				sessionLocator: session.sessionLocator,
				provider: session.provider,
				model: session.model,
				thinkingLevel: session.thinkingLevel,
			}),
		});
	}

	private sendStatus(connection: RuntimeResponseSink, request: RuntimeRequest, status: SessionStatus): void {
		this.sendResponse(connection, request.requestId, request.sessionId, { case: "status", value: status });
	}

	private sendError(
		connection: RuntimeResponseSink,
		requestId: string,
		sessionId: string,
		code: string,
		message: string,
	): void {
		this.sendResponse(connection, requestId, sessionId, {
			case: "error",
			value: create(RuntimeErrorSchema, { code, message }),
		});
	}

	private sendResponse(
		connection: RuntimeResponseSink,
		requestId: string,
		sessionId: string,
		result: RuntimeResponseResult,
	): void {
		trySend(
			connection,
			create(EnvelopeSchema, {
				protocolVersion: PI_CODEX_PROTOCOL_VERSION,
				payload: {
					case: "response",
					value: create(RuntimeResponseSchema, { requestId, sessionId, result }),
				},
			}),
		);
	}
}

type RuntimeResponseResult = Exclude<RuntimeResponse["result"], { case: undefined }>;

interface PendingHostTool {
	sessionId: string;
	toolCallId: string;
	resolve(value: unknown): void;
	reject(error: unknown): void;
	cleanup(): void;
}

class SessionNotFoundError extends Error {
	constructor(sessionId: string) {
		super(`session not found: ${sessionId}`);
	}
}

function trySend(connection: RuntimeResponseSink, envelope: Envelope): void {
	try {
		connection.send(envelope);
	} catch {
		// A disconnected Rust provider can no longer receive this response.
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function encodeJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function decodeJson(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder().decode(bytes));
}
