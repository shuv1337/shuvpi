import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolUpdateCallback } from "@shuv1337/shuvpi-agent-core";
import type { KeybindingsManager } from "@shuv1337/shuvpi-tui";
import { type Component, Markdown, truncateToWidth } from "@shuv1337/shuvpi-tui";
import { Type } from "typebox";
import { getAgentDir, getCliProcessInvocation } from "../../config.ts";
import { workflowOwnerClient } from "../../core/durable-workflows/client.ts";
import {
	connectDurableWorkflows,
	DurableWorkflowConnection,
	drainWorkflowReceipts,
} from "../../core/durable-workflows/connection.ts";
import {
	isWorkflowJsonObject,
	isWorkflowJsonValue,
	type WorkflowJsonValue,
} from "../../core/durable-workflows/protocol.ts";
import {
	captureWorkflowReceiptDestination,
	type WorkflowReceiptReadSession,
	type WorkflowReceiptSession,
} from "../../core/durable-workflows/receipt.ts";
import type { ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";

const WorkflowSchema = Type.Object(
	{
		script: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
		args: Type.Optional(Type.Unknown()),
		background: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

interface WorkflowDetails {
	runId: string;
	status: string;
	journal?: WorkflowJsonValue;
	result?: WorkflowJsonValue;
	error?: string;
}

interface WorkflowDashboardOptions {
	text: string;
	refresh?: () => Promise<WorkflowJsonValue>;
	tui: { terminal: { rows: number }; requestRender(): void };
	theme: Theme;
	keys: KeybindingsManager;
	done(): void;
}

class WorkflowDashboard implements Component {
	private markdown: Markdown;
	private readonly tui: WorkflowDashboardOptions["tui"];
	private readonly theme: WorkflowDashboardOptions["theme"];
	private readonly keys: KeybindingsManager;
	private readonly done: () => void;
	private readonly refresh?: () => Promise<WorkflowJsonValue>;
	private scroll = 0;
	private width = -1;
	private lines: string[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private text: string;

	constructor(options: WorkflowDashboardOptions) {
		this.markdown = new Markdown(options.text, 1, 0, getMarkdownTheme());
		this.text = options.text;
		this.refresh = options.refresh;
		this.tui = options.tui;
		this.theme = options.theme;
		this.keys = options.keys;
		this.done = options.done;
		if (this.refresh) this.timer = setTimeout(() => void this.refreshSnapshot(), 1000);
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "app.head.close")) {
			this.dispose();
			this.done();
		} else if (this.keys.matches(data, "app.head.down")) this.scroll++;
		else if (this.keys.matches(data, "app.head.up")) this.scroll--;
		else if (this.keys.matches(data, "app.head.pageDown")) this.scroll += this.pageSize();
		else if (this.keys.matches(data, "app.head.pageUp")) this.scroll -= this.pageSize();
		else if (this.keys.matches(data, "app.head.top")) this.scroll = 0;
		else if (this.keys.matches(data, "app.head.bottom")) this.scroll = this.lines.length;
		else return;
		this.clamp();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0 || this.tui.terminal.rows <= 0) return [];
		if (this.width !== width) {
			this.lines = this.markdown.render(width);
			this.width = width;
		}
		this.clamp();
		const page = this.pageSize();
		const visible = this.lines.slice(this.scroll, this.scroll + page);
		while (visible.length < page) visible.push("");
		const hint = this.keys.getKeys("app.head.close").join("/");
		return [this.theme.fg("accent", "Workflow runs"), ...visible, this.theme.fg("dim", `${hint} close`)]
			.slice(0, this.tui.terminal.rows)
			.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.width = -1;
		this.markdown.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
	}

	private async refreshSnapshot(): Promise<void> {
		if (this.disposed || !this.refresh) return;
		try {
			const next = formatDashboardText(await this.refresh());
			if (this.disposed) return;
			if (next !== this.text) {
				this.text = next;
				this.markdown = new Markdown(next, 1, 0, getMarkdownTheme());
				this.width = -1;
				this.tui.requestRender();
			}
		} catch {
			// Keep the last verified snapshot visible if the owner disconnects during rendering.
		}
		if (!this.disposed) this.timer = setTimeout(() => void this.refreshSnapshot(), 1000);
	}

	private pageSize(): number {
		return Math.max(0, this.tui.terminal.rows - 2);
	}
	private clamp(): void {
		this.scroll = Math.max(0, Math.min(this.scroll, this.lines.length - this.pageSize()));
	}
}

function pathsForSession(ctx: ExtensionContext): { socketPath: string; database: string } {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Durable workflows require a persisted chat");
	const digest = createHash("sha256").update(realpathSync(sessionFile)).digest("hex").slice(0, 32);
	const directory = join(getAgentDir(), "workflows", digest);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	return { socketPath: join(directory, "owner.sock"), database: join(directory, "workflow.sqlite") };
}

async function connect(ctx: ExtensionContext): Promise<DurableWorkflowConnection> {
	const { socketPath, database } = pathsForSession(ctx);
	const executable = getCliProcessInvocation();
	return connectDurableWorkflows(socketPath, {
		command: executable.command,
		args: [
			...executable.args,
			"--durable-workflow-owner",
			socketPath,
			database,
			ctx.sessionManager.getCwd(),
			ctx.isProjectTrusted() ? "trusted" : "untrusted",
		],
		cwd: ctx.sessionManager.getCwd(),
	});
}

function workflowToolSelection(pi: { getActiveTools(): string[]; getToolCallHandlerExtensions(): string[] }): string[] {
	// The owner replaces tool_search with codemode and does not expose UI-only controls to detached child agents.
	const ownerOnly = new Set([
		"workflow",
		"tool_search",
		"ask_user",
		"bg_start",
		"bg_status",
		"bg_list",
		"bg_wait",
		"bg_kill",
	]);
	const selected = pi.getActiveTools().filter((name) => !ownerOnly.has(name));
	// The detached owner implements the built-in MCP policy itself: it loads only the
	// captured trusted config, checks config compatibility before calls, and owns transports.
	// Other interactive hooks have no durable equivalent and must remain fail-closed.
	const interactiveHooks = pi.getToolCallHandlerExtensions().filter((path) => path !== "builtin:mcp");
	if (interactiveHooks.length > 0 && selected.length > 0) {
		throw new Error(
			`Durable workflows cannot start with active tools ${selected.join(", ")} because interactive tool_call hooks are not inherited (${interactiveHooks.join(", ")}). Disable those extensions or remove the active tools.`,
		);
	}
	return selected;
}

function receiptReadSession(ctx: ExtensionContext): WorkflowReceiptReadSession {
	const session = ctx.sessionManager;
	return {
		isPersisted: () => Boolean(session.getSessionFile()),
		getSessionFile: () => session.getSessionFile(),
		getSessionId: () => session.getSessionId(),
		getLeafId: () => session.getLeafId(),
		getEntries: () => session.getEntries(),
	};
}

function receiptSession(ctx: ExtensionContext): WorkflowReceiptSession {
	const append = ctx.appendCustomMessageEntry;
	if (!append) throw new Error("This session does not support durable transcript messages");
	return {
		...receiptReadSession(ctx),
		appendCustomMessageEntry: (customType, content, display, details) =>
			append(customType, content, display, details),
	};
}

function parseArchive(value: WorkflowJsonValue): WorkflowDetails {
	if (!isWorkflowJsonObject(value) || typeof value.runId !== "string" || typeof value.status !== "string")
		throw new Error("Workflow owner returned an invalid run archive");
	return {
		runId: value.runId,
		status: value.status,
		...(isWorkflowJsonValue(value.result) ? { result: value.result } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(isWorkflowJsonValue(value.journal) ? { journal: value.journal } : {}),
	};
}

function formatDashboardText(value: WorkflowJsonValue): string {
	const archives = Array.isArray(value) ? value.map((item) => parseArchive(item)) : [parseArchive(value)];
	return archives.length
		? archives
				.map((archive) => {
					const lines = [`## ${archive.runId} — ${archive.status}`];
					if (archive.error) lines.push(`Error: ${archive.error}`);
					if (archive.result !== undefined && archive.result !== null)
						lines.push("```json", JSON.stringify(archive.result, null, 2), "```");
					if (isWorkflowJsonObject(archive.journal)) {
						const journal = archive.journal;
						if (Array.isArray(journal.operations)) {
							for (const operation of journal.operations) {
								if (!isWorkflowJsonObject(operation)) continue;
								lines.push(
									`- operation ${String(operation.index)}: ${String(operation.kind)} — ${String(operation.status)}`,
								);
								if (operation.result !== null && isWorkflowJsonValue(operation.result))
									lines.push("```json", JSON.stringify(operation.result, null, 2), "```");
							}
						}
					}
					return lines.join("\n");
				})
				.join("\n\n")
		: "No workflow runs yet.";
}

function showDashboard(
	ctx: ExtensionCommandContext,
	value: WorkflowJsonValue,
	refresh?: () => Promise<WorkflowJsonValue>,
): Promise<void> {
	const text = formatDashboardText(value);
	return ctx.ui.custom<void>(
		(tui, theme, keys, done) =>
			new WorkflowDashboard({ text, refresh, tui, theme, keys, done: () => done(undefined) }),
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
	);
}

function statusOf(value: WorkflowJsonValue): string {
	return parseArchive(value).status;
}

function resultText(value: WorkflowJsonValue): string {
	const archive = parseArchive(value);
	return JSON.stringify({
		runId: archive.runId,
		status: archive.status,
		result: archive.result ?? null,
		error: archive.error ?? null,
	});
}

async function awaitForeground(
	connection: DurableWorkflowConnection,
	runId: string,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WorkflowDetails> | undefined,
): Promise<WorkflowJsonValue> {
	let lastProgress = "";
	for (;;) {
		signal?.throwIfAborted();
		const value = await connection.status(runId);
		const archive = parseArchive(value);
		if (isWorkflowJsonObject(archive.journal) && Array.isArray(archive.journal.operations)) {
			const progress = `${archive.status}: ${archive.journal.operations.length} operation(s)`;
			if (progress !== lastProgress) {
				lastProgress = progress;
				onUpdate?.({ content: [{ type: "text", text: progress }], details: { runId, status: archive.status } });
			}
		}
		if (archive.status !== "running") return value;
		await delay(500, undefined, signal ? { signal } : undefined);
	}
}

/** Model-callable, durable workflow tool plus an explicit command for inspecting and managing runs. */
export function createWorkflowExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "workflow",
			label: "workflow",
			description:
				"Run a replayable JavaScript workflow. The script body receives `args`, `agent(prompt, options?)`, and `phase(label)`; return JSON. Use `background: true` for a detached run, otherwise wait for the result.",
			promptSnippet: "Run durable parallel or background agent workflows with replay-safe results.",
			parameters: WorkflowSchema,
			executionMode: "parallel",
			async execute(_id, params, signal, onUpdate, ctx) {
				const inputArgs = params.args;
				if (inputArgs !== undefined && !isWorkflowJsonValue(inputArgs))
					return { content: [{ type: "text", text: "Workflow args must be JSON." }], details: {}, isError: true };
				const tools = workflowToolSelection(pi);
				const workflowArgs: WorkflowJsonValue = inputArgs ?? null;
				const destination = captureWorkflowReceiptDestination(receiptReadSession(ctx));
				const connection = await connect(ctx);
				const route = params.background === true ? "background" : "foreground";
				const started = await connection.start({
					input: {
						source: params.script,
						args: workflowArgs,
						agent: {
							...(ctx.model === undefined
								? {}
								: { model: { provider: ctx.model.provider, modelId: ctx.model.id } }),
							...(ctx.thinkingLevel === undefined ? {} : { effort: ctx.thinkingLevel }),
							tools,
						},
					},
					destination,
					route,
				});
				if (route === "background") {
					return {
						content: [
							{
								type: "text",
								text: `Started background workflow ${started.runId}. Use /workflow status ${started.runId} to inspect it.`,
							},
						],
						details: { runId: started.runId, status: "running" },
					};
				}
				try {
					const value = await awaitForeground(connection, started.runId, signal, onUpdate);
					await drainWorkflowReceipts(connection, receiptSession(ctx));
					const archive = parseArchive(value);
					return {
						content: [{ type: "text", text: resultText(value) }],
						details: archive,
						...(archive.status === "failed" ? { isError: true } : {}),
					};
				} catch (error) {
					if (signal?.aborted) await connection.cancel(started.runId).catch(() => {});
					throw error;
				}
			},
		});

		pi.registerCommand("workflow", {
			description: "Start or inspect durable agent workflows",
			handler: async (raw, ctx) => {
				const trimmed = raw.trim();
				const [action, ...rest] = trimmed ? trimmed.split(/\s+/u) : [];
				const args = trimmed.slice(action?.length ?? 0).trim();
				if (action === "run") {
					const background = args.startsWith("background ");
					const script = background ? args.slice("background ".length) : args;
					if (!script) {
						ctx.ui.notify("Usage: /workflow run [background] <JavaScript>", "warning");
						return;
					}
					try {
						const tools = workflowToolSelection(pi);
						const destination = captureWorkflowReceiptDestination(receiptReadSession(ctx));
						const connection = await connect(ctx);
						const started = await connection.start({
							input: {
								source: script,
								args: null,
								agent: {
									...(ctx.model === undefined
										? {}
										: { model: { provider: ctx.model.provider, modelId: ctx.model.id } }),
									...(ctx.thinkingLevel === undefined ? {} : { effort: ctx.thinkingLevel }),
									tools,
								},
							},
							destination,
							route: background ? "background" : "foreground",
						});
						if (background) ctx.ui.notify(`Started ${started.runId}`, "info");
						else {
							const result = await awaitForeground(connection, started.runId, undefined, undefined);
							await drainWorkflowReceipts(connection, receiptSession(ctx));
							ctx.ui.notify(resultText(result), statusOf(result) === "completed" ? "info" : "error");
							await showDashboard(ctx, result);
						}
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				if (action === "list" || action === undefined || action === "dashboard") {
					try {
						const connection = await connect(ctx);
						const value = await connection.list();
						if (!ctx.hasUI) ctx.ui.notify(JSON.stringify(value), "info");
						else await showDashboard(ctx, value, () => connection.list());
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				if (action === "status" || action === "cancel") {
					const runId = rest[0];
					if (!runId) {
						ctx.ui.notify(`Usage: /workflow ${action} workflow-<id>`, "warning");
						return;
					}
					try {
						const connection = await connect(ctx);
						const value = action === "cancel" ? await connection.cancel(runId) : await connection.status(runId);
						if (action === "cancel") ctx.ui.notify(`Cancelled ${runId}`, "info");
						await showDashboard(ctx, value, () => connection.status(runId));
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				if (action === "drain") {
					try {
						const result = await drainWorkflowReceipts(await connect(ctx), receiptSession(ctx));
						ctx.ui.notify(
							`Saved ${result.persisted} result(s); ${result.pending} remain pending.`,
							result.pending ? "warning" : "info",
						);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				ctx.ui.notify("Usage: /workflow [run|list|status|cancel|drain]", "warning");
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return;
			let stopped = false;
			const poll = async (): Promise<void> => {
				if (stopped) return;
				try {
					const { socketPath } = pathsForSession(ctx);
					const result = await drainWorkflowReceipts(
						new DurableWorkflowConnection(workflowOwnerClient(socketPath)),
						receiptSession(ctx),
					);
					if (result.persisted > 0)
						ctx.ui.notify(`Saved ${result.persisted} background workflow result(s).`, "info");
				} catch {
					// There may be no owner yet, or this branch may not be the captured destination.
				}
				if (!stopped) pollTimer = setTimeout(() => void poll(), 5000);
			};
			void poll();
			shutdown = () => {
				stopped = true;
				if (pollTimer) clearTimeout(pollTimer);
			};
		});
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let shutdown: (() => void) | undefined;
		pi.on("session_shutdown", () => shutdown?.());
	};
}

export default createWorkflowExtension;
