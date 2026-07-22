import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./components/AgentInterface.ts";
import type { Agent, AgentTool } from "@shuv1337/shuvpi-agent-core";
import type { AgentSession } from "./agent-session.ts";
import { installManagedTools, selectAgentSession } from "./agent-session.ts";
import { AgentTranscriptReconciler } from "./agent-transcript-reconciler.ts";
import type { AgentInterface } from "./components/AgentInterface.ts";
import { ArtifactsRuntimeProvider } from "./components/sandbox/ArtifactsRuntimeProvider.ts";
import { AttachmentsRuntimeProvider } from "./components/sandbox/AttachmentsRuntimeProvider.ts";
import type { SandboxRuntimeProvider } from "./components/sandbox/SandboxRuntimeProvider.ts";
import { ArtifactsPanel, ArtifactsToolRenderer } from "./tools/artifacts/index.ts";
import { registerToolRenderer } from "./tools/renderer-registry.ts";
import type { Attachment } from "./utils/attachment-utils.ts";
import { i18n } from "./utils/i18n.ts";

const BREAKPOINT = 800; // px - switch between overlay and side-by-side

export interface ChatPanelSessionConfig {
	onApiKeyRequired?: (provider: string) => Promise<boolean>;
	onBeforeSend?: () => void | Promise<void>;
	onCostClick?: () => void;
	onModelSelect?: () => void;
	sandboxUrlProvider?: () => string;
}

export interface ChatPanelAgentConfig extends ChatPanelSessionConfig {
	manageTools?: boolean;
	toolsFactory?: (
		agent: Agent,
		agentInterface: AgentInterface,
		artifactsPanel: ArtifactsPanel,
		runtimeProvidersFactory: () => SandboxRuntimeProvider[],
	) => AgentTool<any>[];
}

interface ManagedToolsSetup {
	enabled: boolean;
	create: (
		agentInterface: AgentInterface,
		artifactsPanel: ArtifactsPanel,
		runtimeProvidersFactory: () => SandboxRuntimeProvider[],
	) => AgentTool[];
}

@customElement("shuvpi-chat-panel")
export class ChatPanel extends LitElement {
	@state() public agent?: Agent;
	@state() public remoteSession?: AgentSession;
	@state() public agentInterface?: AgentInterface;
	@state() public artifactsPanel?: ArtifactsPanel;
	@state() private hasArtifacts = false;
	@state() private artifactCount = 0;
	@state() private showArtifactsPanel = false;
	@state() private windowWidth = 0;
	private artifactReconciler?: AgentTranscriptReconciler;
	private setAgentGeneration = 0;

	private get activeSession(): AgentSession | undefined {
		return selectAgentSession(this.agent, this.remoteSession)?.session;
	}

	private resizeHandler = () => {
		this.windowWidth = window.innerWidth;
		this.requestUpdate();
	};

	createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this.windowWidth = window.innerWidth; // Set initial width after connection
		window.addEventListener("resize", this.resizeHandler);
		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";
		// Update width after initial render
		requestAnimationFrame(() => {
			this.windowWidth = window.innerWidth;
			this.requestUpdate();
		});

		if (this.artifactReconciler) {
			void this.artifactReconciler.connect().catch((error: unknown) => {
				console.error("Failed to reconstruct artifacts from the agent transcript", error);
			});
		} else if (this.activeSession && this.artifactsPanel) {
			const reconciler = this.createArtifactReconciler(this.activeSession, this.artifactsPanel);
			void reconciler.connect().catch((error: unknown) => {
				console.error("Failed to reconstruct artifacts from the agent transcript", error);
			});
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener("resize", this.resizeHandler);
		this.artifactReconciler?.dispose();
		this.artifactReconciler = undefined;
	}

	private createArtifactReconciler(agent: AgentSession, artifactsPanel: ArtifactsPanel): AgentTranscriptReconciler {
		this.artifactReconciler?.dispose();
		const reconciler = new AgentTranscriptReconciler(
			agent,
			(messages) => artifactsPanel.reconstructFromMessages(messages),
			(error) => console.error("Failed to reconstruct artifacts from the agent transcript", error),
		);
		this.artifactReconciler = reconciler;
		return reconciler;
	}

	async setAgent(agent: Agent, config?: ChatPanelAgentConfig): Promise<void> {
		await this.setSession(
			agent,
			config,
			{
				enabled: config?.manageTools ?? true,
				create: (agentInterface, artifactsPanel, runtimeProvidersFactory) => {
					const additionalTools =
						config?.toolsFactory?.(agent, agentInterface, artifactsPanel, runtimeProvidersFactory) ?? [];
					return [artifactsPanel.tool, ...additionalTools];
				},
			},
			agent,
		);
	}

	async setRemoteSession(session: AgentSession, config?: ChatPanelSessionConfig): Promise<void> {
		await this.setSession(session, config);
	}

