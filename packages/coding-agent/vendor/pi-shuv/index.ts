import type { ExtensionAPI } from "@shuv1337/shuvpi-coding-agent";

import askQuestions from "./vendor/ask-questions/index.ts";
import diffRenderer from "./vendor/diff-renderer/index.ts";
import imageGen from "./vendor/image-gen/index.ts";
import skillPalette from "./vendor/pi-skill-palette/index.ts";
import skillDollar from "./vendor/pi-skill-dollar/index.ts";
import openInEditor from "./vendor/pi-open-in-editor/index.ts";
import webSearch from "./vendor/pi-web-search/src/index.ts";
import powerlineFooter from "./vendor/powerline-footer/index.ts";
import toolPolicy from "./vendor/pi-tool-policy/index.js";
import autoTrees from "./vendor/pi-auto-trees/index.ts";
import openaiServerCompaction from "./vendor/pi-openai-server-compaction/src/index.ts";
import mcpAdapter from "./vendor/pi-mcp-adapter/index.ts";
import backgroundTerminals from "./vendor/background-terminals/index.ts";
import subagents from "./vendor/subagents/index.ts";
import workflows from "./vendor/workflows/index.ts";

import { registerHead } from "./features/head.ts";
import { registerFastModel } from "./features/fast-model.ts";

type PiExtension = (pi: ExtensionAPI) => void | Promise<void>;

const modules: Array<[name: string, register: PiExtension]> = [
  ["ask-questions", askQuestions],
  ["diff-renderer", diffRenderer],
  ["image-gen", imageGen],
  ["pi-skill-palette", skillPalette],
  ["pi-skill-dollar", skillDollar],
  ["pi-open-in-editor", openInEditor],
  ["pi-web-search", webSearch],
  ["powerline-footer", powerlineFooter],
  ["pi-tool-policy", toolPolicy],
  ["pi-auto-trees", autoTrees],
  ["pi-openai-server-compaction", openaiServerCompaction],
  ["pi-mcp-adapter", mcpAdapter],
  ["background-terminals", backgroundTerminals],
  ["subagents", subagents],
  ["workflows", workflows],
];

export default async function piShuv(pi: ExtensionAPI): Promise<void> {
  for (const [name, register] of modules) {
    try {
      await register(pi);
    } catch (error) {
      console.error(`[pi-shuv] Failed to register ${name}:`, error);
    }
  }

  registerHead(pi);
  registerFastModel(pi);
}
