import { create } from "@bufbuild/protobuf";
import {
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type AgentToolResult,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	type ToolDefinition,
} from "@shuv1337/shuvpi-coding-agent";
import {
	AgentEndSchema,
	AgentStartSchema,
	CompactionEventSchema,
	ErrorEventSchema,
	type HostToolDefinition,
	MessageDeltaSchema,
	MessageEndSchema,
	MessageStartSchema,
	QueueUpdateSchema,
	RetryEventSchema,
	type SessionEvent,
	SessionEventSchema,
	type SessionStatus,
	SessionStatusSchema,
	TokenUsageSchema,
	ToolExecutionEndSchema,
	ToolExecutionStartSchema,
	ToolExecutionUpdateSchema,
	TurnEndSchema,
	TurnStartSchema,
} from "../gen/pi_codex_runtime_pb.ts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type SessionEventPayload = Exclude<SessionEvent["event"], { case: undefined }>;

export interface PiSdkSessionFactoryOptions {
	modelRuntime?: ModelRuntime;
}

export interface SpawnPiSessionOptions {
	sessionId: string;
	cwd: string;
	agentDir?: string;
	sessionDir?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	hostTools?: HostToolDefinition[];
	onHostToolCall?: HostToolCallHandler;
	onEvent: (event: SessionEvent) => void;
}

export interface ResumePiSessionOptions {
	sessionId: string;
	sessionLocator: string;
	cwdOverride?: string;
	agentDir?: string;
	hostTools?: HostToolDefinition[];
	onHostToolCall?: HostToolCallHandler;
	onEvent: (event: SessionEvent) => void;
}

export type HostToolCallHandler = (
	toolCallId: string,
	toolName: string,
	argumentsValue: unknown,
	signal: AbortSignal | undefined,
) => Promise<unknown>;

export class PiSdkSessionFactory {
	private readonly options: PiSdkSessionFactoryOptions;

	constructor(options: PiSdkSessionFactoryOptions = {}) {
		this.options = options;
	}

	async spawn(options: SpawnPiSessionOptions): Promise<PiSdkSession> {
		const sessionManager = SessionManager.create(options.cwd, options.sessionDir || undefined);
		return this.createSession({
			sessionId: options.sessionId,
			cwd: options.cwd,
			agentDir: options.agentDir,
			sessionManager,
			provider: options.provider,
			model: options.model,
			thinkingLevel: parseThinkingLevel(options.thinkingLevel),
			hostTools: options.hostTools,
			onHostToolCall: options.onHostToolCall,
			onEvent: options.onEvent,
		});
	}

	async resume(options: ResumePiSessionOptions): Promise<PiSdkSession> {
		const sessionManager = SessionManager.open(options.sessionLocator, undefined, options.cwdOverride || undefined);
		return this.createSession({
			sessionId: options.sessionId,
			cwd: sessionManager.getCwd(),
			agentDir: options.agentDir,
			sessionManager,
			hostTools: options.hostTools,
			onHostToolCall: options.onHostToolCall,
			onEvent: options.onEvent,
		});
	}

