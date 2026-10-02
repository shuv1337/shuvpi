import { createHash } from "node:crypto";
import {
	type AgentChange,
	type ConversationId,
	defineDoc,
	type JsonObject,
	type Registry,
	type ToolPolicy,
	type ToolRegistration,
	type Tx,
} from "@shuv1337/shuvpi-durable";
import { isWorkflowJsonObject, type WorkflowJsonObject } from "./protocol.ts";
import type { WorkflowTaskInput } from "./runner.ts";

const POLICY_ID = "coding-agent.workflow-capabilities";

interface PolicyIdentity extends JsonObject {
	id: string;
	compatibility: string;
}

interface ToolIdentity extends JsonObject {
	name: string;
	compatibility: string;
}

export interface WorkflowCapabilities extends JsonObject {
	version: 1;
	tools: ToolIdentity[];
	policies: PolicyIdentity[];
}

export const WorkflowCapabilitiesDoc = defineDoc<{ capabilities: WorkflowCapabilities | null }>({
	kind: "coding-agent.workflow-capabilities",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ capabilities: null }),
});

/** A canonical digest persists compatibility without copying credentials or configuration into the journal. */
export function workflowCompatibility(value: unknown): string {
	const normalize = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(normalize);
		if (item !== null && typeof item === "object")
			return Object.fromEntries(
				Object.entries(item)
					.filter(([, value]) => value !== undefined)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, value]) => [key, normalize(value)]),
			);
		return item;
	};
	return createHash("sha256")
		.update(JSON.stringify(normalize(value)))
		.digest("hex");
}

function identities(value: unknown, key: "id" | "name"): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				isWorkflowJsonObject(item) &&
				Object.keys(item).length === 2 &&
				typeof item[key] === "string" &&
				item[key].trim() !== "" &&
				typeof item.compatibility === "string" &&
				item.compatibility.trim() !== "",
		) &&
		new Set(value.map((item) => item[key])).size === value.length
	);
}

