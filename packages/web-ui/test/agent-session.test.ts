import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, AgentEvent, AgentMessage, AgentState } from "@shuv1337/shuvpi-agent-core";
import { streamSimple } from "@shuv1337/shuvpi-ai/compat";
import {
	type AgentSession,
	AgentSessionConnectionGuard,
	type AgentSessionListener,
	installManagedTools,
	selectAgentSession,
} from "../src/agent-session.ts";
import { AgentTranscriptReconciler } from "../src/agent-transcript-reconciler.ts";
import type { ChatPanel } from "../src/ChatPanel.ts";
import type { AgentInterface } from "../src/components/AgentInterface.ts";
import { ArtifactsRuntimeProvider } from "../src/components/sandbox/ArtifactsRuntimeProvider.ts";
import type { ArtifactsPanel } from "../src/tools/artifacts/artifacts.ts";

class FakeAgentSession implements AgentSession {
	readonly state: AgentState;
	readonly prompts: Array<string | AgentMessage | AgentMessage[]> = [];
	abortCount = 0;
	private readonly listeners = new Set<AgentSessionListener>();

	constructor(state: AgentState) {
		this.state = state;
	}

	async prompt(input: string): Promise<void>;
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[]): Promise<void> {
		this.prompts.push(input);
	}

	subscribe(listener: AgentSessionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	abort(): void {
		this.abortCount++;
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	async emit(event: AgentEvent): Promise<void> {
		const signal = new AbortController().signal;
		await Promise.all(Array.from(this.listeners, (listener) => listener(event, signal)));
	}
}

function createFakeSession(): FakeAgentSession {
	return new FakeAgentSession({
		systemPrompt: "",
		model: {
			id: "test",
			name: "Test",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		},
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		pendingToolCalls: new Set<string>(),
	});
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

describe("AgentSession", () => {
	it("accepts both the existing Agent surface and an explicit structural remote session", async () => {
		const acceptsRealAgent = (agent: Agent): AgentSession => agent;
		const remote = createFakeSession();
		const remoteSession: AgentSession = remote;

		assert.equal(typeof acceptsRealAgent, "function");

		const message = userMessage("one", 1);
		await remoteSession.prompt("text");
		await remoteSession.prompt(message);
		await remoteSession.prompt([message]);
		assert.equal(remote.prompts.length, 3);
	});

	it("preserves the public Agent-typed component surfaces", () => {
		const acceptsExistingSurface = (
			panel: ChatPanel,
			agentInterface: AgentInterface,
			artifactsPanel: ArtifactsPanel,
			agent: Agent,
		): void => {
			panel.agent = agent;
			agentInterface.session = agent;
			artifactsPanel.agent = agent;
			const panelAgent: Agent | undefined = panel.agent;
			const interfaceAgent: Agent | undefined = agentInterface.session;
			const artifactsAgent: Agent | undefined = artifactsPanel.agent;
			void panelAgent?.waitForIdle();
			void interfaceAgent?.continue();
			void artifactsAgent?.waitForIdle();
			void artifactsPanel.reconstructFromMessages([{ role: "aborted" }]);
			void artifactsPanel.reconstructFromMessages([{ role: "artifact" }]);
			void panel.setAgent(agent, {
				toolsFactory: (localAgent: Agent) => {
					void localAgent.waitForIdle();
					return [];
				},
			});
			void panel.setRemoteSession(agent);
		};

		assert.equal(typeof acceptsExistingSurface, "function");
	});

	it("selects an Agent-shaped remote proxy by explicit ownership rather than method shape", () => {
		const remote = Object.freeze(
			Object.assign(createFakeSession(), {
				continue: async () => {},
				streamFunction: streamSimple,
				waitForIdle: async () => {},
			}),
		);
		const selection = selectAgentSession(remote as unknown as Agent, remote);

		assert.equal(selection?.ownership, "remote");
		assert.equal(selection?.session, remote);
		assert.equal(remote.streamFunction, streamSimple);
		assert.equal("getApiKey" in remote, false);
	});

	it("invalidates asynchronous setup when connection ends during an await", async () => {
		const guard = new AgentSessionConnectionGuard();
		const generation = guard.begin();
		assert.equal(guard.isCurrent(generation, true), true);
		const setup = Promise.resolve().then(() => guard.isCurrent(generation, false));
		guard.disconnect();

		assert.equal(await setup, false);
	});

	it("supports independent listeners and their unsubscribe functions", async () => {
		const session = createFakeSession();
		let firstCalls = 0;
		let secondCalls = 0;
		const unsubscribeFirst = session.subscribe(() => {
			firstCalls++;
		});
		const unsubscribeSecond = session.subscribe(() => {
			secondCalls++;
		});

		await session.emit({ type: "agent_start" });
		unsubscribeFirst();
		await session.emit({ type: "agent_start" });
		unsubscribeSecond();

		assert.equal(firstCalls, 1);
		assert.equal(secondCalls, 2);
		assert.equal(session.listenerCount, 0);
	});

	it("skips tool creation when manageTools is false and installs tools when true", () => {
		const session = createFakeSession();
		const originalTools = session.state.tools;
		let factoryCalls = 0;

		installManagedTools(session, false, () => {
			factoryCalls++;
			return [];
		});

		assert.equal(factoryCalls, 0);
		assert.equal(session.state.tools, originalTools);

		installManagedTools(session, true, () => {
			factoryCalls++;
			return [];
		});
		assert.equal(factoryCalls, 1);
		assert.notEqual(session.state.tools, originalTools);
	});

	it("copy-assigns transcript messages created by the artifacts runtime", async () => {
		const session = createFakeSession();
		const artifacts = new Map<string, { content: string }>();
		const panel = {
			artifacts,
			tool: {
				async execute(
					_toolCallId: string,
					args: { command: string; filename: string; content?: string },
				): Promise<void> {
					if (args.command === "delete") artifacts.delete(args.filename);
					else artifacts.set(args.filename, { content: args.content ?? "" });
				},
			},
		};
		const provider = new ArtifactsRuntimeProvider(panel, session);
		const beforeCreate = session.state.messages;

		await provider.handleMessage(
			{ type: "artifact-operation", action: "createOrUpdate", filename: "note.txt", content: "hello" },
			() => {},
		);
		assert.notEqual(session.state.messages, beforeCreate);
		const createMessage = session.state.messages.at(-1);
		assert.equal(createMessage?.role, "artifact");
		if (createMessage?.role === "artifact") {
			assert.equal(createMessage.action, "create");
			assert.equal(createMessage.filename, "note.txt");
		}

		const beforeDelete = session.state.messages;
		await provider.handleMessage({ type: "artifact-operation", action: "delete", filename: "note.txt" }, () => {});
		assert.notEqual(session.state.messages, beforeDelete);
		const deleteMessage = session.state.messages.at(-1);
		assert.equal(deleteMessage?.role, "artifact");
		if (deleteMessage?.role === "artifact") {
			assert.equal(deleteMessage.action, "delete");
			assert.equal(deleteMessage.filename, "note.txt");
		}
	});
});

describe("AgentTranscriptReconciler", () => {
	it("subscribes once, reacts to transcript events, and cleans up", async () => {
		const session = createFakeSession();
		const snapshots: number[] = [];
		const reconciler = new AgentTranscriptReconciler(session, async (messages) => {
			snapshots.push(messages.length);
		});
		await reconciler.connect();
		await reconciler.connect();
		assert.equal(session.listenerCount, 1);
		assert.deepEqual(snapshots, [0]);

		await session.emit({ type: "agent_start" });
		assert.deepEqual(snapshots, [0]);

		const message = userMessage("one", 1);
		session.state.messages = [message];
		await session.emit({ type: "message_end", message });
		await Promise.resolve();
		assert.deepEqual(snapshots, [0, 1]);

		reconciler.dispose();
		assert.equal(session.listenerCount, 0);
		session.state.messages = [message, userMessage("two", 2)];
		await session.emit({ type: "agent_end", messages: session.state.messages });
		assert.deepEqual(snapshots, [0, 1]);
	});

	it("takes a fresh snapshot when a detached reconciler first connects", async () => {
		const session = createFakeSession();
		const snapshots: string[][] = [];
		const reconciler = new AgentTranscriptReconciler(session, async (messages) => {
			snapshots.push(
				messages.map((message) =>
					message.role === "user" && typeof message.content === "string" ? message.content : "",
				),
			);
		});

		session.state.messages = [userMessage("detached", 1)];
		await reconciler.reconcile();
		session.state.messages = [userMessage("detached", 1), userMessage("before-connect", 2)];
		await reconciler.connect();

		assert.deepEqual(snapshots, [["detached"], ["detached", "before-connect"]]);
		assert.equal(session.listenerCount, 1);
	});

	it("serializes reconstruction and coalesces to the newest transcript", async () => {
		const session = createFakeSession();
		const snapshots: string[][] = [];
		let releaseFirst: (() => void) | undefined;
		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const reconciler = new AgentTranscriptReconciler(session, async (messages) => {
			snapshots.push(
				messages.map((message) =>
					message.role === "user" && typeof message.content === "string" ? message.content : "",
				),
			);
			if (snapshots.length === 1) {
				markFirstStarted?.();
				await firstGate;
			}
		});

		session.state.messages = [userMessage("one", 1)];
		const first = reconciler.reconcile();
		await firstStarted;
		session.state.messages = [userMessage("one", 1), userMessage("two", 2)];
		const second = reconciler.reconcile();
		releaseFirst?.();
		await Promise.all([first, second]);

		assert.deepEqual(snapshots, [["one"], ["one", "two"]]);
	});

	it("drains the latest snapshot after failures and exposes every failure through the shared promise", async () => {
		const session = createFakeSession();
		const snapshots: number[] = [];
		let releaseFirst: (() => void) | undefined;
		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let applyCount = 0;
		const reconciler = new AgentTranscriptReconciler(session, async (messages) => {
			applyCount++;
			snapshots.push(messages.length);
			if (applyCount === 1) {
				markFirstStarted?.();
				await firstGate;
				throw new Error("first reconstruction failed");
			}
			if (applyCount === 2) throw new Error("second reconstruction failed");
		});

		session.state.messages = [userMessage("one", 1)];
		const first = reconciler.reconcile();
		await firstStarted;
		session.state.messages = [userMessage("one", 1), userMessage("two", 2)];
		const second = reconciler.reconcile();
		assert.equal(first, second);
		releaseFirst?.();

		const results = await Promise.allSettled([first, second]);
		for (const result of results) {
			assert.equal(result.status, "rejected");
			if (result.status === "rejected") {
				assert.ok(result.reason instanceof AggregateError);
				assert.deepEqual(
					result.reason.errors.map((error: unknown) => (error instanceof Error ? error.message : String(error))),
					["first reconstruction failed", "second reconstruction failed"],
				);
			}
		}
		assert.deepEqual(snapshots, [1, 2]);

		session.state.messages = [userMessage("recovered", 3)];
		await reconciler.reconcile();
		assert.deepEqual(snapshots, [1, 2, 1]);
	});
});
