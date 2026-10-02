import { resolve } from "node:path";
import { Type } from "typebox";
import { type BackgroundJob, BackgroundJobManager } from "../../core/background-jobs/manager.ts";
import { JobOutputView } from "../../core/background-jobs/view.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";

/** Core registration is supplied by the distribution; each extension instance owns one session's processes. */
export function createBackgroundJobsExtension(): ExtensionFactory {
	return (pi) => {
		let manager: BackgroundJobManager | undefined;
		let sessionId: string | undefined;
		let epoch = 0;
		const delivered = new Set<string>();
		const starts = new Map<string, string | null>();
		const current = (ctx: ExtensionContext) => {
			if (manager && sessionId !== ctx.sessionManager.getSessionId())
				throw new Error("Background manager belongs to a different session");
			if (!manager) {
				manager = new BackgroundJobManager();
				sessionId = ctx.sessionManager.getSessionId();
				const active = manager;
				const generation = epoch;
				active.onSettled((job) => {
					if (generation !== epoch || sessionId !== ctx.sessionManager.getSessionId() || delivered.has(job.id))
						return;
					const origin = starts.get(job.id);
					if (origin && !ctx.sessionManager.getBranch().some((entry) => entry.id === origin)) return;
					delivered.add(job.id);
					pi.sendMessage(
						{
							customType: "background-job-result",
							content: `Background ${job.title}: ${job.status}\n${job.stdout}${job.stderr ? `\n${job.stderr}` : ""}`,
							display: true,
							details: job,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				});
				active.subscribe(() => {
					if (generation === epoch) {
						const running = active.list().filter((job) => job.status === "running").length;
						ctx.ui.setStatus("background-jobs", running ? `background: ${running}` : undefined);
					}
				});
			}
			return manager;
		};
		const stop = async () => {
			epoch++;
			const old = manager;
			manager = undefined;
			sessionId = undefined;
			starts.clear();
			delivered.clear();
			await old?.close();
		};
		pi.on("session_shutdown", stop);
		pi.on("session_start", async (_event, ctx) => {
			if (sessionId && sessionId !== ctx.sessionManager.getSessionId()) await stop();
			ctx.ui.setStatus("background-jobs", undefined);
		});
		const result = (value: BackgroundJob | BackgroundJob[]) => ({
			content: [{ type: "text" as const, text: JSON.stringify(value) }],
			details: value,
		});
		pi.registerTool({
			name: "bg_start",
			label: "Start background job",
			description: "Run a shell command without stdin. Up to eight jobs; jobs end when this session closes.",
			parameters: Type.Object({
				command: Type.String(),
				title: Type.Optional(Type.String()),
				working_dir: Type.Optional(Type.String()),
			}),
			execute: async (_id, args, _signal, _update, ctx) => {
				const job = current(ctx).start(args.command, resolve(ctx.cwd, args.working_dir ?? "."), args.title);
				starts.set(job.id, ctx.sessionManager.getLeafId());
				return result(job);
			},
		});
		pi.registerTool({
			name: "bg_status",
			label: "Background status",
			description: "Get status and bounded stdout/stderr for one background job.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, args, _signal, _update, ctx) => result(current(ctx).get(args.id)),
		});
		pi.registerTool({
			name: "bg_list",
			label: "List background jobs",
			description: "List this session's background jobs.",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, _update, ctx) => result(current(ctx).list()),
		});
		pi.registerTool({
			name: "bg_wait",
			label: "Wait for background job",
			description: "Wait for a background job. Cancelling the wait leaves the job running.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, args, signal, _update, ctx) => result(await current(ctx).wait(args.id, signal)),
		});
		pi.registerTool({
			name: "bg_kill",
			label: "Stop background job",
			description: "Stop a background job and its process group.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, args, _signal, _update, ctx) => result(await current(ctx).kill(args.id)),
		});
		pi.registerCommand("ps", {
			description: "View or stop background jobs",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("/ps requires interactive mode", "warning");
					return;
				}
				const active = current(ctx);
				while (true) {
					const jobs = active.list();
					if (!jobs.length) {
						ctx.ui.notify("No background jobs", "info");
						return;
					}
					const choices = jobs.map((job) => `${job.id.slice(0, 8)}  ${job.status}  ${job.title}`);
					const selected = await ctx.ui.select("Background jobs", choices);
					if (!selected) return;
					const job = jobs[choices.indexOf(selected)];
					if (!job) continue;
					const action = await ctx.ui.select(job.title, ["Output", "Stop", "Back"]);
					if (action === "Stop") await active.kill(job.id);
					if (action === "Output") {
						let detach: (() => void) | undefined;
						try {
							await ctx.ui.custom<void>(
								(tui, _theme, keys, done) => {
									detach = active.subscribe(() => tui.requestRender());
									return new JobOutputView(
										() => {
											const live = active.get(job.id);
											return `${live.title} — ${live.status}\n${live.stdout}\n${live.stderr}`;
										},
										() => tui.terminal.rows,
										keys,
										() => done(undefined),
										() => tui.requestRender(),
									);
								},
								{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
							);
						} finally {
							detach?.();
						}
					}
				}
			},
		});
	};
}

export default createBackgroundJobsExtension();
