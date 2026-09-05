import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetryIndex = fileURLToPath(new URL("../../telemetry/src/index.ts", import.meta.url));
const aiIndex = fileURLToPath(new URL("../../ai/src/index.ts", import.meta.url));
const agentIndex = fileURLToPath(new URL("../../agent/src/index.ts", import.meta.url));
const agentSessionTesting = fileURLToPath(
	new URL("../../agent/src/harness/session/testing/index.ts", import.meta.url),
);

export default defineConfig({
	test: {
		environment: "node",
		benchmark: {
			include: ["benchmark/session/**/*.bench.ts"],
			reporters: ["verbose"],
		},
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@shuv1337\/shuvpi-telemetry$/, replacement: telemetryIndex },
			{ find: /^@shuv1337\/shuvpi-agent-core\/session\/testing$/, replacement: agentSessionTesting },
			{ find: /^@shuv1337\/shuvpi-agent-core$/, replacement: agentIndex },
			{ find: /^@shuv1337\/shuvpi-ai$/, replacement: aiIndex },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
