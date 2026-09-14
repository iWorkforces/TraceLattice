import { lstat, link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { GLOBAL_SESSION_ID, type SessionId } from '../contracts/ids.js';
import {
	PersistenceCompatibilityError,
	PersistenceCorruptionError,
	PersistenceLegacyAmbiguityError,
} from '../errors.js';
import {
	parseFileSnapshotV2,
	serializeFileSnapshotV2,
	type BranchRecordV2,
	type EdgeSessionV2,
	type FileSnapshotV2,
	type SummarySessionV2,
	type ThoughtSessionV2,
} from './FileSnapshotV2.js';
import { isFileNotFound } from './FileWriter.js';
import type { SqliteDatabase, SqliteDatabaseConstructor } from './SqliteDriver.js';
import { validateSqliteV1Schema } from './SqliteLegacySchema.js';
import {
	decodeEdgeRow,
	decodeSummaryRow,
	decodeThoughtRow,
	parseSqliteJson,
	stringField,
} from './SqlitePayload.js';
import { parsePersistenceBranchId } from './PersistenceScope.js';
import { writeSqliteSnapshot } from './SqliteSnapshotWriter.js';

async function pathIsAbsent(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if (isFileNotFound(error)) return true;
		throw error;
	}
}

function groupBySession<T>(
	values: readonly T[],
	sessionOf: (value: T) => SessionId
): Map<SessionId, T[]> {
	const grouped = new Map<SessionId, T[]>();
	for (const value of values) {
		const sessionId = sessionOf(value);
		const sessionValues = grouped.get(sessionId) ?? [];
		sessionValues.push(value);
		grouped.set(sessionId, sessionValues);
	}
	return grouped;
}

function loadLegacyThoughts(database: SqliteDatabase, sourcePath: string): ThoughtSessionV2[] {
	const thoughts = database
		.prepare('SELECT data FROM thoughts ORDER BY id ASC')
		.all()
		.map((row, index) => decodeThoughtRow(row, `${sourcePath}:thoughts:${index}`));
	return [...groupBySession(thoughts, (thought) => thought.session_id ?? GLOBAL_SESSION_ID)].map(
		([sessionId, sessionThoughts]) => ({ sessionId, thoughts: sessionThoughts })
	);
}

function decodeLegacyBranch(row: unknown, sourcePath: string): BranchRecordV2 {
	const branchId = parsePersistenceBranchId(stringField(row, 'branch_id', sourcePath), sourcePath);
	const data = parseSqliteJson(stringField(row, 'data', sourcePath), sourcePath);
	if (!Array.isArray(data)) {
		throw new PersistenceCorruptionError(sourcePath, new TypeError('branch data is not an array'));
	}
	const thoughts = data.map((value, index) =>
		decodeThoughtRow({ data: JSON.stringify(value) }, `${sourcePath}:thought:${index}`)
	);
	if (thoughts.length === 0) {
		throw new PersistenceLegacyAmbiguityError(sourcePath, 'empty branch has no inferable session');
	}
	const sessions = new Set(thoughts.map((thought) => thought.session_id ?? GLOBAL_SESSION_ID));
	if (sessions.size !== 1) {
		throw new PersistenceLegacyAmbiguityError(
			sourcePath,
			'branch thoughts resolve to multiple sessions'
		);
	}
	const sessionId = sessions.values().next().value;
	if (sessionId === undefined) {
		throw new PersistenceLegacyAmbiguityError(sourcePath, 'branch session is absent');
	}
	return { sessionId, branchId, thoughts };
}

function loadLegacyBranches(
	database: SqliteDatabase,
	sourcePath: string,
	hasBranches: boolean
): BranchRecordV2[] {
	if (!hasBranches) return [];
	return database
		.prepare('SELECT branch_id, data FROM branches ORDER BY branch_id ASC')
		.all()
		.map((row, index) => decodeLegacyBranch(row, `${sourcePath}:branches:${index}`));
}

