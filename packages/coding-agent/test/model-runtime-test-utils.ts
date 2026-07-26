import type { CredentialStore } from "@shuv1337/shuvpi-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

async function createOfflineRuntime(
	credentials: CredentialStore,
	modelsPath: string | null | undefined,
): Promise<ModelRuntime> {
	const offline = process.env.SHUVPI_OFFLINE;
	process.env.SHUVPI_OFFLINE = "1";
	try {
		return await ModelRuntime.create({ credentials, modelsPath, allowModelNetwork: false });
	} finally {
		if (offline === undefined) delete process.env.SHUVPI_OFFLINE;
		else process.env.SHUVPI_OFFLINE = offline;
	}
}

export async function createModelRegistry(credentials: CredentialStore, modelsPath?: string): Promise<ModelRegistry> {
	return wrap(await createOfflineRuntime(credentials, modelsPath));
}

export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	return wrap(await createOfflineRuntime(credentials, null));
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
