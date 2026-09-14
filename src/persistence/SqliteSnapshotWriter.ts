import type { Summary } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import type { BranchRecordV2, FileSnapshotV2, ThoughtSessionV2 } from './FileSnapshotV2.js';
import type { SqliteDatabase } from './SqliteDriver.js';
import { runSqliteTransaction } from './SqliteDriver.js';
import {
	SQLITE_V2_SCHEMA_DDL,
	SQLITE_V2_VERSION_INSERT,
	validateSqliteV2Schema,
} from './SqliteSchemaV2.js';

function insertThoughts(database: SqliteDatabase, records: readonly ThoughtSessionV2[]): void {
	const insert = database.prepare('INSERT INTO thoughts (session_id, data) VALUES (?, ?)');
	for (const record of records) {
		for (const thought of record.thoughts) insert.run(record.sessionId, JSON.stringify(thought));
	}
}

function insertBranches(database: SqliteDatabase, records: readonly BranchRecordV2[]): void {
	const insert = database.prepare(
		'INSERT INTO branches (session_id, branch_id, data) VALUES (?, ?, ?)'
	);
	for (const record of records) {
		insert.run(record.sessionId, record.branchId, JSON.stringify(record.thoughts));
	}
}

function insertEdge(database: SqliteDatabase, edge: Edge): void {
	database
		.prepare(
			'INSERT INTO edges (id, session_id, from_id, to_id, kind, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
		.run(
			edge.id,
			edge.sessionId,
			edge.from,
			edge.to,
			edge.kind,
			edge.createdAt,
			edge.metadata === undefined ? null : JSON.stringify(edge.metadata)
		);
}

function insertSummary(database: SqliteDatabase, summary: Summary): void {
	database
		.prepare(
			'INSERT INTO summaries (id, session_id, branch_id, root_thought_id, covered_ids, covered_range_start, covered_range_end, topics, aggregate_confidence, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
		)
		.run(
			summary.id,
			summary.sessionId,
			summary.branchId ?? null,
			summary.rootThoughtId,
			JSON.stringify(summary.coveredIds),
			summary.coveredRange[0],
			summary.coveredRange[1],
			JSON.stringify(summary.topics),
			summary.aggregateConfidence,
			summary.createdAt,
			summary.meta === undefined ? null : JSON.stringify(summary.meta)
		);
}

/**
 * Writes and validates a canonical File v2 snapshot into an empty SQLite v2 database.
 *
 * @param database - Empty SQLite destination database.
 * @param snapshot - Validated snapshot to write.
 * @param destinationPath - Destination path included in compatibility errors.
 * @returns Nothing after the transaction commits successfully.
 *
 * @example
 * ```ts
 * writeSqliteSnapshot(database, snapshot, '/data/history.db');
 * ```
 */
export function writeSqliteSnapshot(
	database: SqliteDatabase,
	snapshot: FileSnapshotV2,
	destinationPath: string
): void {
	runSqliteTransaction(database, () => {
		database.exec(SQLITE_V2_SCHEMA_DDL);
		insertThoughts(database, snapshot.thoughts);
		insertBranches(database, snapshot.branches);
		for (const record of snapshot.edges)
			for (const edge of record.edges) insertEdge(database, edge);
		for (const record of snapshot.summaries) {
			for (const summary of record.summaries) insertSummary(database, summary);
		}
		database.exec(SQLITE_V2_VERSION_INSERT);
		validateSqliteV2Schema(database, destinationPath);
	});
}