function loadLegacyEdges(database: SqliteDatabase, sourcePath: string): EdgeSessionV2[] {
	const edges = database
		.prepare(
			'SELECT id, session_id, from_id, to_id, kind, created_at, metadata FROM edges ORDER BY created_at ASC, id ASC'
		)
		.all()
		.map((row, index) => decodeEdgeRow(row, `${sourcePath}:edges:${index}`));
	return [...groupBySession(edges, (edge) => edge.sessionId)].map(([sessionId, sessionEdges]) => ({
		sessionId,
		edges: sessionEdges,
	}));
}

function loadLegacySummaries(database: SqliteDatabase, sourcePath: string): SummarySessionV2[] {
	const summaries = database
		.prepare(
			'SELECT id, session_id, branch_id, root_thought_id, covered_ids, covered_range_start, covered_range_end, topics, aggregate_confidence, created_at, meta FROM summaries ORDER BY created_at ASC, id ASC'
		)
		.all()
		.map((row, index) => decodeSummaryRow(row, `${sourcePath}:summaries:${index}`));
	return [...groupBySession(summaries, (summary) => summary.sessionId)].map(
		([sessionId, sessionSummaries]) => ({ sessionId, summaries: sessionSummaries })
	);
}

function loadLegacySnapshot(database: SqliteDatabase, sourcePath: string): FileSnapshotV2 {
	const hasBranches = validateSqliteV1Schema(database, sourcePath);
	const snapshot: FileSnapshotV2 = {
		version: 2,
		thoughts: loadLegacyThoughts(database, sourcePath),
		branches: loadLegacyBranches(database, sourcePath, hasBranches),
		edges: loadLegacyEdges(database, sourcePath),
		summaries: loadLegacySummaries(database, sourcePath),
	};
	return parseFileSnapshotV2(serializeFileSnapshotV2(snapshot, sourcePath), sourcePath);
}

async function importWithDriver(
	sourceDbPath: string,
	destinationDbPath: string,
	Database: SqliteDatabaseConstructor
): Promise<void> {
	if (!(await pathIsAbsent(destinationDbPath))) {
		throw new PersistenceCompatibilityError(destinationDbPath, 'destination must be absent');
	}
	const source = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
	let snapshot: FileSnapshotV2;
	try {
		snapshot = loadLegacySnapshot(source, sourceDbPath);
	} finally {
		source.close();
	}
	await mkdir(dirname(destinationDbPath), { recursive: true });
	const stagingDir = await mkdtemp(
		join(dirname(destinationDbPath), `.${basename(destinationDbPath)}.import-`)
	);
	const stagedDbPath = join(stagingDir, basename(destinationDbPath));
	let destination: SqliteDatabase | undefined;
	try {
		destination = new Database(stagedDbPath);
		writeSqliteSnapshot(destination, snapshot, stagedDbPath);
		destination.close();
		destination = undefined;
		await link(stagedDbPath, destinationDbPath);
	} catch (error) {
		destination?.close();
		throw error;
	} finally {
		await rm(stagingDir, { recursive: true, force: true });
	}
}

/**
 * Imports an immutable SQLite v1 database into a separately published SQLite v2 destination.
 *
 * @param sourceDbPath - Existing frozen v1 source database opened read-only.
 * @param destinationDbPath - Absent destination path atomically published after validation.
 * @returns A promise that resolves after the validated v2 database is published.
 *
 * @example
 * ```ts
 * await importLegacySqliteV1('fixtures/legacy.db', 'output/history.db');
 * ```
 */
export async function importLegacySqliteV1(
	sourceDbPath: string,
	destinationDbPath: string
): Promise<void> {
	let Database: SqliteDatabaseConstructor;
	try {
		const module = await import('better-sqlite3');
		Database = module.default;
	} catch (error) {
		throw new PersistenceCompatibilityError(
			sourceDbPath,
			"SQLite import requires the optional 'better-sqlite3' package",
			error
		);
	}
	await importWithDriver(sourceDbPath, destinationDbPath, Database);
}
