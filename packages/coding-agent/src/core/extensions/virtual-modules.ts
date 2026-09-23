import * as bundledShuvpiAgentCore from "@shuv1337/shuvpi-agent-core";
import * as bundledShuvpiAiCompat from "@shuv1337/shuvpi-ai/compat";
import * as bundledShuvpiAiOauth from "@shuv1337/shuvpi-ai/oauth";
import * as bundledShuvpiAiProviders from "@shuv1337/shuvpi-ai/providers/all";
import * as bundledShuvpiTui from "@shuv1337/shuvpi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @shuv1337/shuvpi-coding-agent.
import * as bundledShuvpiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@shuv1337/shuvpi-agent-core": bundledShuvpiAgentCore,
	"@shuv1337/shuvpi-tui": bundledShuvpiTui,
	// Extensions resolve the shuvpi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@shuv1337/shuvpi-ai": bundledShuvpiAiCompat,
	"@shuv1337/shuvpi-ai/compat": bundledShuvpiAiCompat,
	"@shuv1337/shuvpi-ai/oauth": bundledShuvpiAiOauth,
	"@shuv1337/shuvpi-ai/providers/all": bundledShuvpiAiProviders,
	"@shuv1337/shuvpi-coding-agent": bundledShuvpiCodingAgent,
	"@mariozechner/pi-agent-core": bundledShuvpiAgentCore,
	"@mariozechner/pi-tui": bundledShuvpiTui,
	"@mariozechner/pi-ai": bundledShuvpiAiCompat,
	"@mariozechner/pi-ai/compat": bundledShuvpiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledShuvpiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledShuvpiAiProviders,
	"@mariozechner/pi-coding-agent": bundledShuvpiCodingAgent,
};
