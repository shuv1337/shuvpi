import type { AgentTool } from "@shuv1337/shuvpi-agent-core";
import { isJsonValue, type JsonValue } from "@shuv1337/shuvpi-chord";
import { withAbortSignal } from "@shuv1337/shuvpi-chord/context";
import { defineDoc, type JsonObject, type ToolRegistration } from "@shuv1337/shuvpi-durable";
import type { TSchema } from "typebox";
import { executeCodemodeWithHost } from "../../extensions/codemode/execute.ts";
import { CODEMODE_TOOL_NAME, codemodeSchema, createCodemodeDescription } from "../../extensions/codemode/tool.ts";
import { createMcpToolDefinition } from "../../extensions/mcp/tools.ts";
import type { ToolExposure, ToolNamespace } from "../extensions/types.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";

export type DurableCodemodeCallableTool = ToolRegistration & {
	readonly outputSchema?: TSchema;
	readonly exposure?: ToolExposure;
	readonly namespace?: ToolNamespace;
};

/** Store values follow the conversation's history and are copied at the fork point. */
export const DurableCodemodeStore = defineDoc<{ values: Record<string, JsonValue> }>({
	kind: "coding-agent.codemode-store",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ values: {} }),
});

/** Host classification is explicit; untrusted MCP annotations never grant replay or effect privileges. */
export function createDurableMcpTool(
	options: Parameters<typeof createMcpToolDefinition>[0],
	policy: Pick<ToolRegistration, "effect" | "replay" | "compatibility" | "requiredPolicies">,
): DurableCodemodeCallableTool {
	const definition = createMcpToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		outputSchema: tool.outputSchema,
		exposure: definition.exposure,
		namespace: definition.namespace,
		...policy,
		async execute(args, api, context) {
			const result = await tool.execute(api.callId, args, context.abortSignal, (update) => {
				for (const block of update.content) if (block.type === "text") api.output(block.text);
			});
			const structuredContent = result.structuredContent;
			if (structuredContent !== undefined && !isJsonValue(structuredContent))
				throw new Error("MCP structured content must be JSON");
			return {
				content: result.content,
				isError: result.isError,
				details: { ...result.details },
				...(structuredContent === undefined ? {} : { structuredContent }),
			};
		},
	};
}

/** One Harness owns both direct tools and sandbox calls. Arbitrary JavaScript is never transparently replayed. */
export function createDurableCodemodeTool(): DurableCodemodeCallableTool {
	return {
		name: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription([]),
		parameters: codemodeSchema,
		exposure: "model-only",
		effect: "mutation",
		replay: "unsafe",
		compatibility: "coding-agent.codemode-host/1",
		async execute(args, api, context) {
			if (!args || typeof args !== "object" || !("code" in args) || typeof args.code !== "string")
				throw new Error("Codemode requires a code string");
			const agent = await api.agent(context);
			const registrations = agent.tools as readonly DurableCodemodeCallableTool[];
			const tools: AgentTool[] = registrations
				.filter((tool) => tool.exposure !== "model-only" && tool.exposure !== "hidden")
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					outputSchema: tool.outputSchema,
					label: tool.name,
					execute: async () => {
						throw new Error("Nested tools must use the durable dispatch boundary");
					},
				}));
			let ordinal = 0;
			const result = await executeCodemodeWithHost(
				api.callId,
				{ code: String(args.code) },
				context.abortSignal,
				undefined,
				{
					tools,
					executeTool: async (name, input, options) => {
						if (!isJsonValue(input) || input === null || typeof input !== "object" || Array.isArray(input)) {
							throw new Error("Tool arguments must be a JSON object");
						}
						const toolCall = {
							type: "toolCall" as const,
							id: `${api.callId}/${++ordinal}`,
							name,
							arguments: input as JsonObject,
						};
						const nested = await api.callTool(
							name,
							input as JsonObject,
							options?.signal ? withAbortSignal(options.signal, context) : context,
						);
						const content = [...(nested.content ?? [])];
						if (nested.diagnostics?.length)
							content.push({
								type: "text",
								text: nested.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
							});
						return {
							toolCall,
							isError: nested.isError === true,
							result: { ...nested, content, details: nested.details ?? {} },
						};
					},
					readStore: async () => ({
						...(await api.snapshot(DurableCodemodeStore, api.conversationId, context))?.values,
					}),
					writeStore: async (writes) => {
						if (!isJsonValue(writes.set)) throw new Error("Codemode store values must be JSON");
						const values = writes.set as Record<string, JsonValue>;
						await api.commit(async (tx) => {
							const store = await tx.doc(DurableCodemodeStore, api.conversationId);
							for (const key of writes.delete) delete store.values[key];
							for (const [key, value] of Object.entries(values)) store.values[key] = value;
						}, context);
					},
				},
				{ getToolNamespace: (name) => registrations.find((tool) => tool.name === name)?.namespace },
			);
			return {
				content: result.content,
				isError: result.isError,
				details: {
					calls: result.details.calls.map((call) => ({ ...call })),
					...(result.details.fullOutputPath ? { fullOutputPath: result.details.fullOutputPath } : {}),
				},
			};
		},
	};
}
