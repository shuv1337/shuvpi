export interface BashCommandRecord {
	id: string;
	command: string;
	cwdAtStart: string;
	output: string;
	exitCode: number | null;
	truncated: boolean;
}

export interface ShellSessionState {
	ready: boolean;
	running: boolean;
	shellPath: string;
	cwd: string;
	lastExitCode: number | null;
}

export interface GhostSuggestion {
	value: string;
	source: "project-history" | "global-history" | "git" | "path" | "executable";
}

export interface ExtendedCompletionItem {
	value: string;
	label: string;
	description?: string;
	replacement: string;
	startCol: number;
	endCol: number;
	source: GhostSuggestion["source"];
	score: number;
}
