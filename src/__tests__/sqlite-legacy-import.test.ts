import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importLegacySqliteV1 } from '../persistence/SqliteLegacyImport.js';
import { SQLITE_V2_SCHEMA_DDL } from '../persistence/SqliteSchemaV2.js';
import { createTestThought } from './helpers/factories.js';

const sqliteImportState = vi.hoisted(() => {
	const values = (): unknown[] => [];
	const commands = (): string[] => [];
	return {
		sourceSchemaRows: values(),
		thoughtRows: values(),
		branchRows: values(),
		edgeRows: values(),
		summaryRows: values(),
		destinationExec: commands(),
		destinationRuns: commands(),
		openings: commands(),
		failDestinationInsert: false,
	};
});

vi.mock('better-sqlite3', async () => {
	const { writeFileSync } = await import('node:fs');
	type Options = { readonly readonly?: boolean; readonly fileMustExist?: boolean };
	type SchemaRow = {
		readonly type: string;
		readonly name: string;
		readonly tbl_name: string;
		readonly sql: string;
	};

	class ImportDatabase {
		private readonly _source: boolean;
		private _schemaRows: SchemaRow[] = [];
		private _versionRows: unknown[] = [];

		constructor(path: string, options?: Options) {
			this._source = options?.readonly === true;
			sqliteImportState.openings.push(`${this._source ? 'source' : 'destination'}:${path}`);
			if (!this._source) writeFileSync(path, 'structural sqlite v2');
		}

		public exec(sql: string): void {
			sqliteImportState.destinationExec.push(sql);
			if (sql.includes('CREATE TABLE schema_version')) {
				this._schemaRows = sql
					.split(';')
					.map((statement) => statement.trim())
					.filter(Boolean)
					.flatMap((statement) => {
						const match = /^CREATE\s+(TABLE|INDEX)\s+([^\s(]+)/i.exec(statement);
						if (match?.[1] === undefined || match[2] === undefined) return [];
						const type = match[1].toLowerCase();
						const table = type === 'index' ? /\sON\s+([^\s(]+)/i.exec(statement)?.[1] : match[2];
						return [{ type, name: match[2], tbl_name: table ?? match[2], sql: statement }];
					});
			}
			if (sql.includes('INSERT INTO schema_version')) {
				this._versionRows = [{ singleton: 1, version: 2 }];
			}
		}

		public prepare(sql: string) {
			return {
				run: (...params: readonly unknown[]) => {
					if (sqliteImportState.failDestinationInsert && sql.includes('INSERT INTO thoughts')) {
						throw new Error('injected destination insert failure');
					}
					sqliteImportState.destinationRuns.push(`${sql}:${JSON.stringify(params)}`);
					return { changes: 1, lastInsertRowid: 1 };
				},
				get: () => undefined,
				all: (): unknown[] => {
					if (this._source) {
						if (sql.includes('sqlite_master')) return sqliteImportState.sourceSchemaRows;
						if (sql.includes('FROM thoughts')) return sqliteImportState.thoughtRows;
						if (sql.includes('FROM branches')) return sqliteImportState.branchRows;
						if (sql.includes('FROM edges')) return sqliteImportState.edgeRows;
						if (sql.includes('FROM summaries')) return sqliteImportState.summaryRows;
					}
					if (sql.includes('sqlite_master')) return this._schemaRows;
					if (sql.includes('schema_version')) return this._versionRows;
					return [];
				},
			};
		}

		public close(): void {}
		public pragma(): unknown {
			return undefined;
		}
	}

	return { default: ImportDatabase };
});

const LEGACY_SCHEMA_ROWS = [
	{
		type: 'table',
		name: 'thoughts',
		sql: "CREATE TABLE thoughts (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s', 'now')))",
	},
	{
		type: 'table',
		name: 'edges',
		sql: 'CREATE TABLE edges (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT)',
	},
	{
		type: 'table',
		name: 'summaries',
		sql: 'CREATE TABLE summaries (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT, root_thought_id TEXT NOT NULL, covered_ids TEXT NOT NULL, covered_range_start INTEGER NOT NULL, covered_range_end INTEGER NOT NULL, topics TEXT NOT NULL, aggregate_confidence REAL NOT NULL, created_at INTEGER NOT NULL, meta TEXT)',
	},
	{
		type: 'index',
		name: 'idx_thoughts_created_at',
		sql: 'CREATE INDEX idx_thoughts_created_at ON thoughts(created_at)',
	},
	{
		type: 'index',
		name: 'idx_edges_session',
		sql: 'CREATE INDEX idx_edges_session ON edges(session_id)',
	},
	{
		type: 'index',
		name: 'idx_edges_from',
		sql: 'CREATE INDEX idx_edges_from ON edges(session_id, from_id)',
	},
	{
		type: 'index',
		name: 'idx_edges_to',
		sql: 'CREATE INDEX idx_edges_to ON edges(session_id, to_id)',
	},
	{
		type: 'index',
		name: 'idx_summaries_session',
		sql: 'CREATE INDEX idx_summaries_session ON summaries(session_id)',
	},
] as const;

beforeEach(() => {
	sqliteImportState.sourceSchemaRows = [...LEGACY_SCHEMA_ROWS];
	sqliteImportState.thoughtRows = [];
	sqliteImportState.branchRows = [];
	sqliteImportState.edgeRows = [];
	sqliteImportState.summaryRows = [];
	sqliteImportState.destinationExec = [];
	sqliteImportState.destinationRuns = [];
	sqliteImportState.openings = [];
	sqliteImportState.failDestinationInsert = false;
});

describe('SQLite v1 immutable importer', () => {
	it('publishes a validated v2 destination while preserving source bytes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-sqlite-import-success-'));
		const source = join(root, 'source.db');
		const destination = join(root, 'destination.db');
		const sourceBytes = 'immutable sqlite v1 fixture';
		await writeFile(source, sourceBytes, 'utf-8');
		sqliteImportState.thoughtRows = [
			{ data: JSON.stringify(createTestThought({ id: 'legacy-thought' })) },
		];

		try {
			await importLegacySqliteV1(source, destination);

			expect(await readFile(source, 'utf-8')).toBe(sourceBytes);
			expect(await readFile(destination, 'utf-8')).toBe('structural sqlite v2');
			expect(sqliteImportState.destinationExec).toContain(SQLITE_V2_SCHEMA_DDL);
			expect(
				sqliteImportState.destinationRuns.some((command) => command.includes('legacy-thought'))
			).toBe(true);
			expect((await readdir(root)).some((name) => name.startsWith('.destination.db.import-'))).toBe(
				false
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects schema drift without creating a destination', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-sqlite-import-drift-'));
		const source = join(root, 'source.db');
		const destination = join(root, 'destination.db');
		await writeFile(source, 'drifted source', 'utf-8');
		sqliteImportState.sourceSchemaRows = LEGACY_SCHEMA_ROWS.slice(1);

		try {
			await expect(importLegacySqliteV1(source, destination)).rejects.toMatchObject({
				code: 'PERSISTENCE_COMPATIBILITY',
			});
			await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
			expect(await readFile(source, 'utf-8')).toBe('drifted source');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('removes staging and leaves the destination absent after a transactional failure', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-sqlite-import-failure-'));
		const source = join(root, 'source.db');
		const destination = join(root, 'destination.db');
		await writeFile(source, 'failing source', 'utf-8');
		sqliteImportState.thoughtRows = [
			{ data: JSON.stringify(createTestThought({ id: 'failure-thought' })) },
		];
		sqliteImportState.failDestinationInsert = true;

		try {
			await expect(importLegacySqliteV1(source, destination)).rejects.toThrow(
				'injected destination insert failure'
			);
			await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
			expect(await readFile(source, 'utf-8')).toBe('failing source');
			expect((await readdir(root)).some((name) => name.startsWith('.destination.db.import-'))).toBe(
				false
			);
			expect(sqliteImportState.destinationExec.at(-1)).toBe('ROLLBACK');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
