export interface RuntimeCliOptions {
	socketPath: string;
	showHelp: boolean;
	showVersion: boolean;
}

export function parseRuntimeArguments(arguments_: string[]): RuntimeCliOptions {
	let socketPath = "";
	let showHelp = false;
	let showVersion = false;

	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index];
		switch (argument) {
			case "--socket":
				socketPath = arguments_[++index] ?? "";
				if (!socketPath) {
					throw new Error("--socket requires a path");
				}
				break;
			case "--help":
			case "-h":
				showHelp = true;
				break;
			case "--version":
			case "-v":
				showVersion = true;
				break;
			default:
				throw new Error(`unknown argument: ${argument}`);
		}
	}

	if (!socketPath && !showHelp && !showVersion) {
		throw new Error("--socket is required");
	}
	return { socketPath, showHelp, showVersion };
}
