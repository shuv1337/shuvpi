import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import shuvpiShuv from "./shuvpi-shuv.bundle.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "shuv", factory: shuvpiShuv, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
