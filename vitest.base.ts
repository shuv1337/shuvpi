import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordBundler: fileURLToPath(new URL("./packages/chord/src/bundler.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent/src/node.ts", import.meta.url)),
	protocolIndex: fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
	clientIndex: fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
	clientUnix: fileURLToPath(new URL("./packages/client/src/unix.ts", import.meta.url)),
	serverIndex: fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
	serverUnix: fileURLToPath(new URL("./packages/server/src/transports/unix/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@shuv1337\/shuvpi-chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@shuv1337\/shuvpi-chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@shuv1337\/shuvpi-chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@shuv1337\/shuvpi-chord\/bundler$/, replacement: workspaceSourcePaths.chordBundler },
			{ find: /^@shuv1337\/shuvpi-chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@shuv1337\/shuvpi-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@shuv1337\/shuvpi-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@shuv1337\/shuvpi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@shuv1337\/shuvpi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@shuv1337\/shuvpi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@shuv1337\/shuvpi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@shuv1337\/shuvpi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@shuv1337\/shuvpi-agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{ find: /^@shuv1337\/shuvpi-protocol$/, replacement: workspaceSourcePaths.protocolIndex },
			{ find: /^@shuv1337\/shuvpi-client$/, replacement: workspaceSourcePaths.clientIndex },
			{ find: /^@shuv1337\/shuvpi-client\/unix$/, replacement: workspaceSourcePaths.clientUnix },
			{ find: /^@shuv1337\/shuvpi-server$/, replacement: workspaceSourcePaths.serverIndex },
			{ find: /^@shuv1337\/shuvpi-server\/unix$/, replacement: workspaceSourcePaths.serverUnix },
			{ find: /^@shuv1337\/shuvpi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
