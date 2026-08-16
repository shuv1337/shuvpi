import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedOptions = {
	entryPoints: [join(packageRoot, "vendor", "pi-shuv", "index.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
	sourcemap: false,
	legalComments: "eof",
};
const hostExternals = [
	"@shuv1337/shuvpi-agent-core",
	"@shuv1337/shuvpi-agent-core/*",
	"@shuv1337/shuvpi-ai",
	"@shuv1337/shuvpi-ai/*",
	"@shuv1337/shuvpi-coding-agent",
	"@shuv1337/shuvpi-coding-agent/*",
	"@shuv1337/shuvpi-tui",
	"@shuv1337/shuvpi-tui/*",
];
const sourceHostPaths = new Map([
	["@shuv1337/shuvpi-agent-core", "../../../agent/src/index.ts"],
	["@shuv1337/shuvpi-ai", "../../../ai/src/index.ts"],
	["@shuv1337/shuvpi-ai/compat", "../../../ai/src/compat.ts"],
	["@shuv1337/shuvpi-coding-agent", "../index.ts"],
	["@shuv1337/shuvpi-coding-agent/custom-editor", "../modes/interactive/components/custom-editor.ts"],
	["@shuv1337/shuvpi-tui", "../../../tui/src/index.ts"],
]);

await Promise.all([
	build({
		...sharedOptions,
		outfile: join(packageRoot, "src", "extensions", "shuvpi-shuv.bundle.js"),
		plugins: [{
			name: "source-host-paths",
			setup(build) {
				build.onResolve({ filter: /^@shuv1337\/shuvpi-/ }, (args) => {
					const path = sourceHostPaths.get(args.path);
					if (!path) throw new Error(`Missing source host path for ${args.path}`);
					return { path, external: true };
				});
			},
		}],
	}),
	build({
		...sharedOptions,
		outfile: join(packageRoot, "src", "extensions", "shuvpi-shuv.release.bundle.js"),
		external: hostExternals,
	}),
]);