	private async setSession(
		session: AgentSession,
		config?: ChatPanelSessionConfig,
		managedTools?: ManagedToolsSetup,
		localAgent?: Agent,
	): Promise<void> {
		const generation = ++this.setAgentGeneration;
		this.artifactReconciler?.dispose();
		this.artifactReconciler = undefined;
		this.agent = localAgent;
		this.remoteSession = localAgent ? undefined : session;

		// Create AgentInterface
		const agentInterface = document.createElement("agent-interface") as AgentInterface;
		this.agentInterface = agentInterface;
		if (localAgent) {
			agentInterface.session = localAgent;
		} else {
			agentInterface.remoteSession = session;
		}
		agentInterface.enableAttachments = true;
		agentInterface.enableModelSelector = true;
		agentInterface.enableThinkingSelector = true;
		agentInterface.showThemeToggle = false;
		agentInterface.onApiKeyRequired = config?.onApiKeyRequired;
		agentInterface.onModelSelect = config?.onModelSelect;
		agentInterface.onBeforeSend = config?.onBeforeSend;
		agentInterface.onCostClick = config?.onCostClick;

		// Set up artifacts panel
		const artifactsPanel = new ArtifactsPanel();
		this.artifactsPanel = artifactsPanel;
		if (localAgent) {
			artifactsPanel.agent = localAgent;
		} else {
			artifactsPanel.remoteSession = session;
		}
		if (config?.sandboxUrlProvider) {
			artifactsPanel.sandboxUrlProvider = config.sandboxUrlProvider;
		}
		// Register the standalone tool renderer (not the panel itself)
		registerToolRenderer("artifacts", new ArtifactsToolRenderer(artifactsPanel));

		// Runtime providers factory for REPL tools (read-write access)
		const runtimeProvidersFactory = () => {
			const attachments: Attachment[] = [];
			for (const message of session.state.messages) {
				if (message.role === "user-with-attachments") {
					message.attachments?.forEach((a) => {
						attachments.push(a);
					});
				}
			}
			const providers: SandboxRuntimeProvider[] = [];

			// Add attachments provider if there are attachments
			if (attachments.length > 0) {
				providers.push(new AttachmentsRuntimeProvider(attachments));
			}

			// Add artifacts provider with read-write access (for REPL)
			providers.push(new ArtifactsRuntimeProvider(artifactsPanel, session, true));

			return providers;
		};

		let initialReconstruction = true;
		artifactsPanel.onArtifactsChange = () => {
			if (this.artifactsPanel !== artifactsPanel) return;
			const count = artifactsPanel.artifacts.size;
			const created = count > this.artifactCount;
			this.hasArtifacts = count > 0;
			this.artifactCount = count;
			if (this.hasArtifacts && created && !initialReconstruction) {
				this.showArtifactsPanel = true;
			}
			this.requestUpdate();
		};

		artifactsPanel.onClose = () => {
			if (this.artifactsPanel !== artifactsPanel) return;
			this.showArtifactsPanel = false;
			this.requestUpdate();
		};

		artifactsPanel.onOpen = () => {
			if (this.artifactsPanel !== artifactsPanel) return;
			this.showArtifactsPanel = true;
			this.requestUpdate();
		};

		// Install executable tools only for hosts that own this session's tool runtime.
		// Pass runtimeProvidersFactory so local consumers can configure their own REPL tools.
		if (managedTools) {
			installManagedTools(session, managedTools.enabled, () =>
				managedTools.create(agentInterface, artifactsPanel, runtimeProvidersFactory),
			);
		}

		const reconciler = this.createArtifactReconciler(session, artifactsPanel);
		let reconciliationFailed = false;
		let reconciliationError: unknown;
		try {
			if (this.isConnected) {
				await reconciler.connect();
			} else {
				await reconciler.reconcile();
			}
		} catch (error: unknown) {
			reconciliationFailed = true;
			reconciliationError = error;
		}

		if (generation !== this.setAgentGeneration || this.artifactsPanel !== artifactsPanel) return;
		initialReconstruction = false;
		this.hasArtifacts = artifactsPanel.artifacts.size > 0;
		this.artifactCount = artifactsPanel.artifacts.size;

		this.requestUpdate();
		if (reconciliationFailed) throw reconciliationError;
	}

	render() {
		if (!this.activeSession || !this.agentInterface) {
			return html`<div class="flex items-center justify-center h-full">
				<div class="text-muted-foreground">No agent set</div>
			</div>`;
		}

		const isMobile = this.windowWidth < BREAKPOINT;

		// Set panel props
		if (this.artifactsPanel) {
			this.artifactsPanel.collapsed = !this.showArtifactsPanel;
			this.artifactsPanel.overlay = isMobile;
		}

		return html`
			<div class="relative w-full h-full overflow-hidden flex">
				<div class="h-full" style="${!isMobile && this.showArtifactsPanel && this.hasArtifacts ? "width: 50%;" : "width: 100%;"}">
						${this.agentInterface}
					</div>

					<!-- Floating pill when artifacts exist and panel is collapsed -->
					${
						this.hasArtifacts && !this.showArtifactsPanel
							? html`
								<button
									class="absolute z-30 top-4 left-1/2 -translate-x-1/2 pointer-events-auto"
									@click=${() => {
										this.showArtifactsPanel = true;
										this.requestUpdate();
									}}
									title=${i18n("Show artifacts")}
								>
									${Badge(html`
										<span class="inline-flex items-center gap-1">
											<span>${i18n("Artifacts")}</span>
											<span class="text-[10px] leading-none bg-primary-foreground/20 text-primary-foreground rounded px-1 font-mono tabular-nums">${this.artifactCount}</span>
										</span>
									`)}
								</button>
							`
							: ""
					}

				<div class="h-full ${isMobile ? "absolute inset-0 pointer-events-none" : ""}" style="${!isMobile ? (!this.hasArtifacts || !this.showArtifactsPanel ? "display: none;" : "width: 50%;") : ""}">
					${this.artifactsPanel}
				</div>
			</div>
		`;
	}
}
