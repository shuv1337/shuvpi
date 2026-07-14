import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const codingAgentSrcIndex = fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^string_decoder$/, replacement: "node:string_decoder" },
			{ find: /^stream\/promises$/, replacement: "node:stream/promises" },
			{ find: /^stream$/, replacement: "node:stream" },
			{ find: /^@shuv1337\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@shuv1337\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@shuv1337\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@shuv1337\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@shuv1337\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@shuv1337\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
