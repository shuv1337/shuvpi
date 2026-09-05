// highlight.js 10.x ships types for "highlight.js" and "highlight.js/lib/core[.js]",
// but not for the ".js"-suffixed language subpaths or "highlight.js/lib/index.js"
// this package imports under Node16 resolution. Bridge those to the real types so
// registerLanguage() sees compatible LanguageFn values.
declare module "highlight.js/lib/index.js" {
	import type { HLJSApi } from "highlight.js";
	const hljs: HLJSApi;
	export default hljs;
}

declare module "highlight.js/lib/languages/*.js" {
	import type { LanguageFn } from "highlight.js";
	const language: LanguageFn;
	export default language;
}
