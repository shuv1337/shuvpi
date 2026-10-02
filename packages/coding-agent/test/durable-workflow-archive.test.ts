import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@shuv1337/shuvpi-ai";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import { createRegistry, defineExtension, Harness } from "@shuv1337/shuvpi-durable";
import { openNodeSqliteStorage } from "@shuv1337/shuvpi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import {
	acknowledgeWorkflowReceipt,
	archiveWorkflowSettlement,
	blockWorkflowReceipt,
	createWorkflowTaskOnce,
	queueWorkflowReceipt,
	retryWorkflowReceipt,
	WorkflowRunArchiveDoc,
} from "../src/core/durable-workflows/archive.ts";
import type { WorkflowJournalState } from "../src/core/durable-workflows/journal.ts";
import { workflowReceiptDigest } from "../src/core/durable-workflows/receipt.ts";
import { createWorkflowTask } from "../src/core/durable-workflows/runner.ts";

const directories: string[] = [];
const harnesses: Harness[] = [];

describe("durable workflow archive", () => {
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT);
		for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
	});

	it("deduplicates each caller request without limiting a session to one workflow", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-workflow-archive-"));
		directories.push(directory);
		const registry = createRegistry();
		const task = createWorkflowTask({
			createChild: async () => {
				throw new Error("This test only creates roots");
			},
			readChildResult: async () => {
				throw new Error("This test only creates roots");
			},
		});
		registry.install(defineExtension({ name: "workflow-archive-test", tasks: [task] }));
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "workflow.sqlite")),
			{ models: createModels(), registry },
			BACKGROUND_CONTEXT,
		);
		harnesses.push(harness);
		const conversation = await harness.root(BACKGROUND_CONTEXT);
		const input = { source: "return 1", args: { request: "same" } };
		const requests = await conversation.commit(async (tx) => {
			const first = await createWorkflowTaskOnce(tx, task, input, conversation.id, "request-1", {
				ownership: { kind: "conversation" },
			});
			const duplicate = await createWorkflowTaskOnce(tx, task, input, conversation.id, "request-1", {
				ownership: { kind: "conversation" },
			});
			const second = await createWorkflowTaskOnce(tx, task, input, conversation.id, "request-2", {
				ownership: { kind: "conversation" },
			});
			return { first, duplicate, second };
		}, BACKGROUND_CONTEXT);

		expect(requests.first.created).toBe(true);
		expect(requests.duplicate).toEqual({ taskId: requests.first.taskId, created: false });
		expect(requests.second.created).toBe(true);
		expect(requests.second.taskId).not.toBe(requests.first.taskId);
		await expect(
			harness.snapshot(WorkflowRunArchiveDoc, String(requests.first.taskId), BACKGROUND_CONTEXT),
		).resolves.toMatchObject({
			taskId: requests.first.taskId,
			status: "running",
		});
		await expect(
			harness.snapshot(WorkflowRunArchiveDoc, String(requests.second.taskId), BACKGROUND_CONTEXT),
		).resolves.toMatchObject({
			taskId: requests.second.taskId,
			status: "running",
		});
		const committedReplay = await conversation.commit(
			(tx) =>
				createWorkflowTaskOnce(tx, task, input, conversation.id, "request-1", {
					ownership: { kind: "conversation" },
				}),
			BACKGROUND_CONTEXT,
		);
		expect(committedReplay).toEqual({ taskId: requests.first.taskId, created: false });
		await expect(
			conversation.commit(
				(tx) =>
					createWorkflowTaskOnce(
						tx,
						task,
						{ source: input.source, args: { request: "changed" } },
						conversation.id,
						"request-1",
						{ ownership: { kind: "conversation" } },
					),
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow(/different input or ownership/u);

		const destination = { sessionFile: "/tmp/session.jsonl", sessionId: "session-1", originEntryId: "entry-1" };
		const result = await conversation.commit(async (tx) => {
			await archiveWorkflowSettlement(tx, {
				taskId: requests.first.taskId,
				conversationId: conversation.id,
				status: "completed",
				result: { answer: 42 },
				journal: {
					sourceDigest: "source",
					argumentsDigest: "arguments",
					seed: null,
					initialTimeMs: null,
					logicalTimeMs: null,
					status: "completed",
					error: "",
					nextCompletionOrder: 0,
					operations: [],
					races: [],
				} as WorkflowJournalState,
			});
			const queued = await queueWorkflowReceipt(tx, requests.first.taskId, "foreground", destination);
			const replay = await queueWorkflowReceipt(tx, requests.first.taskId, "foreground", destination);
			return { queued, replay };
		}, BACKGROUND_CONTEXT);
		expect(result.replay).toEqual(result.queued);
		const acknowledgment = {
			eventId: result.queued.eventId,
			digest: workflowReceiptDigest(result.queued, destination),
			entryId: "receipt-entry",
			destination,
		};
		await expect(
			conversation.commit(
				(tx) =>
					acknowledgeWorkflowReceipt(tx, requests.first.taskId, {
						...acknowledgment,
						destination: { ...destination, originEntryId: "other-branch" },
					}),
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow(/does not match/u);
		await expect(
			conversation.commit(
				(tx) => acknowledgeWorkflowReceipt(tx, requests.first.taskId, { ...acknowledgment, digest: "wrong" }),
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow(/digest does not match/u);
		await conversation.commit(
			(tx) => acknowledgeWorkflowReceipt(tx, requests.first.taskId, acknowledgment),
			BACKGROUND_CONTEXT,
		);
		await conversation.commit(
			(tx) => acknowledgeWorkflowReceipt(tx, requests.first.taskId, acknowledgment),
			BACKGROUND_CONTEXT,
		);
		await expect(
			harness.snapshot(WorkflowRunArchiveDoc, String(requests.first.taskId), BACKGROUND_CONTEXT),
		).resolves.toMatchObject({ receipt: { status: "persisted", acknowledgment } });

		await conversation.commit(async (tx) => {
			await archiveWorkflowSettlement(tx, {
				taskId: requests.second.taskId,
				conversationId: conversation.id,
				status: "failed",
				error: "provider failed",
				journal: {
					sourceDigest: "source",
					argumentsDigest: "arguments",
					seed: null,
					initialTimeMs: null,
					logicalTimeMs: null,
					status: "failed",
					error: "provider failed",
					nextCompletionOrder: 0,
					operations: [],
					races: [],
				} as WorkflowJournalState,
			});
			return undefined;
		}, BACKGROUND_CONTEXT);
		const failedDestination = { ...destination, originEntryId: "entry-2" };
		const failedEvent = await conversation.commit(
			(tx) => queueWorkflowReceipt(tx, requests.second.taskId, "background", failedDestination),
			BACKGROUND_CONTEXT,
		);
		expect(failedEvent.payload).toMatchObject({ status: "failed", result: null, error: "provider failed" });
		await conversation.commit(
			(tx) => blockWorkflowReceipt(tx, requests.second.taskId, "append needs reconciliation"),
			BACKGROUND_CONTEXT,
		);
		await expect(
			conversation.commit(
				(tx) => queueWorkflowReceipt(tx, requests.second.taskId, "background", failedDestination),
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow(/explicitly retry/u);
		const retriedEvent = await conversation.commit(
			(tx) => retryWorkflowReceipt(tx, requests.second.taskId, "background", failedDestination),
			BACKGROUND_CONTEXT,
		);
		expect(retriedEvent).toEqual(failedEvent);
	});
});
