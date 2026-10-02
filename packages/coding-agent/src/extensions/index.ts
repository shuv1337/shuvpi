import type { InlineExtension } from "../core/extensions/types.ts";
import { createBackgroundJobsExtension } from "./background-jobs/index.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import { createPowerlineExtension } from "./powerline/index.ts";
import { createQuestionnaireExtension } from "./questionnaire/index.ts";
import { createSkillBrowserExtension } from "./skill-browser/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import { createWorkflowExtension } from "./workflow/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	{ name: "questionnaire", factory: createQuestionnaireExtension(), builtin: true },
	{ name: "background-jobs", factory: createBackgroundJobsExtension(), builtin: true },
	{ name: "skill-browser", factory: createSkillBrowserExtension(), builtin: true },
	{ name: "powerline", factory: createPowerlineExtension(), builtin: true },
	{ name: "workflow", factory: createWorkflowExtension(), builtin: true },
];
