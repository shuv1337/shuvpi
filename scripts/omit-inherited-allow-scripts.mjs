// npm 12 treats env-sourced allow-scripts as a CLI policy and rejects project
// installs with EALLOWSCRIPTS. `npm run` copies ~/.npmrc allow-scripts into
// npm_config_allow_scripts, so drop that variable and let the child read
// persistent config itself. Other npm_config_* values stay.
export function omitInheritedAllowScripts(env = process.env) {
	const childEnv = { ...env };
	for (const key of Object.keys(childEnv)) {
		if (key.toLowerCase() === "npm_config_allow_scripts") {
			delete childEnv[key];
		}
	}
	return childEnv;
}
