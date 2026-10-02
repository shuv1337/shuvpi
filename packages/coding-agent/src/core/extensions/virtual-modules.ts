import * as bundledPiAgentCore from "@shuv1337/shuvpi-agent-core";
import * as bundledPiAiCompat from "@shuv1337/shuvpi-ai/compat";
import * as bundledPiAiOauth from "@shuv1337/shuvpi-ai/oauth";
import * as bundledPiAiProviders from "@shuv1337/shuvpi-ai/providers/all";
import * as bundledPiTui from "@shuv1337/shuvpi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import * as activeSkills from "../../extensions/active-skills/index.ts";
import * as backgroundJobs from "../../extensions/background-jobs/index.ts";
import * as bashMode from "../../extensions/bash-mode/index.ts";
import * as diffRenderer from "../../extensions/diff-renderer/index.ts";
import * as fastMode from "../../extensions/fast-mode/index.ts";
import * as head from "../../extensions/head/index.ts";
import * as imageFiles from "../../extensions/image-files/index.ts";
import * as incrementalWorkflow from "../../extensions/incremental-workflow/index.ts";
import * as openInEditor from "../../extensions/open-in-editor/index.ts";
import * as powerline from "../../extensions/powerline/index.ts";
import * as preferredModels from "../../extensions/preferred-models/index.ts";
import * as promptHistory from "../../extensions/prompt-history/index.ts";
import * as questionnaire from "../../extensions/questionnaire/index.ts";
import * as skillBrowser from "../../extensions/skill-browser/index.ts";
import * as claudeSubagents from "../../extensions/subagents/claude.ts";
import * as subagents from "../../extensions/subagents/index.ts";
import * as workflow from "../../extensions/workflow/index.ts";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @shuv1337/shuvpi-coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@shuv1337/shuvpi-agent-core": bundledPiAgentCore,
	"@shuv1337/shuvpi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@shuv1337/shuvpi-ai": bundledPiAiCompat,
	"@shuv1337/shuvpi-ai/compat": bundledPiAiCompat,
	"@shuv1337/shuvpi-ai/oauth": bundledPiAiOauth,
	"@shuv1337/shuvpi-ai/providers/all": bundledPiAiProviders,
	"@shuv1337/shuvpi-coding-agent": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};

const extensionModules = {
	head,
	"diff-renderer": diffRenderer,
	questionnaire,
	workflow,
	"incremental-workflow": incrementalWorkflow,
	"image-files": imageFiles,
	"open-in-editor": openInEditor,
	"background-jobs": backgroundJobs,
	"skill-browser": skillBrowser,
	"active-skills": activeSkills,
	"fast-mode": fastMode,
	"preferred-models": preferredModels,
	powerline,
	subagents,
	"subagents/claude": claudeSubagents,
	"bash-mode": bashMode,
	"prompt-history": promptHistory,
};

for (const [name, module] of Object.entries(extensionModules)) {
	VIRTUAL_MODULES[`@shuv1337/shuvpi-coding-agent/extensions/${name}`] = module;
	VIRTUAL_MODULES[`@mariozechner/pi-coding-agent/extensions/${name}`] = module;
}
