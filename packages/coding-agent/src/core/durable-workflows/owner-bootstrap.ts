import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import { openNodeSqliteStorage } from "@shuv1337/shuvpi-durable/storage/sqlite/node";
import { getAgentDir } from "../../config.ts";
import { ModelRegistry } from "../model-registry.ts";
import { ModelRuntime } from "../model-runtime.ts";
import { SettingsManager } from "../settings-manager.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	ExecutionEnvs,
	findInitialAgentModel,
} from "./harness-setup.ts";
import { installWorkflowMcp } from "./owner-mcp.ts";
import { startDurableWorkflowService } from "./service.ts";

/** CLI-only detached owner entry point. Kept outside main.ts so ordinary SDK imports stay lightweight. */
export async function runDurableWorkflowOwner(args: string[]): Promise<boolean> {
	if (args[0] !== "--durable-workflow-owner") return false;
	const [socketPath, database, cwdArg, trustArg, ...extra] = args.slice(1);
	if (!socketPath || !database || !cwdArg || (trustArg !== "trusted" && trustArg !== "untrusted") || extra.length > 0)
		throw new Error("Invalid durable workflow owner arguments");
	const cwd = resolve(cwdArg);
	const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
	configureHarnessHttp(settingsManager);
	const modelRuntime = await ModelRuntime.create();
	const initial = await findInitialAgentModel(settingsManager, modelRuntime);
	const envs = new ExecutionEnvs(cwd);
	const registry = createCodingRegistry(settingsManager, cwd);
	const modelRegistry = new ModelRegistry(modelRuntime);
	const nativeMcp = await installWorkflowMcp(registry, {
		cwd,
		agentDir: getAgentDir(),
		projectTrusted: trustArg === "trusted",
		providerToken: (provider) => modelRegistry.getApiKeyForProvider(provider),
	});
	let stopping = false;
	let service: Awaited<ReturnType<typeof startDurableWorkflowService>> | undefined;
	try {
		service = await startDurableWorkflowService(
			{
				socketPath,
				openStorage: () => openNodeSqliteStorage(database),
				harness: {
					models: modelRuntime,
					registry,
					settings: createHarnessSettings(settingsManager),
					env: envs.env,
					toolPolicies: [nativeMcp.policy],
				},
				agent: {
					cwd,
					...(initial.model === undefined ? {} : { model: initial.model }),
					...(initial.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
				},
			},
			BACKGROUND_CONTEXT,
		);
		await new Promise<void>((resolveStop) => {
			const stop = () => {
				if (stopping) return;
				stopping = true;
				resolveStop();
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
	} finally {
		try {
			await service?.close();
		} finally {
			try {
				await nativeMcp.close();
			} finally {
				await envs.cleanup(BACKGROUND_CONTEXT);
			}
		}
	}
	return true;
}