/** Both the wire admission validator and durable recovery use this exact shape. */
export function isWorkflowAgentContext(value: unknown, allowCapabilities = true): value is WorkflowJsonObject {
	if (!isWorkflowJsonObject(value)) return false;
	if (
		Object.keys(value).some((key) => !["model", "effort", "tools", "requiredPolicies", "capabilities"].includes(key))
	)
		return false;
	if (
		value.model !== undefined &&
		(!isWorkflowJsonObject(value.model) ||
			Object.keys(value.model).length !== 2 ||
			typeof value.model.provider !== "string" ||
			value.model.provider.trim() === "" ||
			typeof value.model.modelId !== "string" ||
			value.model.modelId.trim() === "")
	)
		return false;
	if (
		value.effort !== undefined &&
		(typeof value.effort !== "string" ||
			!["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value.effort))
	)
		return false;
	if (
		value.tools !== undefined &&
		(!Array.isArray(value.tools) ||
			!value.tools.every((name) => typeof name === "string" && name.trim() !== "") ||
			new Set(value.tools).size !== value.tools.length)
	)
		return false;
	if (value.requiredPolicies !== undefined && !identities(value.requiredPolicies, "id")) return false;
	if (value.capabilities !== undefined) {
		const capability = value.capabilities;
		if (
			!allowCapabilities ||
			!isWorkflowJsonObject(capability) ||
			Object.keys(capability).length !== 3 ||
			capability.version !== 1 ||
			!identities(capability.tools, "name") ||
			!identities(capability.policies, "id")
		)
			return false;
	}
	return true;
}

/** One owner captures and enforces the same tools and mandatory headless callbacks across every child. */
export class WorkflowOwnerContext {
	readonly registry: Registry;
	readonly defaults: AgentChange;
	readonly toolPolicies: readonly ToolPolicy[];

	constructor(registry: Registry, defaults: AgentChange, policies: readonly ToolPolicy[] = []) {
		this.registry = registry;
		this.defaults = defaults;
		if (
			new Set(policies.map((policy) => policy.id)).size !== policies.length ||
			policies.some((p) => p.id === POLICY_ID)
		)
			throw new Error("Duplicate workflow tool policy");
		const guard: ToolPolicy = {
			id: POLICY_ID,
			compatibility: "1",
			authorize: async (call, context, api) => {
				const captured = (await api.snapshot(WorkflowCapabilitiesDoc, api.conversationId, context))?.capabilities;
				if (!captured) throw new Error("Workflow capability context is missing");
				const tools = this.validate(captured);
				if (!tools.some((tool) => tool.name === call.name))
					throw new Error(`Workflow tool ${call.name} is not allowed`);
			},
		};
		this.toolPolicies = [guard, ...policies];
		for (const extension of registry.snapshot().installed()) {
			if (!extension.tools?.length) continue;
			registry.install({
				...extension,
				tools: extension.tools.map((tool) => ({
					...tool,
					requiredPolicies: [...new Set([...(tool.requiredPolicies ?? []), POLICY_ID])],
				})),
			});
		}
	}

	prepareInput(input: WorkflowTaskInput): WorkflowTaskInput {
		const requested = input.agent ?? {};
		if (!isWorkflowAgentContext(requested, false))
			throw new Error("Invalid workflow agent context or caller-supplied capabilities");
		const policies = this.toolPolicies
			.map(({ id, compatibility }) => ({ id, compatibility }))
			.sort((a, b) => a.id.localeCompare(b.id));
		for (const required of (requested.requiredPolicies ?? []) as PolicyIdentity[]) {
			if (!policies.some((policy) => policy.id === required.id && policy.compatibility === required.compatibility))
				throw new Error(`Required workflow policy ${required.id} is missing or incompatible`);
		}
		const available = this.tools();
		const names = (requested.tools ?? [...available.keys()]) as string[];
		const tools = names
			.map((name) => {
				const tool = available.get(name);
				if (!tool) throw new Error(`Workflow tool ${name} is unavailable`);
				for (const id of tool.requiredPolicies ?? []) {
					if (!policies.some((policy) => policy.id === id))
						throw new Error(`Required workflow policy ${id} is missing`);
				}
				return { name, compatibility: this.toolCompatibility(tool) };
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		return {
			...input,
			agent: {
				...(this.defaults.model ? { model: { ...this.defaults.model } } : {}),
				...(this.defaults.thinkingLevel ? { effort: this.defaults.thinkingLevel } : {}),
				...requested,
				tools: tools.map((tool) => tool.name),
				capabilities: { version: 1, tools, policies },
			},
		};
	}

	async bind(
		tx: Tx,
		conversationId: ConversationId,
		agent: WorkflowJsonObject | undefined,
	): Promise<ToolRegistration[]> {
		if (!isWorkflowAgentContext(agent) || agent.capabilities === undefined)
			throw new Error("Workflow capability context is missing");
		const captured = agent.capabilities as WorkflowCapabilities;
		const tools = this.validate(captured);
		const document = await tx.doc(WorkflowCapabilitiesDoc, conversationId);
		if (
			document.capabilities !== null &&
			workflowCompatibility(document.capabilities) !== workflowCompatibility(captured)
		)
			throw new Error("Workflow capability context cannot change");
		document.capabilities = captured;
		return tools;
	}

	private tools(): Map<string, ToolRegistration> {
		const result = new Map<string, ToolRegistration>();
		const filter = this.defaults.tools;
		const allowed = filter == null || "remove" in filter ? undefined : new Set(filter.map((tool) => tool.name));
		const removed =
			filter != null && "remove" in filter ? new Set(filter.remove.map((tool) => tool.name)) : undefined;
		for (const { tool } of this.registry.snapshot().tools()) {
			if ((allowed && !allowed.has(tool.name)) || removed?.has(tool.name)) continue;
			if (result.has(tool.name)) throw new Error(`Ambiguous workflow tool ${tool.name}`);
			result.set(tool.name, tool);
		}
		return result;
	}

	private toolCompatibility(tool: ToolRegistration): string {
		return workflowCompatibility({
			name: tool.name,
			implementation: tool.compatibility ?? null,
			parameters: tool.parameters,
			exposure: "exposure" in tool ? tool.exposure : null,
			effect: tool.effect ?? "mutation",
			replay: tool.replay ?? "unsafe",
			requiredPolicies: [...(tool.requiredPolicies ?? [])].sort(),
		});
	}

	private validate(captured: WorkflowCapabilities): ToolRegistration[] {
		for (const required of captured.policies) {
			if (
				!this.toolPolicies.some(
					(policy) => policy.id === required.id && policy.compatibility === required.compatibility,
				)
			)
				throw new Error(`Required workflow policy ${required.id} is missing or incompatible`);
		}
		const available = this.tools();
		return captured.tools.map((expected) => {
			const tool = available.get(expected.name);
			if (!tool || this.toolCompatibility(tool) !== expected.compatibility)
				throw new Error(`Workflow tool ${expected.name} is unavailable or incompatible`);
			return tool;
		});
	}
}
