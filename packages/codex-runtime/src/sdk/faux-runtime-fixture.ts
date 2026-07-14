import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@shuv1337/shuvpi-ai/compat";
import { AuthStorage, ModelRegistry } from "@shuv1337/shuvpi-coding-agent";
import { PiSdkSessionFactory } from "./pi-sdk-session.ts";

export const PI_RUNTIME_FAUX_RESPONSES_ENV = "PI_CODEX_RUNTIME_FAUX_RESPONSES_JSON";

export interface FauxRuntimeFixture {
	factory: PiSdkSessionFactory;
	provider: string;
	model: string;
	dispose(): void;
}

export interface FauxHostToolResponse {
	toolCall: {
		name: string;
		arguments: Record<string, unknown>;
		id?: string;
	};
}

export type FauxRuntimeResponse = string | FauxHostToolResponse;

export function createFauxRuntimeFixture(responses: FauxRuntimeResponse[]): FauxRuntimeFixture {
	if (responses.length === 0) {
		throw new Error("the Pi runtime faux fixture requires at least one response");
	}
	const faux = registerFauxProvider();
	faux.setResponses(
		responses.map((response) =>
			typeof response === "string"
				? fauxAssistantMessage(response)
				: fauxAssistantMessage(
						fauxToolCall(response.toolCall.name, response.toolCall.arguments, { id: response.toolCall.id }),
						{ stopReason: "toolUse" },
					),
		),
	);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				headers: model.headers,
				compat: model.compat,
			},
		],
	});
	return {
		factory: new PiSdkSessionFactory({ authStorage, modelRegistry }),
		provider: model.provider,
		model: model.id,
		dispose: () => faux.unregister(),
	};
}

export function fauxRuntimeFixtureFromEnvironment(): FauxRuntimeFixture | undefined {
	const encoded = process.env[PI_RUNTIME_FAUX_RESPONSES_ENV];
	if (!encoded) {
		return undefined;
	}
	const parsed: unknown = JSON.parse(encoded);
	if (!Array.isArray(parsed) || !parsed.every(isFauxRuntimeResponse)) {
		throw new Error(`${PI_RUNTIME_FAUX_RESPONSES_ENV} must be an array of strings or host tool responses`);
	}
	return createFauxRuntimeFixture(parsed);
}

function isFauxRuntimeResponse(value: unknown): value is FauxRuntimeResponse {
	if (typeof value === "string") return true;
	if (!value || typeof value !== "object" || !("toolCall" in value)) return false;
	const toolCall = value.toolCall;
	return Boolean(
		toolCall &&
			typeof toolCall === "object" &&
			"name" in toolCall &&
			typeof toolCall.name === "string" &&
			"arguments" in toolCall &&
			toolCall.arguments &&
			typeof toolCall.arguments === "object" &&
			!Array.isArray(toolCall.arguments) &&
			(!("id" in toolCall) || toolCall.id === undefined || typeof toolCall.id === "string"),
	);
}
