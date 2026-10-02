import { fork } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attachWorkflowReceiptReceiver,
	captureWorkflowReceiptDestination,
	persistWorkflowReceipt,
	reconcileWorkflowReceiptSession,
	WORKFLOW_RECEIPT_TYPE,
	type WorkflowReceiptEvent,
	type WorkflowReceiptReceiver,
} from "../src/core/durable-workflows/receipt.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const directories: string[] = [];
const attachments: WorkflowReceiptReceiver[] = [];

function attach(session: SessionManager): WorkflowReceiptReceiver {
	const receiver = attachWorkflowReceiptReceiver(session);
	attachments.push(receiver);
	return receiver;
}
const event: WorkflowReceiptEvent = {
	eventId: "completion-1",
	runId: "run-1",
	route: "background",
	payload: { answer: 42 },
};

function chat() {
	const directory = mkdtempSync(join(tmpdir(), "pi-receipt-"));
	directories.push(directory);
	const session = SessionManager.create(directory, directory);
	const userId = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
	session.appendCustomEntry("workflow-launch", { runId: event.runId });
	return {
		directory,
		session,
		userId,
		destination: captureWorkflowReceiptDestination(session),
		receiver: attach(session),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const receiver of attachments.splice(0)) receiver.close();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("disk-verified workflow receipts", () => {
	it("uses canonical event bytes when durable redelivery reorders object keys", () => {
		const { receiver, destination } = chat();
		const first = persistWorkflowReceipt(receiver, destination, {
			...event,
			payload: { z: { second: 2, first: 1 }, a: [3, 4] },
		});
		expect(first.status).toBe("persisted");
		expect(
			persistWorkflowReceipt(receiver, destination, {
				payload: { a: [3, 4], z: { first: 1, second: 2 } },
				route: event.route,
				runId: event.runId,
				eventId: event.eventId,
			}),
		).toEqual(first);
	});

	it("excludes competing receivers and rejects delayed delivery from a detached attachment", () => {
		const { receiver, destination } = chat();
		const otherSession = SessionManager.open(destination.sessionFile);
		expect(() => attachWorkflowReceiptReceiver(otherSession)).toThrow("Another receipt receiver");
		receiver.close();
		const replacement = attach(otherSession);
		expect(persistWorkflowReceipt(receiver, destination, event)).toMatchObject({
			status: "pending",
			reason: expect.stringContaining("detached"),
		});
		expect(persistWorkflowReceipt(replacement, destination, event).status).toBe("persisted");
		expect(otherSession.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});

	it.each(["foreground", "background"] as const)(
		"persists %s completion once and verifies it after reopening",
		(route) => {
			const { receiver, destination } = chat();
			const completion = { ...event, route };
			const first = persistWorkflowReceipt(receiver, destination, completion);
			expect(first.status).toBe("persisted");
			expect(persistWorkflowReceipt(receiver, destination, completion)).toEqual(first);
			receiver.close();
			const reopened = SessionManager.open(destination.sessionFile);
			const reopenedReceiver = attach(reopened);
			expect(persistWorkflowReceipt(reopenedReceiver, destination, completion)).toEqual(first);
			expect(
				reopened
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === WORKFLOW_RECEIPT_TYPE),
			).toHaveLength(1);
			expect(reopened.buildSessionContext().messages.filter((message) => message.role === "assistant")).toHaveLength(
				0,
			);
			expect(
				persistWorkflowReceipt(reopenedReceiver, destination, { ...completion, payload: "changed" }),
			).toMatchObject({
				status: "pending",
				reason: expect.stringContaining("conflicts"),
			});
		},
	);

	it("requires a persisted conversation and keeps other sessions and sibling branches pending", () => {
		const { session, receiver, destination, userId, directory } = chat();
		const setup = SessionManager.create(directory, directory);
		setup.appendModelChange("faux", "faux-1");
		expect(() => captureWorkflowReceiptDestination(setup)).toThrow();
		expect(existsSync(setup.getSessionFile()!)).toBe(false);
		expect(() => captureWorkflowReceiptDestination(SessionManager.inMemory())).toThrow();
		session.branch(userId);
		session.appendMessage({ role: "user", content: "sibling", timestamp: 2 });
		expect(persistWorkflowReceipt(receiver, destination, event)).toMatchObject({
			status: "pending",
			reason: expect.stringContaining("branch"),
		});
		const other = chat();
		expect(persistWorkflowReceipt(other.receiver, destination, event).status).toBe("pending");
		session.branch(destination.originEntryId);
		expect(persistWorkflowReceipt(receiver, destination, event).status).toBe("persisted");
		session.branch(userId);
		expect(persistWorkflowReceipt(receiver, destination, event).status).toBe("pending");
	});

	it("does not acknowledge an in-memory ghost after a real append failure until explicit reconciliation", () => {
		const { session, receiver, destination } = chat();
		const persist = session._persist.bind(session);
		vi.spyOn(session, "_persist").mockImplementationOnce((entry) => {
			const backup = `${destination.sessionFile}.backup`;
			renameSync(destination.sessionFile, backup);
			mkdirSync(destination.sessionFile);
			try {
				persist(entry);
			} finally {
				rmSync(destination.sessionFile, { recursive: true });
				renameSync(backup, destination.sessionFile);
			}
		});
		expect(persistWorkflowReceipt(receiver, destination, event)).toMatchObject({
			status: "pending",
			reason: expect.stringContaining("EISDIR"),
		});
		expect(session.getEntries().some((entry) => entry.type === "custom_message")).toBe(true);
		expect(readFileSync(destination.sessionFile, "utf8")).not.toContain(WORKFLOW_RECEIPT_TYPE);
		expect(persistWorkflowReceipt(receiver, destination, event)).toMatchObject({
			status: "pending",
			reason: expect.stringContaining("explicit"),
		});
		reconcileWorkflowReceiptSession(receiver);
		expect(persistWorkflowReceipt(receiver, destination, event).status).toBe("persisted");
		expect(
			SessionManager.open(destination.sessionFile)
				.getEntries()
				.filter((entry) => entry.type === "custom_message"),
		).toHaveLength(1);
	});

	it("fails closed on a torn append until the file is repaired", () => {
		const { session, receiver, destination } = chat();
		const before = readFileSync(destination.sessionFile, "utf8");
		vi.spyOn(session, "_persist").mockImplementationOnce(() => {
			appendFileSync(destination.sessionFile, '{"type":"custom_message"');
			throw new Error("short write");
		});
		expect(persistWorkflowReceipt(receiver, destination, event).status).toBe("pending");
		expect(() => reconcileWorkflowReceiptSession(receiver)).toThrow("incomplete final line");
		expect(persistWorkflowReceipt(receiver, destination, event).status).toBe("pending");
		writeFileSync(destination.sessionFile, before);
		reconcileWorkflowReceiptSession(receiver);
		expect(persistWorkflowReceipt(receiver, destination, event).status).toBe("persisted");
	});

	it.each(["before", "after"])(
		"recovers an actual SIGKILL %s append without a false owner acknowledgment",
		async (phase) => {
			const { receiver, destination, directory } = chat();
			receiver.close();
			const input = join(directory, "event.json");
			const acknowledgmentFile = join(directory, "ack.json");
			writeFileSync(input, JSON.stringify({ destination, event }));
			const fixture = new URL("./fixtures/durable-receipt-process.ts", import.meta.url);
			const resolver = new URL("../src/experimental/source-resolver.ts", import.meta.url);
			const child = fork(fixture, [phase, input, acknowledgmentFile], {
				execArgv: ["--experimental-strip-types", "--import", resolver.href],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			let errors = "";
			child.stderr?.on("data", (chunk) => {
				errors += String(chunk);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					child.once("message", () => resolve());
					child.once("error", reject);
					child.once("exit", (code) => reject(new Error(`Child exited ${code}: ${errors}`)));
				});
				const contender = SessionManager.open(destination.sessionFile);
				expect(() => attachWorkflowReceiptReceiver(contender)).toThrow("Another receipt receiver");
				child.kill("SIGSTOP");
				expect(() => attachWorkflowReceiptReceiver(contender)).toThrow("Another receipt receiver");
				const exited = new Promise<NodeJS.Signals | null>((resolve) =>
					child.once("exit", (_code, signal) => resolve(signal)),
				);
				child.kill("SIGKILL");
				expect(await exited).toBe("SIGKILL");
				expect(existsSync(acknowledgmentFile)).toBe(false);
				expect(readFileSync(destination.sessionFile, "utf8").includes(WORKFLOW_RECEIPT_TYPE)).toBe(
					phase === "after",
				);
				const reopened = SessionManager.open(destination.sessionFile);
				const reopenedReceiver = attach(reopened);
				const result = persistWorkflowReceipt(reopenedReceiver, destination, event);
				expect(result.status).toBe("persisted");
				expect(persistWorkflowReceipt(reopenedReceiver, destination, event)).toEqual(result);
				expect(reopened.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
			} finally {
				child.kill("SIGKILL");
			}
		},
	);
});