	private async createSession(options: {
		sessionId: string;
		cwd: string;
		agentDir?: string;
		sessionManager: SessionManager;
		provider?: string;
		model?: string;
		thinkingLevel?: ThinkingLevel;
		hostTools?: HostToolDefinition[];
		onHostToolCall?: HostToolCallHandler;
		onEvent: (event: SessionEvent) => void;
	}): Promise<PiSdkSession> {
		const agentDir = options.agentDir || getAgentDir();
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime: this.options.modelRuntime,
			});
			const savedModel = sessionManager.buildSessionContext().model;
			const migrateLegacyXaiModel =
				options.provider === undefined &&
				options.model === undefined &&
				savedModel?.provider === "xai-oauth" &&
				savedModel.modelId === "grok-4.5";
			const requestedProvider = migrateLegacyXaiModel ? "xai" : options.provider;
			const requestedModelId = migrateLegacyXaiModel ? "grok-4.5" : options.model;
			const requestedModel = resolveRequestedModel(services.modelRuntime, requestedProvider, requestedModelId);
			if (migrateLegacyXaiModel && !services.modelRuntime.hasConfiguredAuth("xai")) {
				throw new Error("Pi legacy session model migration requires configured auth: xai/grok-4.5");
			}
			const customTools = createHostToolDefinitions(options.hostTools ?? [], options.onHostToolCall);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: requestedModel,
				thinkingLevel: options.thinkingLevel,
				noTools: "all",
				customTools,
				tools: customTools.map((tool) => tool.name),
			});
			if (migrateLegacyXaiModel) {
				sessionManager.appendModelChange("xai", "grok-4.5");
			}
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: options.cwd,
			agentDir,
			sessionManager: options.sessionManager,
		});
		await runtime.session.bindExtensions({});
		if (process.env.SHUVPI_CODEX_RUNTIME_DEBUG_HOST_TOOLS === "1") {
			console.error(
				JSON.stringify({
					event: "pi-codex-runtime.host-tools",
					sessionId: options.sessionId,
					requested: (options.hostTools ?? []).map((tool) => tool.name),
					active: runtime.session.getActiveToolNames(),
				}),
			);
		}
		return new PiSdkSession(options.sessionId, runtime, options.onEvent);
	}
}

function createHostToolDefinitions(
	definitions: HostToolDefinition[],
	handler: HostToolCallHandler | undefined,
): ToolDefinition[] {
	if (definitions.length > 0 && !handler) {
		throw new Error("host tools require an onHostToolCall handler");
	}
	return definitions.map((definition) => {
		const parameters = decodeJson(definition.inputSchemaJson, `schema for host tool ${definition.name}`);
		if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
			throw new Error(`schema for host tool ${definition.name} must be a JSON object`);
		}
		return {
			name: definition.name,
			label: definition.name,
			description: definition.description,
			parameters: parameters as ToolDefinition["parameters"],
			execute: async (toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
				if (process.env.SHUVPI_CODEX_RUNTIME_DEBUG_HOST_TOOLS === "1") {
					console.error(
						JSON.stringify({
							event: "pi-codex-runtime.host-tool-call",
							toolCallId,
							name: definition.name,
						}),
					);
				}
				return normalizeHostToolResult(await handler?.(toolCallId, definition.name, args, signal));
			},
		};
	});
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function normalizeHostToolResult(value: unknown): AgentToolResult<unknown> {
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		return {
			content: value.content as AgentToolResult<unknown>["content"],
			details: "details" in value ? value.details : {},
			...("terminate" in value && typeof value.terminate === "boolean" ? { terminate: value.terminate } : {}),
		};
	}
	return {
		content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
		details: value,
	};
}

export class PiSdkSession {
	private readonly sessionId: string;
	private readonly runtime: AgentSessionRuntime;
	private readonly eventMapper: PiSessionEventMapper;
	private readonly unsubscribe: () => void;
	private closed = false;

	constructor(sessionId: string, runtime: AgentSessionRuntime, onEvent: (event: SessionEvent) => void) {
		this.sessionId = sessionId;
		this.runtime = runtime;
		this.eventMapper = new PiSessionEventMapper(sessionId, runtime, onEvent);
		this.unsubscribe = runtime.session.subscribe((event) => this.eventMapper.receive(event));
	}

	get sessionLocator(): string {
		const locator = this.runtime.session.sessionFile;
		if (!locator) {
			throw new Error("Pi SDK created a non-persistent session");
		}
		return locator;
	}

	get provider(): string {
		return this.runtime.session.model?.provider ?? "";
	}

	get model(): string {
		return this.runtime.session.model?.id ?? "";
	}

	get thinkingLevel(): string {
		return this.runtime.session.thinkingLevel;
	}

	get activeToolNames(): string[] {
		return this.runtime.session.getActiveToolNames();
	}

	async prompt(text: string): Promise<void> {
		this.assertOpen();
		await this.runtime.session.prompt(text);
	}

	async steer(text: string): Promise<void> {
		this.assertOpen();
		await this.runtime.session.steer(text);
	}

	async followUp(text: string): Promise<void> {
		this.assertOpen();
		await this.runtime.session.followUp(text);
	}

