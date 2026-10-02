import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

/**
 * Exact matches for bare specifiers, plus one rule per package for subpath exports such as
 * `@shuv1337/shuvpi-ai/utils/uuid`. A prefix alias would rewrite those onto `index.ts/utils/uuid`.
 */
export default mergeConfig(baseConfig, defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		conditions: ["source"],
	},
	ssr: { resolve: { conditions: ["source"] } },
}));
