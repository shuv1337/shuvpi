import { streamSimple, type ToolResultMessage, type Usage } from "@shuv1337/shuvpi-ai/compat";
import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ModelSelector } from "../dialogs/ModelSelector.ts";
import type { MessageEditor } from "./MessageEditor.ts";
import "./MessageEditor.ts";
import "./MessageList.ts";
import "./Messages.ts"; // Import for side effects to register the custom elements
import { getAppStorage } from "../storage/app-storage.ts";
import "./StreamingMessageContainer.ts";
import type { Agent, AgentEvent } from "@shuv1337/shuvpi-agent-core";
import { type AgentSession, AgentSessionConnectionGuard, selectAgentSession } from "../agent-session.ts";
import type { Attachment } from "../utils/attachment-utils.ts";
import { formatUsage } from "../utils/format.ts";
import { i18n } from "../utils/i18n.ts";
import { createStreamFn } from "../utils/proxy-utils.ts";
import type { UserMessageWithAttachments } from "./Messages.ts";
import type { StreamingMessageContainer } from "./StreamingMessageContainer.ts";

@customElement("agent-interface")
export class AgentInterface extends LitElement {
	// Optional external session: when provided, this component becomes a view over the session
	@property({ attribute: false }) session?: Agent;
	// Explicit remote ownership path; takes precedence and skips local runtime configuration.
	@property({ attribute: false }) remoteSession?: AgentSession;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	// Optional custom API key prompt handler - if not provided, uses default dialog
	@property({ attribute: false }) onApiKeyRequired?: (provider: string) => Promise<boolean>;
	// Optional callback called before sending a message
	@property({ attribute: false }) onBeforeSend?: () => void | Promise<void>;
	// Optional callback called before executing a tool call - return false to prevent execution
	@property({ attribute: false }) onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
	// Optional callback called when cost display is clicked
	@property({ attribute: false }) onCostClick?: () => void;
	// Optional callback to override model selector behavior
	@property({ attribute: false }) onModelSelect?: () => void;

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _autoScroll = true;
	private _lastScrollTop = 0;
	private _lastClientHeight = 0;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _unsubscribeSession?: () => void;
	private readonly _connectionGuard = new AgentSessionConnectionGuard();

	private get activeSession(): AgentSession | undefined {
		return selectAgentSession(this.session, this.remoteSession)?.session;
	}

