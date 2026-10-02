import type { ModelThinkingLevel } from "@shuv1337/shuvpi-ai";
import { type AgentChange, type ConversationId, defineTask } from "@shuv1337/shuvpi-durable";
import { Compile } from "typebox/compile";
import { isWorkflowJsonObject, isWorkflowJsonValue } from "./protocol.ts";
import type { WorkflowAgentResult, WorkflowChildRequest } from "./runner.ts";

type ChildInput = WorkflowChildRequest & { childConversationId: ConversationId };

/** One durable input to an owned conversation. Reopening resubmits the same request ID. */
export const WorkflowAgentTask = defineTask<ChildInput, { phase: "run" }, WorkflowAgentResult>({
	name: "coding-agent.workflow-agent",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const child = await runtime.conversation(task.input.childConversationId, context);
			if (!child) throw new Error("Workflow child conversation is missing");
			const schema = task.input.options.schema;
			const prompt =
				schema === undefined
					? task.input.prompt
					: `${task.input.prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema)}`;
			const submission = await child.submit(
				{ type: "input", content: prompt, requestId: `workflow-agent:${runtime.taskId}` },
				context,
			);
			const settled = await submission.wait(context);
			let result: WorkflowAgentResult;
			if (settled.status !== "done" || settled.type !== "input") {
				result = { ok: false, output: "", error: settled.reason ?? "Agent did not answer" };
			} else {
				const view = await runtime.context(task.input.childConversationId, context, settled.answer);
				const answer = view.entries.find((entry) => entry.id === settled.answer);
				const message = answer?.model?.find((value) => value.role === "assistant");
				const output =
					message?.role === "assistant"
						? message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				if (!message) throw new Error("Workflow child answer is missing from its transcript");
				result = { ok: true, output };
				if (schema !== undefined) {
					try {
						const structured: unknown = JSON.parse(output);
						if (
							!isWorkflowJsonValue(structured) ||
							!isWorkflowJsonObject(schema) ||
							!Compile(schema).Check(structured)
						)
							throw new Error("Agent output does not match the requested JSON schema");
						result = { ok: true, output, structured };
					} catch (error) {
						result = { ok: false, output, error: error instanceof Error ? error.message : String(error) };
					}
				}
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Reject unsupported choices instead of silently falling back to a different model or effort. */
export function workflowAgentConfiguration(request: WorkflowChildRequest, defaults: AgentChange): AgentChange {
	const options = request.options;
	for (const key of Object.keys(options)) {
		if (!["model", "effort", "instructions", "schema", "label"].includes(key))
			throw new Error(`Unsupported workflow agent option: ${key}`);
	}
	const config: { -readonly [K in keyof AgentChange]: AgentChange[K] } = { ...defaults };
	if (request.defaults !== undefined) {
		if (request.defaults.model !== undefined) {
			if (
				!isWorkflowJsonObject(request.defaults.model) ||
				typeof request.defaults.model.provider !== "string" ||
				typeof request.defaults.model.modelId !== "string"
			)
				throw new Error("Workflow default model requires provider and modelId");
			config.model = {
				provider: request.defaults.model.provider,
				modelId: request.defaults.model.modelId,
			};
		}
		if (request.defaults.effort !== undefined) {
			if (
				typeof request.defaults.effort !== "string" ||
				!["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(request.defaults.effort)
			)
				throw new Error("Workflow default effort is invalid");
			config.thinkingLevel = request.defaults.effort as ModelThinkingLevel;
		}
	}
	if (options.model !== undefined) {
		if (
			!isWorkflowJsonObject(options.model) ||
			typeof options.model.provider !== "string" ||
			typeof options.model.modelId !== "string"
		)
			throw new Error("Workflow model requires provider and modelId");
		config.model = { provider: options.model.provider, modelId: options.model.modelId };
	}
	if (options.effort !== undefined) {
		if (
			typeof options.effort !== "string" ||
			!["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(options.effort)
		)
			throw new Error("Invalid workflow agent effort");
		config.thinkingLevel = options.effort as ModelThinkingLevel;
	}
	if (options.instructions !== undefined) {
		if (typeof options.instructions !== "string") throw new Error("Workflow instructions must be text");
		config.instructions = options.instructions;
	}
	if (options.schema !== undefined) {
		if (!isWorkflowJsonObject(options.schema)) throw new Error("Workflow schema must be a JSON object");
		Compile(options.schema);
	}
	return config;
}
