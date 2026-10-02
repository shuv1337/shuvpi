import { join } from "node:path";
import type { Registry, ToolPolicy } from "@shuv1337/shuvpi-durable";
import { loadMcpConfig, type McpServerEntry } from "../../extensions/mcp/config.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	type McpTransportFactory,
} from "../../extensions/mcp/runtime.ts";
import { createMcpToolName } from "../../extensions/mcp/tools.ts";
import { FileAuthStorageBackend } from "../auth-storage.ts";
import { getMcpToolExposure, mcpNamespace } from "../mcp-servers.ts";
import { createDurableCodemodeTool, createDurableMcpTool, type DurableCodemodeCallableTool } from "./codemode.ts";
import { workflowCompatibility } from "./owner-context.ts";

const POLICY_ID = "coding-agent.workflow-mcp";

/** Native MCP transports and credentials, with project configuration gated by explicit trust. No AgentSession is created. */
export async function installWorkflowMcp(
	registry: Registry,
	options: {
		cwd: string;
		agentDir: string;
		projectTrusted: boolean;
		providerToken?: (provider: string) => Promise<string | undefined>;
		createTransport?: McpTransportFactory;
	},
): Promise<{ policy: ToolPolicy; close(): Promise<void> }> {
	const configOptions = { cwd: options.cwd, agentDir: options.agentDir, projectTrusted: options.projectTrusted };
	const loaded = loadMcpConfig(configOptions);
	if (loaded.errors.length > 0) throw new Error(`Invalid authorized MCP configuration: ${loaded.errors.join("; ")}`);
	const connections: McpServerConnection[] = [];
	const tools: DurableCodemodeCallableTool[] = [createDurableCodemodeTool()];
	const entries = new Map<string, { entry: McpServerEntry; compatibility: string }>();
	const credentials = new McpOAuthCredentialStore(
		new FileAuthStorageBackend(join(options.agentDir, "mcp-auth.json")),
		options.agentDir,
	);
	const close = async () => {
		await Promise.all(connections.map((connection) => connection.close()));
	};
	const assertConfigured = (entry: McpServerEntry, compatibility: string) => {
		const current = loadMcpConfig(configOptions);
		const configured = current.servers.find((server) => server.name === entry.name);
		if (
			current.errors.length > 0 ||
			!configured ||
			configured.config.enabled === false ||
			workflowCompatibility({ config: configured.config, scope: configured.scope, source: configured.source }) !==
				compatibility
		)
			throw new Error(`MCP authorization for ${entry.name} changed; restart the workflow owner`);
	};
	try {
		const names = new Set(
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name),
		);
		names.add("codemode");
		for (const entry of loaded.servers) {
			if (entry.config.enabled === false) continue;
			if (
				entry.config.exposure === "hidden" &&
				Object.values(entry.config.toolExposure ?? {}).every((value) => value === "hidden")
			)
				continue;
			const connection = new McpServerConnection({
				entry,
				cwd: options.cwd,
				credentials,
				createTransport: options.createTransport ?? createDefaultTransport,
				providerToken: options.providerToken,
				onTools: () => {},
			});
			connections.push(connection);
			await connection.getClient();
			const configured = workflowCompatibility({ config: entry.config, scope: entry.scope, source: entry.source });
			for (const remote of [...connection.tools].sort((a, b) => a.name.localeCompare(b.name))) {
				const exposure = getMcpToolExposure(entry.config, remote.name);
				if (exposure === "hidden") continue;
				const name = createMcpToolName(entry.name, remote.name, (candidate) => names.has(candidate));
				if (names.has(name)) throw new Error(`Duplicate workflow MCP tool ${name}`);
				names.add(name);
				entries.set(name, { entry, compatibility: configured });
				const remoteCompatibility = workflowCompatibility(remote);
				tools.push(
					createDurableMcpTool(
						{
							server: entry.name,
							tool: remote,
							name,
							exposure,
							namespace: {
								name: mcpNamespace(entry.name),
								description: entry.config.description ?? connection.instructions,
							},
							timeoutMs: connection.timeoutMs,
							getClient: async () => {
								assertConfigured(entry, configured);
								await connection.getClient();
								const current = connection.tools.find((tool) => tool.name === remote.name);
								if (!current || workflowCompatibility(current) !== remoteCompatibility)
									throw new Error(`MCP tool ${name} changed; restart the workflow owner`);
								assertConfigured(entry, configured);
								return connection;
							},
						},
						{
							effect: "mutation",
							replay: "unsafe",
							compatibility: workflowCompatibility({ version: 1, configured, remoteCompatibility }),
							requiredPolicies: [POLICY_ID],
						},
					),
				);
			}
		}
		registry.install({
			name: "coding-agent.workflow-mcp",
			tools,
			sections: [
				{
					key: "workflow_mcp",
					render({ agent }) {
						const namespaces = new Map<string, string>();
						for (const tool of agent.tools as readonly DurableCodemodeCallableTool[]) {
							if (tool.exposure === "hidden" || !tool.namespace) continue;
							namespaces.set(tool.namespace.name, tool.namespace.description ?? "");
						}
						if (!namespaces.size) return undefined;
						return `Use codemode searchTools() or describeNamespace() to discover these MCP namespaces:\n${[...namespaces].map(([name, description]) => `${name}: ${description}`).join("\n")}`;
					},
				},
			],
		});
		return {
			close,
			policy: {
				id: POLICY_ID,
				compatibility: "1",
				authorize(call) {
					const configured = entries.get(call.name);
					if (configured) assertConfigured(configured.entry, configured.compatibility);
				},
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
