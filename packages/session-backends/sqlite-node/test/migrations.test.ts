import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMigrations, createNodeSqliteFactory } from "../src/index.ts";
import { createTempDir } from "./test-utils.ts";

describe("SQLite migrations", () => {
	it("applies the current schema once and records its migration", async () => {
		const databasePath = join(createTempDir(), "sessions.sqlite");
		const db = await createNodeSqliteFactory().open(databasePath);
		try {
			await applyMigrations(db);
			await applyMigrations(db);

			const rows = db.prepare("SELECT id FROM migrations ORDER BY id").all<{ id: string }>();
			expect(rows.map((row) => row.id)).toEqual(["001_initial.sql", "002_integer_timestamps.sql"]);
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string }>();
			expect(tables.map((row) => row.name)).toEqual(
				expect.arrayContaining([
					"migrations",
					"sessions",
					"entries",
					"session_sequences",
					"session_stats",
					"branch_entries",
					"branch_tips",
					"lanes",
					"records",
					"lane_moves",
					"facts",
					"writer_leases",
				]),
			);
			const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all<{ name: string; type: string }>();
			expect(sessionColumns.map((column) => column.name)).not.toContain("leaf_id");
			expect(sessionColumns.find((column) => column.name === "created_at")?.type).toBe("INTEGER");
			const entryColumns = db.prepare("PRAGMA table_info(entries)").all<{ name: string; type: string }>();
			expect(entryColumns.find((column) => column.name === "timestamp")?.type).toBe("INTEGER");
			const recordColumns = db.prepare("PRAGMA table_info(records)").all<{ name: string; type: string }>();
			expect(recordColumns.find((column) => column.name === "timestamp")?.type).toBe("INTEGER");
			const sessionIndexes = db.prepare("PRAGMA index_list(sessions)").all<{ name: string }>();
			expect(sessionIndexes.map((index) => index.name)).toContain("idx_sessions_cwd_created_at");
			expect(sessionIndexes.map((index) => index.name)).not.toContain("idx_sessions_parent");
			const laneColumns = db.prepare("PRAGMA table_info(lanes)").all<{ name: string }>();
			expect(laneColumns.map((column) => column.name)).toContain("open_operation_id");
			const entryIndexes = db.prepare("PRAGMA index_list(entries)").all<{ name: string }>();
			expect(entryIndexes.map((index) => index.name)).not.toContain("idx_entries_session_seq");
			const branchEntryIndexes = db.prepare("PRAGMA index_list(branch_entries)").all<{ name: string }>();
			expect(branchEntryIndexes.map((index) => index.name)).toContain("idx_branch_entries_session_entry");
			const recordIndexes = db.prepare("PRAGMA index_list(records)").all<{ name: string }>();
			expect(recordIndexes.map((index) => index.name)).toEqual(
				expect.arrayContaining([
					"idx_records_session_lane_seq",
					"idx_records_session_type_seq",
					"idx_records_session_type_op_kind_seq",
				]),
			);
			expect(recordIndexes.map((index) => index.name)).not.toContain("idx_records_session_seq");
			const laneMoveIndexes = db.prepare("PRAGMA index_list(lane_moves)").all<{ name: string }>();
			expect(laneMoveIndexes.map((index) => index.name)).not.toContain("idx_lane_moves_session_lane_seq");
		} finally {
			db.close();
		}
	});

	it("upgrades timestamps in a database that already applied the shipped initial migration", async () => {
		const databasePath = join(createTempDir(), "sessions.sqlite");
		const db = await createNodeSqliteFactory().open(databasePath);
		try {
			const initialSql = await readFile(
				fileURLToPath(new URL("../src/sqlite/migrations/001_initial.sql", import.meta.url)),
				"utf8",
			);
			db.exec(initialSql);
			db.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
			db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(
				"001_initial.sql",
				"2026-08-17T00:00:00.000Z",
			);
			db.prepare("INSERT INTO sessions (id, created_at, cwd) VALUES (?, ?, ?)").run(
				"session-1",
				"2026-08-17T12:34:56.789Z",
				"/tmp/project",
			);
			db.prepare(
				"INSERT INTO entries (session_id, seq, id, parent_id, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run("session-1", 1, "entry-1", null, "message", "2026-08-17T12:35:00.123Z", "{}");
			db.prepare(
				"INSERT INTO records (session_id, seq, id, lane, run_id, type, op_kind, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run("session-1", 1, "record-1", "main", null, "event", null, "2026-08-17T12:35:01.456Z", "{}");

			await applyMigrations(db);

			expect(db.prepare("SELECT created_at FROM sessions WHERE id = ?").get("session-1")).toEqual({
				created_at: Date.parse("2026-08-17T12:34:56.789Z"),
			});
			expect(db.prepare("SELECT timestamp FROM entries WHERE id = ?").get("entry-1")).toEqual({
				timestamp: Date.parse("2026-08-17T12:35:00.123Z"),
			});
			expect(db.prepare("SELECT timestamp FROM records WHERE id = ?").get("record-1")).toEqual({
				timestamp: Date.parse("2026-08-17T12:35:01.456Z"),
			});
		} finally {
			db.close();
		}
	});
});
