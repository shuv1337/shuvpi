import { realpath } from "node:fs/promises";
import type {
	Api,
	ApiStreamOptions,
	Model,
	ModelsApiStreamOptions,
	Provider,
	TranscriptContext,
} from "@shuv1337/shuvpi-ai";
import { getAgentDir } from "../../config.ts";
import { AuthStorage } from "../auth-storage.ts";
import { ModelRuntime } from "../model-runtime.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import { SettingsManager } from "../settings-manager.ts";
import type { SubagentBackend } from "./types.ts";

/** Isolated transcripts and settings; credentials remain owned by the parent's request runtime. */
export function createPiSubagentBackend(): SubagentBackend {
	return {
		name: "pi",
		async create(request, emit) {
			const registry = request.parent.modelRegistry;
			const model = request.model
				? registry.getAll().find((candidate) => `${candidate.provider}/${candidate.id}` === request.model)
				: request.parent.model;
			if (!model) throw new Error("No subagent model selected");
			const cwd = await realpath(request.cwd);
			const trusted = cwd === (await realpath(request.parent.cwd)) && request.parent.isProjectTrusted();
			const settings = SettingsManager.inMemory({ cacheWarming: "off" });
			settings.setProjectTrusted(trusted);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				refreshOnCreate: false,
			});
			const provider: Provider = {
				id: model.provider,
				name: model.provider,
				auth: { apiKey: { name: "Parent runtime", resolve: async () => ({ auth: {} }) } },
				getModels: () => [model],
				stream<T extends Api>(selected: Model<T>, context: TranscriptContext, options?: ApiStreamOptions<T>) {
					return registry.stream<T>(selected, context, options as ModelsApiStreamOptions<T>);
				},
				streamSimple: (selected, context, options) => registry.streamSimple(selected, context, options),
			};
			runtime.registerNativeProvider(provider);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir: getAgentDir(),
				settingsManager: settings,
				noExtensions: true,
				noSkills: !trusted,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: !trusted,
			});
			await loader.reload();
			request.signal.throwIfAborted();
			const { session } = await createAgentSession({
				cwd,
				modelRuntime: runtime,
				model,
				thinkingLevel: request.effort ?? request.parent.thinkingLevel,
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager: settings,
				resourceLoader: loader,
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			});
			emit({ type: "session", sessionId: session.sessionManager.getSessionId() });
			let active: Promise<void> | undefined;
			let run = 0;
			let output = "";
			let interrupted = false;
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					const text = event.assistantMessageEvent.delta;
					output = (output + text).slice(-2 * 1024 * 1024);
					emit({ type: "text", run, text });
				}
			});
			const interrupt = async () => {
				interrupted = true;
				await session.abort();
				await active;
			};
			return {
				async send(prompt, steer, nextRun) {
					if (steer) {
						await session.steer(prompt);
						return;
					}
					if (active) throw new Error("Subagent is already running");
					run = nextRun;
					output = "";
					interrupted = false;
					active = session.prompt(prompt).then(
						() => {
							active = undefined;
							const last = session.messages.findLast((message) => message.role === "assistant");
							const error = last?.role === "assistant" ? last.errorMessage : undefined;
							const stopReason = last?.role === "assistant" ? last.stopReason : undefined;
							emit({
								type: "settled",
								run,
								status:
									interrupted || stopReason === "aborted"
										? "aborted"
										: error || stopReason === "error"
											? "error"
											: "done",
								output,
								error,
							});
						},
						(error: unknown) => {
							active = undefined;
							emit({
								type: "settled",
								run,
								status: interrupted ? "aborted" : "error",
								output,
								error: String(error),
							});
						},
					);
				},
				interrupt,
				async close() {
					await interrupt();
					unsubscribe();
					session.dispose();
				},
			};
		},
	};
}
