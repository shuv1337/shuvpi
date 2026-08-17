-- Upgrade databases created by the shipped fork 001_initial.sql (TEXT timestamps
-- and a few extra indexes) to the INTEGER unix-ms schema expected by current
-- repository code. Fresh installs run 001 then this file; already-numeric values
-- (integer/real affinity or digit-only TEXT) are preserved; ISO-8601 TEXT is
-- converted with unixepoch subsecond precision.
--
-- SQLite cannot ALTER column types, so sessions/entries/records are rebuilt.
-- FTS is content-synced to entries.rowid; dropping it here lets ensureSearchSchema
-- recreate triggers and rebuild the index against the new rowids.

DROP TRIGGER IF EXISTS session_search_fts_ai;
DROP TRIGGER IF EXISTS session_search_fts_ad;
DROP TRIGGER IF EXISTS session_search_fts_au;
DROP TABLE IF EXISTS session_search_fts;

CREATE TABLE sessions_new (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	cwd TEXT NOT NULL,
	parent_session_id TEXT NULL,
	metadata TEXT NULL
) WITHOUT ROWID;

INSERT INTO sessions_new (id, created_at, cwd, parent_session_id, metadata)
SELECT
	id,
	CASE
		WHEN typeof(created_at) = 'integer' THEN created_at
		WHEN typeof(created_at) = 'real' THEN CAST(created_at AS INTEGER)
		WHEN typeof(created_at) = 'text'
			AND created_at GLOB '[0-9]*'
			AND created_at NOT GLOB '*[^0-9]*'
			THEN CAST(created_at AS INTEGER)
		WHEN typeof(created_at) = 'text'
			AND created_at GLOB '[0-9]*.[0-9]*'
			AND created_at NOT GLOB '*[^0-9.]*'
			THEN CAST(CAST(created_at AS REAL) AS INTEGER)
		ELSE CAST(round(unixepoch(created_at, 'subsec') * 1000) AS INTEGER)
	END,
	cwd,
	parent_session_id,
	metadata
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd_created_at ON sessions(cwd, created_at DESC);
DROP INDEX IF EXISTS idx_sessions_parent;

CREATE TABLE entries_new (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	id TEXT NOT NULL,
	parent_id TEXT NULL,
	type TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, id),
	UNIQUE (session_id, seq)
);

INSERT INTO entries_new (session_id, seq, id, parent_id, type, timestamp, payload)
SELECT
	session_id,
	seq,
	id,
	parent_id,
	type,
	CASE
		WHEN typeof(timestamp) = 'integer' THEN timestamp
		WHEN typeof(timestamp) = 'real' THEN CAST(timestamp AS INTEGER)
		WHEN typeof(timestamp) = 'text'
			AND timestamp GLOB '[0-9]*'
			AND timestamp NOT GLOB '*[^0-9]*'
			THEN CAST(timestamp AS INTEGER)
		WHEN typeof(timestamp) = 'text'
			AND timestamp GLOB '[0-9]*.[0-9]*'
			AND timestamp NOT GLOB '*[^0-9.]*'
			THEN CAST(CAST(timestamp AS REAL) AS INTEGER)
		ELSE CAST(round(unixepoch(timestamp, 'subsec') * 1000) AS INTEGER)
	END,
	payload
FROM entries;

DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;

CREATE INDEX IF NOT EXISTS idx_entries_session_parent ON entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_entries_session_type_seq ON entries(session_id, type, seq);
DROP INDEX IF EXISTS idx_entries_session_seq;

CREATE TABLE records_new (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	id TEXT NOT NULL,
	lane TEXT NOT NULL,
	run_id TEXT NULL,
	type TEXT NOT NULL,
	op_kind TEXT NULL,
	timestamp INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, id),
	UNIQUE (session_id, seq)
) WITHOUT ROWID;

INSERT INTO records_new (session_id, seq, id, lane, run_id, type, op_kind, timestamp, payload)
SELECT
	session_id,
	seq,
	id,
	lane,
	run_id,
	type,
	op_kind,
	CASE
		WHEN typeof(timestamp) = 'integer' THEN timestamp
		WHEN typeof(timestamp) = 'real' THEN CAST(timestamp AS INTEGER)
		WHEN typeof(timestamp) = 'text'
			AND timestamp GLOB '[0-9]*'
			AND timestamp NOT GLOB '*[^0-9]*'
			THEN CAST(timestamp AS INTEGER)
		WHEN typeof(timestamp) = 'text'
			AND timestamp GLOB '[0-9]*.[0-9]*'
			AND timestamp NOT GLOB '*[^0-9.]*'
			THEN CAST(CAST(timestamp AS REAL) AS INTEGER)
		ELSE CAST(round(unixepoch(timestamp, 'subsec') * 1000) AS INTEGER)
	END,
	payload
FROM records;

DROP TABLE records;
ALTER TABLE records_new RENAME TO records;

CREATE INDEX IF NOT EXISTS idx_records_session_lane_seq ON records(session_id, lane, seq);
CREATE INDEX IF NOT EXISTS idx_records_session_type_seq ON records(session_id, type, seq);
CREATE INDEX IF NOT EXISTS idx_records_session_type_op_kind_seq ON records(session_id, type, op_kind, seq);
CREATE INDEX IF NOT EXISTS idx_records_session_lane_type_seq ON records(session_id, lane, type, seq);
CREATE INDEX IF NOT EXISTS idx_records_session_lane_type_op_kind_seq ON records(session_id, lane, type, op_kind, seq);
CREATE INDEX IF NOT EXISTS idx_records_session_run_id_seq ON records(session_id, run_id, seq);
DROP INDEX IF EXISTS idx_records_session_seq;

DROP INDEX IF EXISTS idx_lane_moves_session_lane_seq;
