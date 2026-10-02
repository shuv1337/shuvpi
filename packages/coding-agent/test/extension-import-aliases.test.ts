import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@shuv1337/shuvpi-agent-core";
import { getProviders } from "@shuv1337/shuvpi-ai/compat";
import { Text } from "@shuv1337/shuvpi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext, ExtensionToolContext } from "../src/core/extensions/types.ts";
import { VIRTUAL_MODULES } from "../src/core/extensions/virtual-modules.ts";

const temporaryDirs: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("host extension import scopes", () => {
	it.each(["@shuv1337/shuvpi", "@mariozechner/pi"])(
		"loads %s APIs and optional factories as shared host instances",
		async (scope) => {
			const directory = mkdtempSync(join(tmpdir(), "shuvpi-import-scope-"));
			temporaryDirs.push(directory);
			const extensionPath = join(directory, "extension.ts");
			const optionalModules = Object.keys(VIRTUAL_MODULES)
				.filter((specifier) => specifier.startsWith(`${scope}-coding-agent/extensions/`))
				.sort();
			writeFileSync(
				extensionPath,
				`
import { Agent } from ${JSON.stringify(`${scope}-agent-core`)};
import { getProviders } from ${JSON.stringify(`${scope}-ai`)};
import { Text } from ${JSON.stringify(`${scope}-tui`)};
import { getAgentDir } from ${JSON.stringify(`${scope}-coding-agent`)};
import { Type } from "typebox";
${optionalModules.map((specifier, index) => `import * as optional${index} from ${JSON.stringify(specifier)};`).join("\n")}
export default function (api) {
  api.events.emit("imports", { Agent, getProviders, Text, getAgentDir, Type, optional: [${optionalModules.map((_, index) => `optional${index}`).join(", ")}] });
  api.registerCommand("scope-proof", { handler: async () => api.events.emit("command", "ran") });
  api.registerTool({ name: "scope_proof", label: "Scope proof", description: "Verify host imports", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "shared host" }], details: {} }) });
}`,
			);
			const eventBus = createEventBus();
			let imported: unknown;
			let commandResult: unknown;
			eventBus.on("imports", (value) => {
				imported = value;
			});
			eventBus.on("command", (value) => {
				commandResult = value;
			});
			const result = await loadExtensions([extensionPath], directory, eventBus);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			const references = imported as Record<string, unknown> & { optional: Record<string, unknown>[] };
			for (const [name, reference] of Object.entries({ Agent, getProviders, Text, getAgentDir, Type })) {
				expect(references[name], name).toBe(reference);
			}
			for (const [index, specifier] of optionalModules.entries()) {
				const host = VIRTUAL_MODULES[specifier] as Record<string, unknown>;
				for (const [name, reference] of Object.entries(host)) {
					expect(references.optional[index][name], `${specifier}#${name}`).toBe(reference);
				}
			}
			const extension = result.extensions[0];
			await extension.commands.get("scope-proof")!.handler("", {} as ExtensionCommandContext);
			expect(commandResult).toBe("ran");
			const toolResult = await extension.tools
				.get("scope_proof")!
				.definition.execute("scope-proof", {}, undefined, undefined, {} as ExtensionToolContext);
			expect(toolResult.content).toEqual([{ type: "text", text: "shared host" }]);
		},
	);

	it("maps all extension exports and omits upstream-scope aliases", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, unknown>;
		};
		const subpaths = Object.keys(pkg.exports).filter((key) => key.startsWith("./extensions/"));
		for (const subpath of subpaths) {
			const canonical = `@shuv1337/shuvpi-coding-agent${subpath.slice(1)}`;
			const existing = `@mariozechner/pi-coding-agent${subpath.slice(1)}`;
			expect(VIRTUAL_MODULES[canonical], canonical).toBeDefined();
			expect(VIRTUAL_MODULES[existing], existing).toBe(VIRTUAL_MODULES[canonical]);
		}
		expect(Object.keys(VIRTUAL_MODULES).some((specifier) => specifier.startsWith("@earendil-works/"))).toBe(false);
	});
});
