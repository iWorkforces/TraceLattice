/**
 * Ambient module declaration for the optional 'better-sqlite3' dependency.
 *
 * better-sqlite3 is an optional runtime dependency installed as an exact development
 * dependency for native conformance. Since @types/better-sqlite3 is not installed,
 * this declaration provides minimal typing for the dynamic import.
 * The exported constructor returns a Database instance matching the local interface
 * defined in SqlitePersistence.ts.
 */
declare module 'better-sqlite3' {
	interface Database {
		exec(sql: string): void;
		prepare(sql: string): Statement;
		close(): void;
		pragma(pragma: string): unknown;
	}

	interface Statement {
		run(...params: unknown[]): RunResult;
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	}

	interface RunResult {
		changes: number;
		lastInsertRowid: number;
	}

	const DatabaseCtor: new (
		path: string,
		options?: { readonly readonly?: boolean; readonly fileMustExist?: boolean }
	) => Database;
	export default DatabaseCtor;
}
