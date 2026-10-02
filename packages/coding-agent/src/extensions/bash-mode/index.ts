import { truncateToWidth } from "@shuv1337/shuvpi-tui";
import type { EditorFactory, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { BashCompletionEngine, getOneOffBashCommandContext } from "./completion.ts";
import { BashModeEditor } from "./editor.ts";
import { appendProjectHistory, matchHistoryEntries, readGlobalShellHistory, readProjectHistory } from "./history.ts";
import { ManagedShellSession } from "./shell-session.ts";
import { BashTranscriptStore } from "./transcript.ts";

export interface BashModeOptions {
	shellPath?: string;
	agentDir?: string;
	/** Override shell history location; null disables the optional global history source. */
	historyPath?: string | null;
	environment?: NodeJS.ProcessEnv;
	transcriptMaxLines?: number;
	transcriptMaxBytes?: number;
}

export function createBashModeExtension(options: BashModeOptions = {}): ExtensionFactory {
	return (pi) => {
		const shellPath = options.shellPath ?? process.env.SHELL ?? "/bin/sh";
		const transcript = new BashTranscriptStore(options.transcriptMaxLines, options.transcriptMaxBytes);
		const completion = new BashCompletionEngine(options.agentDir, options.historyPath);
		let ctx: ExtensionContext | undefined;
		let shell: ManagedShellSession | undefined;
		let editor: BashModeEditor | undefined;
		let active = false;
		let factory: EditorFactory | undefined;
		let render: (() => void) | undefined;
		let revision = 0;

		const changed = () => {
			if (!ctx) return;
			ctx.ui.setStatus(
				"bash-mode",
				active ? `shell ${shell?.state.running ? "running" : "ready"} · ${shell?.state.cwd ?? ctx.cwd}` : undefined,
			);
			render?.();
		};
		const ensureShell = async () => {
			if (!ctx) throw new Error("Bash mode requires an interactive session");
			if (!shell) {
				const project = ctx.cwd;
				shell = new ManagedShellSession(
					shellPath,
					project,
					transcript,
					changed,
					(command, cwd) => appendProjectHistory(project, command, cwd, options.agentDir),
					options.environment,
				);
			}
			await shell.ensureReady();
			return shell;
		};
		const setActive = async (value: boolean) => {
			if (!ctx || !factory || ctx.ui.getEditorComponent() !== factory) {
				ctx?.ui.notify("Bash mode requires its editor; another custom editor is active", "warning");
				return;
			}
			if (!value && shell?.state.running) {
				ctx.ui.notify("Interrupt or finish the running shell command first", "warning");
				return;
			}
			const request = ++revision;
			try {
				if (value) await ensureShell();
				if (request !== revision || !ctx) return;
				active = value;
				editor?.resetMode();
				changed();
			} catch (error) {
				ctx?.ui.notify(`Could not start shell: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		};
		const cleanup = async () => {
			revision++;
			const previous = ctx;
			ctx = undefined;
			active = false;
			editor?.dispose();
			editor = undefined;
			if (factory && previous?.ui.getEditorComponent() === factory) previous.ui.setEditorComponent(undefined);
			previous?.ui.setWidget("bash-mode", undefined);
			previous?.ui.setStatus("bash-mode", undefined);
			factory = undefined;
			render = undefined;
			const previousShell = shell;
			shell = undefined;
			await previousShell?.dispose();
			transcript.clear();
		};
		pi.on("session_start", async (_event, context) => {
			await cleanup();
			if (!context.hasUI) return;
			ctx = context;
			if (ctx.ui.getEditorComponent()) {
				ctx.ui.notify("Bash mode could not install because another custom editor is active", "warning");
				return;
			}
			factory = (tui, theme, keys) => {
				editor?.dispose();
				editor = new BashModeEditor(tui, theme, keys, {
					active: () => active,
					running: () => shell?.state.running ?? false,
					toggle: () => void setActive(!active),
					exit: () => void setActive(false),
					interrupt: () => shell?.interrupt(),
					notify: (message) => ctx?.ui.notify(message, "warning"),
					submit: (command) => {
						void ensureShell()
							.then((session) => session.runCommand(command))
							.catch((error: unknown) => {
								ctx?.ui.notify(
									`Shell command failed: ${error instanceof Error ? error.message : String(error)}`,
									"error",
								);
							});
					},
					history: (prefix) =>
						matchHistoryEntries(
							[
								...readProjectHistory(context.cwd, options.agentDir).map((entry) => entry.command),
								...readGlobalShellHistory(shellPath, options.historyPath),
							],
							prefix,
							100,
						),
					ghost: async (text, signal) => {
						const bang = active ? null : getOneOffBashCommandContext(text);
						const ghost = await completion.getGhostSuggestion(
							bang?.command ?? text,
							active ? (shell?.state.cwd ?? context.cwd) : context.cwd,
							shellPath,
							signal,
							context.cwd,
						);
						return ghost && bang ? { ...ghost, value: `${bang.prefix}${ghost.value}` } : ghost;
					},
				});
				return editor;
			};
			ctx.ui.setEditorComponent(factory);
			ctx.ui.setWidget("bash-mode", (tui, theme) => {
				render = () => tui.requestRender();
				return {
					invalidate() {},
					render(width) {
						if (!active || width <= 0) return [];
						const lines = transcript
							.getSnapshot()
							.flatMap((entry) => [
								theme.fg(
									entry.exitCode === null ? "accent" : entry.exitCode === 0 ? "success" : "error",
									`$ ${entry.command.replaceAll("\n", " ↵ ")}`,
								),
								...(entry.truncated ? [theme.fg("dim", "Earlier output truncated")] : []),
								...entry.output.split("\n"),
							]);
						const limit = Math.max(2, Math.min(12, Math.floor(tui.terminal.rows / 3)));
						return lines.slice(-limit).map((line) => truncateToWidth(line, width));
					},
				};
			});
		});
		pi.on("session_shutdown", cleanup);
		pi.registerCommand("bash-mode", {
			description: "Toggle sticky shell mode (on, off, toggle)",
			handler: async (args, context) => {
				if (!context.hasUI) throw new Error("Bash mode requires an interactive session");
				const mode = args.trim().toLowerCase() || "toggle";
				if (!["on", "off", "toggle"].includes(mode)) {
					context.ui.notify("Usage: /bash-mode [on|off|toggle]", "warning");
					return;
				}
				await setActive(mode === "toggle" ? !active : mode === "on");
			},
		});
		pi.registerCommand("bash-reset", {
			description: "Reset the managed shell and its transcript",
			handler: async (_args, context) => {
				if (!context.hasUI) throw new Error("Bash mode requires an interactive session");
				revision++;
				const previous = shell;
				shell = undefined;
				await previous?.dispose();
				transcript.clear();
				if (active) await ensureShell();
				editor?.resetMode();
				changed();
			},
		});
	};
}
