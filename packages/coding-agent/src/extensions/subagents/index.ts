import { resolve } from "node:path";
import { Type } from "typebox";
import { JobOutputView } from "../../core/background-jobs/view.ts";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { createCodexSubagentBackend } from "../../core/subagents/codex.ts";
import { SubagentManager } from "../../core/subagents/manager.ts";
import { createPiSubagentBackend } from "../../core/subagents/pi.ts";
import type { SubagentBackend, SubagentSnapshot } from "../../core/subagents/types.ts";

export interface SubagentsExtensionOptions {
	backends?: readonly SubagentBackend[];
}
export function createSubagentsExtension(options: SubagentsExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		let manager: SubagentManager | undefined;
		let sessionId: string | undefined;
		let epoch = 0;
		const delivered = new Set<string>();
		const current = (ctx: ExtensionContext) => {
			if (manager && sessionId !== ctx.sessionManager.getSessionId())
				throw new Error("Subagents belong to a different session");
			if (!manager) {
				manager = new SubagentManager(
					options.backends ?? [createPiSubagentBackend(), createCodexSubagentBackend()],
				);
				sessionId = ctx.sessionManager.getSessionId();
				const active = manager;
				const generation = epoch;
				active.onSettled((child) => {
					const key = `${child.id}:${child.run}`;
					if (generation !== epoch || sessionId !== ctx.sessionManager.getSessionId() || delivered.has(key))
						return;
					if (
						child.originEntryId &&
						!ctx.sessionManager.getBranch().some((entry) => entry.id === child.originEntryId)
					)
						return;
					delivered.add(key);
					pi.sendMessage(
						{
							customType: "subagent-result",
							content: `Subagent ${child.title}: ${child.status}\n${child.output}${child.error ? `\n${child.error}` : ""}`,
							display: true,
							details: child,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				});
				active.subscribe(() => {
					if (generation === epoch) {
						const count = active.list().filter((child) => child.status === "running").length;
						ctx.ui.setStatus("subagents", count ? `subagents: ${count}` : undefined);
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
			delivered.clear();
			await old?.close();
		};
		pi.on("session_shutdown", stop);
		pi.on("session_start", async (_event, ctx) => {
			if (sessionId && sessionId !== ctx.sessionManager.getSessionId()) await stop();
			ctx.ui.setStatus("subagents", undefined);
		});
		const result = (value: SubagentSnapshot | SubagentSnapshot[]) => ({
			content: [{ type: "text" as const, text: JSON.stringify(value) }],
			details: value,
		});
		pi.registerTool({
			name: "subagent_spawn",
			label: "Spawn subagent",
			description:
				"Start an isolated child session. At most four children run at once; children close with this session.",
			parameters: Type.Object({
				prompt: Type.String(),
				title: Type.Optional(Type.String()),
				backend: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude"), Type.Literal("codex")])),
				working_dir: Type.Optional(Type.String()),
				model: Type.Optional(Type.String()),
				effort: Type.Optional(
					Type.Union([
						Type.Literal("off"),
						Type.Literal("minimal"),
						Type.Literal("low"),
						Type.Literal("medium"),
						Type.Literal("high"),
						Type.Literal("xhigh"),
						Type.Literal("max"),
						Type.Literal("ultra"),
					]),
				),
			}),
			execute: async (_id, args, _signal, _update, ctx) =>
				result(
					await current(ctx).spawn(args.backend ?? "pi", {
						prompt: args.prompt,
						title: args.title ?? args.prompt.slice(0, 80),
						cwd: resolve(ctx.cwd, args.working_dir ?? "."),
						model: args.model,
						effort: args.effort,
						parent: ctx,
					}),
				),
		});
		pi.registerTool({
			name: "subagent_check",
			label: "Check subagent",
			description: "Read a child's status and transcript.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, args, _signal, _update, ctx) => result(current(ctx).get(args.id)),
		});
		pi.registerTool({
			name: "subagent_list",
			label: "List subagents",
			description: "List this session's children.",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, _update, ctx) => result(current(ctx).list()),
		});
		pi.registerTool({
			name: "subagent_wait",
			label: "Wait for subagent",
			description: "Wait for a child. Cancelling the wait leaves the child running.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, args, signal, _update, ctx) => result(await current(ctx).wait(args.id, signal)),
		});
		pi.registerTool({
			name: "subagent_cancel",
			label: "Cancel subagent",
			description: "Stop a child's active turn.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, args, _signal, _update, ctx) => result(await current(ctx).cancel(args.id)),
		});
		pi.registerCommand("subagents", {
			description: "Inspect, steer or stop child sessions",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("/subagents requires interactive mode", "warning");
					return;
				}
				const active = current(ctx);
				while (true) {
					const children = active.list();
					if (!children.length) {
						ctx.ui.notify("No subagents", "info");
						return;
					}
					const choices = children.map((child) => `${child.id.slice(0, 8)}  ${child.status}  ${child.title}`);
					const selected = await ctx.ui.select("Subagents", choices);
					if (!selected) return;
					const child = children[choices.indexOf(selected)];
					if (!child) continue;
					const action = await ctx.ui.select(child.title, ["Transcript", "Send message", "Cancel", "Back"]);
					if (action === "Cancel") await active.cancel(child.id);
					if (action === "Send message") {
						const prompt = await ctx.ui.input("Message to subagent");
						if (prompt?.trim()) {
							try {
								await active.send(child.id, prompt);
							} catch (error) {
								ctx.ui.notify(String(error), "error");
							}
						}
					}
					if (action === "Transcript") {
						let detach: (() => void) | undefined;
						try {
							await ctx.ui.custom<void>(
								(tui, _theme, keys, done) => {
									detach = active.subscribe(() => tui.requestRender());
									return new JobOutputView(
										() => {
											const live = active.get(child.id);
											return `${live.title} — ${live.status}\n${live.transcript.map((message) => `${message.role}: ${message.text}`).join("\n\n")}${live.status === "running" ? `\nassistant: ${live.output}` : ""}`;
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
export default createSubagentsExtension();