	async interrupt(): Promise<void> {
		this.assertOpen();
		await this.runtime.session.abort();
	}

	status(): SessionStatus {
		const stats = this.runtime.session.getSessionStats();
		return create(SessionStatusSchema, {
			state: this.closed ? "closed" : this.runtime.session.isStreaming ? "running" : "idle",
			tokenUsage: create(TokenUsageSchema, {
				inputTokens: toUnsignedBigInt(stats.tokens.input),
				outputTokens: toUnsignedBigInt(stats.tokens.output),
				cacheReadTokens: toUnsignedBigInt(stats.tokens.cacheRead),
				cacheWriteTokens: toUnsignedBigInt(stats.tokens.cacheWrite),
				totalTokens: toUnsignedBigInt(stats.tokens.total),
			}),
		});
	}

	reportError(code: string, message: string, retryable = false): void {
		this.eventMapper.reportError(code, message, retryable);
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.unsubscribe();
		await this.runtime.dispose();
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error(`Pi session ${this.sessionId} is closed`);
		}
	}
}

class PiSessionEventMapper {
	private readonly sessionId: string;
	private readonly runtime: AgentSessionRuntime;
	private readonly onEvent: (event: SessionEvent) => void;
	private readonly messageIds = new WeakMap<object, string>();
	private sequence = 0n;
	private nextMessageId = 0;
	private turnIndex = 0;
	private activeAssistantMessageId: string | undefined;

	constructor(sessionId: string, runtime: AgentSessionRuntime, onEvent: (event: SessionEvent) => void) {
		this.sessionId = sessionId;
		this.runtime = runtime;
		this.onEvent = onEvent;
	}

