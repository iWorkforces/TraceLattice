export interface SqliteRunResult {
	readonly changes: number;
	readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
	run(...params: readonly unknown[]): SqliteRunResult;
	get(...params: readonly unknown[]): unknown;
	all(...params: readonly unknown[]): unknown[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
	pragma(pragma: string): unknown;
}

export type SqliteDatabaseConstructor = new (
	path: string,
	options?: { readonly readonly?: boolean; readonly fileMustExist?: boolean }
) => SqliteDatabase;

type SqliteBeginStatement = 'BEGIN' | 'BEGIN IMMEDIATE';

function runTransaction<T>(
	database: SqliteDatabase,
	beginStatement: SqliteBeginStatement,
	operation: () => T
): T {
	database.exec(beginStatement);
	try {
		const result = operation();
		database.exec('COMMIT');
		return result;
	} catch (error) {
		try {
			database.exec('ROLLBACK');
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				'SQLite operation and rollback both failed',
				{
					cause: rollbackError,
				}
			);
		}
		throw error;
	}
}

export function runSqliteTransaction<T>(database: SqliteDatabase, operation: () => T): T {
	return runTransaction(database, 'BEGIN IMMEDIATE', operation);
}

export function runSqliteReadTransaction<T>(database: SqliteDatabase, operation: () => T): T {
	return runTransaction(database, 'BEGIN', operation);
}
