/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   shuvpi -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@shuv1337/shuvpi-coding-agent";
import { createBashTool } from "@shuv1337/shuvpi-coding-agent";

export default function (shuvpi: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, SHUVPI_SPAWN_HOOK: "1" },
		}),
	});

	shuvpi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