	receive(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.emit("agentStart", create(AgentStartSchema));
				break;
			case "turn_start":
				this.emit("turnStart", create(TurnStartSchema, { turnIndex: this.turnIndex }));
				break;
			case "message_start": {
				const messageId = this.messageId(event.message);
				if (event.message.role === "assistant") {
					this.activeAssistantMessageId = messageId;
				}
				this.emit("messageStart", create(MessageStartSchema, { messageId, role: event.message.role }));
				break;
			}
			case "message_update": {
				const update = event.assistantMessageEvent;
				const messageId = this.activeAssistantMessageId ?? this.messageId(event.message);
				if (update.type === "text_delta") {
					this.emit(
						"textDelta",
						create(MessageDeltaSchema, { messageId, contentIndex: update.contentIndex, delta: update.delta }),
					);
				} else if (update.type === "thinking_delta") {
					this.emit(
						"thinkingDelta",
						create(MessageDeltaSchema, { messageId, contentIndex: update.contentIndex, delta: update.delta }),
					);
				}
				break;
			}
			case "message_end": {
				const messageId =
					event.message.role === "assistant"
						? (this.activeAssistantMessageId ?? this.messageId(event.message))
						: this.messageId(event.message);
				this.emit(
					"messageEnd",
					create(MessageEndSchema, {
						messageId,
						role: event.message.role,
						messageJson: encodeJson(event.message),
					}),
				);
				if (event.message.role === "assistant") {
					this.activeAssistantMessageId = undefined;
				}
				break;
			}
			case "tool_execution_start":
				this.emit(
					"toolExecutionStart",
					create(ToolExecutionStartSchema, {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						argumentsJson: encodeJson(event.args),
					}),
				);
				break;
			case "tool_execution_update":
				this.emit(
					"toolExecutionUpdate",
					create(ToolExecutionUpdateSchema, {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						partialResultJson: encodeJson(event.partialResult),
					}),
				);
				break;
			case "tool_execution_end":
				this.emit(
					"toolExecutionEnd",
					create(ToolExecutionEndSchema, {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						resultJson: encodeJson(event.result),
						isError: event.isError,
					}),
				);
				break;
			case "turn_end":
				this.emit(
					"turnEnd",
					create(TurnEndSchema, {
						turnIndex: this.turnIndex,
						assistantMessageJson: encodeJson(event.message),
					}),
				);
				this.turnIndex++;
				break;
			case "agent_end":
				this.emit(
					"agentEnd",
					create(AgentEndSchema, {
						lastAssistantText: this.runtime.session.getLastAssistantText() ?? "",
						willRetry: event.willRetry,
					}),
				);
				this.emitTokenUsage();
				break;
			case "queue_update":
				this.emit(
					"queueUpdate",
					create(QueueUpdateSchema, {
						steeringCount: event.steering.length,
						followUpCount: event.followUp.length,
					}),
				);
				break;
			case "compaction_start":
				this.emit("compaction", create(CompactionEventSchema, { phase: "start", reason: event.reason }));
				break;
			case "compaction_end":
				this.emit(
					"compaction",
					create(CompactionEventSchema, {
						phase: "end",
						reason: event.reason,
						aborted: event.aborted,
						errorMessage: event.errorMessage,
					}),
				);
				break;
			case "auto_retry_start":
				this.emit(
					"retry",
					create(RetryEventSchema, {
						phase: "start",
						attempt: event.attempt,
						maximumAttempts: event.maxAttempts,
						delayMs: BigInt(event.delayMs),
						errorMessage: event.errorMessage,
					}),
				);
				break;
			case "auto_retry_end":
				this.emit(
					"retry",
					create(RetryEventSchema, {
						phase: "end",
						attempt: event.attempt,
						success: event.success,
						errorMessage: event.finalError,
					}),
				);
				break;
			case "agent_settled":
			case "entry_appended":
			case "session_info_changed":
			case "thinking_level_changed":
				break;
			default:
				this.emit(
					"error",
					create(ErrorEventSchema, { code: "unmapped_event", message: "unmapped Pi session event" }),
				);
		}
	}

	reportError(code: string, message: string, retryable = false): void {
		this.emit("error", create(ErrorEventSchema, { code, message, retryable }));
	}

	private emitTokenUsage(): void {
		const tokens = this.runtime.session.getSessionStats().tokens;
		this.emit(
			"tokenUsage",
			create(TokenUsageSchema, {
				inputTokens: toUnsignedBigInt(tokens.input),
				outputTokens: toUnsignedBigInt(tokens.output),
				cacheReadTokens: toUnsignedBigInt(tokens.cacheRead),
				cacheWriteTokens: toUnsignedBigInt(tokens.cacheWrite),
				totalTokens: toUnsignedBigInt(tokens.total),
			}),
		);
	}

	private emit<Case extends SessionEventPayload["case"]>(
		caseName: Case,
		value: Extract<SessionEventPayload, { case: Case }>["value"],
	): void {
		this.onEvent(
			create(SessionEventSchema, {
				sessionId: this.sessionId,
				sequence: this.sequence++,
				event: { case: caseName, value } as SessionEventPayload,
			}),
		);
	}

	private messageId(message: object): string {
		let messageId = this.messageIds.get(message);
		if (!messageId) {
			messageId = `pi-message-${this.nextMessageId++}`;
			this.messageIds.set(message, messageId);
		}
		return messageId;
	}
}

function resolveRequestedModel(modelRuntime: ModelRuntime, provider?: string, modelId?: string) {
	if (!provider && !modelId) {
		return undefined;
	}
	if (!provider || !modelId) {
		throw new Error("Pi runtime model selection requires both provider and model");
	}
	const model = modelRuntime.getModel(provider, modelId);
	if (!model) {
		throw new Error(`Pi model not found: ${provider}/${modelId}`);
	}
	return model;
}

function parseThinkingLevel(value?: string): ThinkingLevel | undefined {
	if (!value) {
		return undefined;
	}
	if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
		return value as ThinkingLevel;
	}
	throw new Error(`unsupported Pi thinking level: ${value}`);
}

function encodeJson(value: unknown): Uint8Array {
	try {
		return new TextEncoder().encode(
			JSON.stringify(value, (_key, nested: unknown) => (typeof nested === "bigint" ? nested.toString() : nested)) ??
				"null",
		);
	} catch (error) {
		return new TextEncoder().encode(
			JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) }),
		);
	}
}

function toUnsignedBigInt(value: number): bigint {
	return BigInt(Math.max(0, Math.floor(value)));
}