	public setInput(text: string, attachments?: Attachment[]) {
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = attachments || [];
			}
		};
		update();
	}

	public setAutoScroll(enabled: boolean) {
		this._autoScroll = enabled;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);

		// Re-subscribe when session property changes
		if (this.isConnected && (changedProperties.has("session") || changedProperties.has("remoteSession"))) {
			this.setupSessionSubscription();
		}
	}

	override async connectedCallback() {
		super.connectedCallback();
		const connectionGeneration = this._connectionGuard.begin();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		if (!this._connectionGuard.isCurrent(connectionGeneration, this.isConnected)) return;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			// Set up ResizeObserver to detect content changes
			this._resizeObserver = new ResizeObserver(() => {
				if (this._autoScroll && this._scrollContainer) {
					this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
				}
			});

			// Observe the content container inside the scroll container
			const contentContainer = this._scrollContainer.querySelector(".max-w-3xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Set up scroll listener with better detection
			this._scrollContainer.addEventListener("scroll", this._handleScroll);
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._connectionGuard.disconnect();

		// Clean up observers and listeners
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
		}

		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
	}

	private setupSessionSubscription() {
		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
		const selection = selectAgentSession(this.session, this.remoteSession);
		if (!selection) return;
		const { session } = selection;

		if (selection.ownership === "local") {
			const localAgent = selection.session;
			// Set default streamFn with proxy support if not already set
			if (localAgent.streamFunction === streamSimple) {
				localAgent.streamFunction = createStreamFn(async () => {
					const enabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
					return enabled ? (await getAppStorage().settings.get<string>("proxy.url")) || undefined : undefined;
				});
			}

			// Set default getApiKey if not already set
			if (!localAgent.getApiKey) {
				localAgent.getApiKey = async (provider: string) => {
					const key = await getAppStorage().providerKeys.get(provider);
					return key ?? undefined;
				};
			}
		}

		this._unsubscribeSession = session.subscribe(async (ev: AgentEvent) => {
			if (this.activeSession !== session) return;
			switch (ev.type) {
				case "message_start":
				case "turn_start":
				case "turn_end":
				case "agent_start":
					this.requestUpdate();
					break;
				case "message_end":
					// Clear streaming container when a message completes
					// to prevent duplicate rendering (stable list now has this message)
					if (this._streamingContainer) {
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = session.state.isStreaming;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					this.requestUpdate();
					break;
			}
		});
	}

	private _handleScroll = (_ev: any) => {
		if (!this._scrollContainer) return;

		const currentScrollTop = this._scrollContainer.scrollTop;
		const scrollHeight = this._scrollContainer.scrollHeight;
		const clientHeight = this._scrollContainer.clientHeight;
		const distanceFromBottom = scrollHeight - currentScrollTop - clientHeight;

		// Ignore relayout due to message editor getting pushed up by stats
		if (clientHeight < this._lastClientHeight) {
			this._lastClientHeight = clientHeight;
			return;
		}

		// Only disable auto-scroll if user scrolled UP or is far from bottom
		if (currentScrollTop !== 0 && currentScrollTop < this._lastScrollTop && distanceFromBottom > 50) {
			this._autoScroll = false;
		} else if (distanceFromBottom < 10) {
			// Re-enable if very close to bottom
			this._autoScroll = true;
		}

		this._lastScrollTop = currentScrollTop;
		this._lastClientHeight = clientHeight;
	};

	public async sendMessage(input: string, attachments?: Attachment[]) {
		const session = this.activeSession;
		if ((!input.trim() && attachments?.length === 0) || session?.state.isStreaming) return;
		if (!session) throw new Error("No session set on AgentInterface");
		if (!session.state.model) throw new Error("No model set on AgentInterface");

		// Ask the host app whether credentials are configured for the selected provider.
		// Custom providers can source credentials outside providerKeys, so AgentInterface
		// must not assume providerKeys is the only source of truth.
		const provider = session.state.model.provider;
		if (this.onApiKeyRequired) {
			const success = await this.onApiKeyRequired(provider);
			if (!success) {
				return;
			}
		} else if (!this.remoteSession) {
			const apiKey = await getAppStorage().providerKeys.get(provider);
			if (!apiKey) {
				console.error("No API key configured and no onApiKeyRequired handler set");
				return;
			}
		}

		// Call onBeforeSend hook before sending
		if (this.onBeforeSend) {
			await this.onBeforeSend();
		}

		// Only clear editor after we know we can send
		this._messageEditor.value = "";
		this._messageEditor.attachments = [];
		this._autoScroll = true; // Enable auto-scroll when sending a message

		// Compose message with attachments if any
		if (attachments && attachments.length > 0) {
			const message: UserMessageWithAttachments = {
				role: "user-with-attachments",
				content: input,
				attachments,
				timestamp: Date.now(),
			};
			await session.prompt(message);
		} else {
			await session.prompt(input);
		}
	}

	private renderMessages() {
		const session = this.activeSession;
		if (!session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session available")}</div>`;
		const state = session.state;
		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = new Map<string, ToolResultMessage<any>>();
		for (const message of state.messages) {
			if (message.role === "toolResult") {
				toolResultsById.set(message.toolCallId, message);
			}
		}
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${state.messages}
					.tools=${state.tools}
					.pendingToolCalls=${state.pendingToolCalls}
					.isStreaming=${state.isStreaming}
					.onCostClick=${this.onCostClick}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					class="${state.isStreaming ? "" : "hidden"}"
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.onCostClick=${this.onCostClick}
				></streaming-message-container>
			</div>
		`;
	}

	private renderStats() {
		const session = this.activeSession;
		if (!session) return html`<div class="text-xs h-5"></div>`;

		const state = session.state;
		const totals = state.messages
			.filter((m) => m.role === "assistant")
			.reduce(
				(acc, msg: any) => {
					const usage = msg.usage;
					if (usage) {
						acc.input += usage.input;
						acc.output += usage.output;
						acc.cacheRead += usage.cacheRead;
						acc.cacheWrite += usage.cacheWrite;
						acc.cost.total += usage.cost.total;
					}
					return acc;
				},
				{
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} satisfies Usage,
			);

		const hasTotals = totals.input || totals.output || totals.cacheRead || totals.cacheWrite;
		const totalsText = hasTotals ? formatUsage(totals) : "";

		return html`
			<div class="text-xs text-muted-foreground flex justify-between items-center h-5">
				<div class="flex items-center gap-1">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
				</div>
				<div class="flex ml-auto items-center gap-3">
					${
						totalsText
							? this.onCostClick
								? html`<span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${totalsText}</span>`
								: html`<span>${totalsText}</span>`
							: ""
					}
				</div>
			</div>
		`;
	}

	override render() {
		const session = this.activeSession;
		if (!session) return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session set")}</div>`;

		const state = session.state;
		return html`
			<div class="flex flex-col h-full bg-background text-foreground">
				<!-- Messages Area -->
				<div class="flex-1 overflow-y-auto">
					<div class="max-w-3xl mx-auto p-4 pb-0">${this.renderMessages()}</div>
				</div>

				<!-- Input Area -->
				<div class="shrink-0">
					<div class="max-w-3xl mx-auto px-2">
						<message-editor
							.isStreaming=${state.isStreaming}
							.currentModel=${state.model}
							.thinkingLevel=${state.thinkingLevel}
							.showAttachmentButton=${this.enableAttachments}
							.showModelSelector=${this.enableModelSelector}
							.showThinkingSelector=${this.enableThinkingSelector}
							.onSend=${(input: string, attachments: Attachment[]) => {
								this.sendMessage(input, attachments);
							}}
							.onAbort=${() => session.abort()}
							.onModelSelect=${() => {
								if (this.onModelSelect) {
									this.onModelSelect();
								} else {
									ModelSelector.open(state.model, (model) => {
										session.state.model = model;
									});
								}
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: "off" | "minimal" | "low" | "medium" | "high") => {
											session.state.thinkingLevel = level;
										}
									: undefined
							}
						></message-editor>
						${this.renderStats()}
					</div>
				</div>
			</div>
		`;
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
