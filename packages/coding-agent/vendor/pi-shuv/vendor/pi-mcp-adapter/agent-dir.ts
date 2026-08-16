import { join } from "node:path";
import { getAgentDir as getShuvpiAgentDir } from "@shuv1337/shuvpi-coding-agent";

/**
 * Vendored retarget: upstream resolved `PI_CODING_AGENT_DIR` / `~/.pi/agent`
 * by hand. Here we delegate to the shuvpi runtime so the adapter writes beside
 * the rest of the agent state (`~/.shuvpi/agent`, or
 * `$SHUVPI_CODING_AGENT_DIR` when set).
 */
export function getAgentDir(): string {
  return getShuvpiAgentDir();
}

export function getAgentPath(...segments: string[]): string {
  return join(getAgentDir(), ...segments);
}
