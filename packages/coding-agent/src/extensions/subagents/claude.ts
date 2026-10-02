import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { query as claudeQuery, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createJiti } from "jiti";
import { getPackageJsonPath } from "../../config.ts";
import { createClaudeSubagentBackend } from "../../core/subagents/claude.ts";
import { createCodexSubagentBackend } from "../../core/subagents/codex.ts";
import { createPiSubagentBackend } from "../../core/subagents/pi.ts";
import { createSubagentsExtension } from "./index.ts";

/** Load the optional SDK beside the installed package/binary only when a Claude child starts. */
export default createSubagentsExtension({
	backends: [
		createPiSubagentBackend(),
		createCodexSubagentBackend(),
		createClaudeSubagentBackend(({ prompt, options }) => {
			const packageJsonPath = getPackageJsonPath();
			const require = createRequire(packageJsonPath);
			let sdkPath: string;
			try {
				// Compiled Bun cannot resolve filesystem package directories. Jiti reads
				// their exports/main metadata while preserving ancestor node_modules lookup.
				sdkPath = fileURLToPath(
					createJiti(packageJsonPath, { fsCache: false }).esmResolve("@anthropic-ai/claude-agent-sdk"),
				);
			} catch (cause) {
				throw new Error(
					"Claude subagents require @anthropic-ai/claude-agent-sdk installed beside the shuvpi package or standalone binary.",
					{ cause },
				);
			}
			const { query } = require(sdkPath) as { query: typeof claudeQuery };
			return query({
				options,
				prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
					yield {
						type: "user",
						message: { role: "user", content: prompt },
						parent_tool_use_id: null,
						session_id: options.resume ?? "",
					};
				})(),
			});
		}),
	],
});
