import { PersistenceCompatibilityError } from '../errors.js';
import type { SqliteDatabase } from './SqliteDriver.js';

type LegacySchemaObject = {
	readonly type: string;
	readonly name: string;
	readonly sql: string;
};

const LEGACY_TABLES = new Map<string, string>([
	[
		'thoughts',
		"CREATE TABLE thoughts (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s', 'now')))",
	],
	[
		'branches',
		"CREATE TABLE branches (branch_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER DEFAULT (strftime('%s', 'now')))",
	],
	[
		'edges',
		'CREATE TABLE edges (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT)',
	],
	[
		'summaries',
		'CREATE TABLE summaries (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT, root_thought_id TEXT NOT NULL, covered_ids TEXT NOT NULL, covered_range_start INTEGER NOT NULL, covered_range_end INTEGER NOT NULL, topics TEXT NOT NULL, aggregate_confidence REAL NOT NULL, created_at INTEGER NOT NULL, meta TEXT)',
	],
]);

const LEGACY_INDEXES = new Map<string, string>([
	['idx_thoughts_created_at', 'CREATE INDEX idx_thoughts_created_at ON thoughts(created_at)'],
	['idx_edges_session', 'CREATE INDEX idx_edges_session ON edges(session_id)'],
	['idx_edges_from', 'CREATE INDEX idx_edges_from ON edges(session_id, from_id)'],
	['idx_edges_to', 'CREATE INDEX idx_edges_to ON edges(session_id, to_id)'],
	['idx_summaries_session', 'CREATE INDEX idx_summaries_session ON summaries(session_id)'],
]);

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').replace(/;$/, '').trim().toLowerCase();
}

function readObject(value: unknown, sourcePath: string): LegacySchemaObject {
	if (typeof value !== 'object' || value === null) {
		throw new PersistenceCompatibilityError(sourcePath, 'invalid sqlite_master row');
	}
	const type = 'type' in value ? value.type : undefined;
	const name = 'name' in value ? value.name : undefined;
	const sql = 'sql' in value ? value.sql : undefined;
	if (typeof type !== 'string' || typeof name !== 'string' || typeof sql !== 'string') {
		throw new PersistenceCompatibilityError(sourcePath, 'invalid sqlite_master fields');
	}
	return { type, name, sql };
}

/**
 * Validates the frozen, unversioned SQLite v1 schema without mutating it.
 *
 * @param database - Read-only source database.
 * @param sourcePath - Source name used by typed compatibility errors.
 * @returns Whether the optional legacy branches table is present.
 *
 * @example
 * ```ts
 * const hasBranches = validateSqliteV1Schema(database, 'legacy.db');
 * ```
 */
export function validateSqliteV1Schema(database: SqliteDatabase, sourcePath: string): boolean {
	const objects = database
		.prepare(
			"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
		)
		.all()
		.map((row) => readObject(row, sourcePath));
	const hasBranches = objects.some(({ type, name }) => type === 'table' && name === 'branches');
	const expected = new Map<string, string>();
	for (const [name, sql] of LEGACY_TABLES) {
		if (name !== 'branches' || hasBranches) expected.set(`table:${name}`, normalizeSql(sql));
	}
	for (const [name, sql] of LEGACY_INDEXES) expected.set(`index:${name}`, normalizeSql(sql));
	if (objects.length !== expected.size) {
		throw new PersistenceCompatibilityError(sourcePath, 'SQLite v1 object set does not match');
	}
	for (const object of objects) {
		const expectedSql = expected.get(`${object.type}:${object.name}`);
		if (expectedSql === undefined || normalizeSql(object.sql) !== expectedSql) {
			throw new PersistenceCompatibilityError(sourcePath, `SQLite v1 drift at '${object.name}'`);
		}
	}
	return hasBranches;
}
