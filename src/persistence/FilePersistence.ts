import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import * as v from 'valibot';
import type { IMetrics } from '../contracts/interfaces.js';
import type { ThoughtData } from '../core/thought.js';
import type { Edge } from '../core/graph/Edge.js';
import type { Summary } from '../core/compression/Summary.js';
import type { PersistenceBackend, PersistenceConfig } from '../contracts/PersistenceBackend.js';
import { asBranchId, asSessionId, type BranchId, type SessionId } from '../contracts/ids.js';
import { SequentialThinkingSchema, EdgeSchema } from '../schema.js';
import { SummarySchema } from '../core/compression/Summary.js';
import { PersistenceCorruptionError, ValidationError } from '../errors.js';
import { FileWriter, isFileNotFound, type FileWriterOperations } from './FileWriter.js';

const ThoughtArraySchema = v.array(SequentialThinkingSchema);
const EdgeArraySchema = v.array(EdgeSchema);
const SummaryArraySchema = v.array(SummarySchema);

type FilePersistenceOptions = NonNullable<PersistenceConfig['options']> & {
	readonly metrics?: IMetrics;
	readonly writerOperations?: FileWriterOperations;
};

export class FilePersistence implements PersistenceBackend {
	private readonly _dataDir: string;
	private readonly _maxHistorySize: number;
	private readonly _persistBranches: boolean;
	private readonly _metrics: IMetrics | undefined;
	private readonly _writer: FileWriter;

	constructor(options?: FilePersistenceOptions) {
		const defaultDataDir = existsSync('.claude/data')
			? '.claude/data'
			: join(homedir(), '.claude/data');
		this._dataDir = options?.dataDir ?? defaultDataDir;
		this._maxHistorySize = options?.maxHistorySize ?? 10000;
		this._persistBranches = options?.persistBranches ?? true;
		this._metrics = options?.metrics;
		this._writer = new FileWriter(this._dataDir, options?.writerOperations);
	}

	public static async create(options?: FilePersistenceOptions): Promise<FilePersistence> {
		const persistence = new FilePersistence(options);
		try {
			await persistence._writer.ready();
			return persistence;
		} catch (error) {
			await persistence.close();
			throw error;
		}
	}

	public async saveThought(thought: ThoughtData): Promise<void> {
		await this._measure('save_thought', async () => {
			await this._writer.run(async (dataDir) => {
				await this._ensureDirectories(dataDir);
				const historyPath = join(dataDir, 'history.json');
				const loadStartTime = Date.now();
				let history: ThoughtData[];
				try {
					history =
						(await this._loadArray<ThoughtData>(historyPath, ThoughtArraySchema, 'history')) ?? [];
				} finally {
					this._recordOperationDuration('load_history', loadStartTime);
				}
				history.push(thought);
				if (history.length > this._maxHistorySize) {
					history.splice(0, history.length - this._maxHistorySize);
				}
				await this._writer.publish(historyPath, JSON.stringify(history, null, 2));
			});
		});
	}

	public async loadHistory(): Promise<ThoughtData[]> {
		return await this._measure('load_history', async () => {
			return await this._writer.run(
				async (dataDir) =>
					(await this._loadArray<ThoughtData>(
						join(dataDir, 'history.json'),
						ThoughtArraySchema,
						'history'
					)) ?? []
			);
		});
	}

	public async saveBranch(branchId: BranchId, thoughts: ThoughtData[]): Promise<void> {
		await this._measure('save_branch', async () => {
			if (!this._persistBranches) {
				return;
			}
			await this._writer.run(async (dataDir) => {
				await this._ensureDirectories(dataDir);
				await this._writer.publish(
					this._safePath(join(dataDir, 'branches'), branchId, 64),
					JSON.stringify(thoughts, null, 2)
				);
			});
		});
	}

	public async loadBranch(branchId: BranchId): Promise<ThoughtData[] | undefined> {
		return await this._measure('load_branch', async () => {
			if (!this._persistBranches) {
				return undefined;
			}
			return await this._writer.run(
				async (dataDir) =>
					await this._loadArray<ThoughtData>(
						this._safePath(join(dataDir, 'branches'), branchId, 64),
						ThoughtArraySchema,
						'branch'
					)
			);
		});
	}

	public async listBranches(): Promise<BranchId[]> {
		return (await this.getBranchIds()).map((id) => asBranchId(id));
	}

	public async clear(): Promise<void> {
		await this._writer.run(async (dataDir) => {
			await this._unlinkIfPresent(join(dataDir, 'history.json'));
			if (this._persistBranches) {
				await this._clearJsonFiles(join(dataDir, 'branches'));
			}
			await this._clearJsonFiles(join(dataDir, 'edges'));
			await this._clearJsonFiles(join(dataDir, 'summaries'));
		});
	}

	public async healthy(): Promise<boolean> {
		try {
			await this._writer.run(async (dataDir) => await this._ensureDirectories(dataDir));
			return true;
		} catch (error) {
			if (error instanceof Error) {
				return false;
			}
			throw error;
		}
	}

	public getDataDir(): string {
		return this._dataDir;
	}

	public async getBranchIds(): Promise<string[]> {
		if (!this._persistBranches) {
			return [];
		}
		return await this._writer.run(async (dataDir) => {
			return await this._listJsonIds(join(dataDir, 'branches'));
		});
	}

	public async close(): Promise<void> {
		await this._writer.close();
	}

	public async saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void> {
		await this._measure('save_edges', async () => {
			await this._writer.run(async (dataDir) => {
				await this._ensureDirectories(dataDir);
				const edgePath = this._safePath(join(dataDir, 'edges'), sessionId, 100);
				if (edges.length === 0) {
					await this._unlinkIfPresent(edgePath);
					return;
				}
				const sorted = [...edges].sort((left, right) => left.createdAt - right.createdAt);
				await this._writer.publish(edgePath, JSON.stringify(sorted, null, 2));
			});
		});
	}

	public async loadEdges(sessionId: SessionId): Promise<Edge[]> {
		return await this._measure('load_edges', async () => {
			return await this._writer.run(
				async (dataDir) =>
					(await this._loadArray<Edge>(
						this._safePath(join(dataDir, 'edges'), sessionId, 100),
						EdgeArraySchema,
						'edges'
					)) ?? []
			);
		});
	}

	public async listEdgeSessions(): Promise<SessionId[]> {
		return await this._writer.run(async (dataDir) => {
			return (await this._listJsonIds(join(dataDir, 'edges'))).map((id) => asSessionId(id));
		});
	}

	public async saveSummaries(sessionId: SessionId, summaries: readonly Summary[]): Promise<void> {
		await this._measure('save_summaries', async () => {
			await this._writer.run(async (dataDir) => {
				await this._ensureDirectories(dataDir);
				const summaryPath = this._safePath(join(dataDir, 'summaries'), sessionId, 100);
				if (summaries.length === 0) {
					await this._unlinkIfPresent(summaryPath);
					return;
				}
				const sorted = [...summaries].sort((left, right) => left.createdAt - right.createdAt);
				await this._writer.publish(summaryPath, JSON.stringify(sorted, null, 2));
			});
		});
	}

	public async loadSummaries(sessionId: SessionId): Promise<Summary[]> {
		return await this._measure('load_summaries', async () => {
			return await this._writer.run(async (dataDir) => {
				const summaries =
					(await this._loadArray<Summary>(
						this._safePath(join(dataDir, 'summaries'), sessionId, 100),
						SummaryArraySchema,
						'summaries'
					)) ?? [];
				return summaries.sort((left, right) => left.createdAt - right.createdAt);
			});
		});
	}

	private _recordOperationDuration(operation: string, startTime: number): void {
		const durationSeconds = (Date.now() - startTime) / 1000;
		this._metrics?.histogram('persistence_op_duration_seconds', durationSeconds, { operation });
	}

	private async _measure<T>(operation: string, action: () => Promise<T>): Promise<T> {
		const startTime = Date.now();
		try {
			return await action();
		} finally {
			this._recordOperationDuration(operation, startTime);
		}
	}

	private async _ensureDirectories(dataDir: string): Promise<void> {
		if (this._persistBranches) {
			await mkdir(join(dataDir, 'branches'), { recursive: true });
		}
		await mkdir(join(dataDir, 'edges'), { recursive: true });
		await mkdir(join(dataDir, 'summaries'), { recursive: true });
	}

	private _safePath(directory: string, id: string, maxLength: number): string {
		const validIdPattern = new RegExp(`^[a-zA-Z0-9_-]{1,${maxLength}}$`);
		if (!validIdPattern.test(id)) {
			throw new ValidationError(
				'persistenceId',
				`must be 1-${maxLength} alphanumeric characters, hyphens, or underscores only`
			);
		}
		const resolved = resolve(directory, `${id}.json`);
		if (!resolved.startsWith(`${resolve(directory)}${sep}`)) {
			throw new ValidationError('persistenceId', 'path traversal detected');
		}
		return resolved;
	}

	private async _loadArray<T>(
		path: string,
		schema: v.GenericSchema<unknown, unknown[]>,
		metricFile: string
	): Promise<T[] | undefined> {
		let content: string;
		try {
			content = await readFile(path, 'utf-8');
		} catch (error) {
			if (isFileNotFound(error)) {
				return undefined;
			}
			throw error;
		}

		try {
			const raw: unknown = JSON.parse(content);
			return v.parse(schema, raw) as unknown as T[];
		} catch (error) {
			this._metrics?.counter('persistence_validation_errors', 1, { file: metricFile });
			throw new PersistenceCorruptionError(path, error);
		}
	}

	private async _unlinkIfPresent(path: string): Promise<void> {
		try {
			await unlink(path);
		} catch (error) {
			if (!isFileNotFound(error)) {
				throw error;
			}
		}
	}

	private async _clearJsonFiles(directory: string): Promise<void> {
		let files: string[];
		try {
			files = await readdir(directory);
		} catch (error) {
			if (isFileNotFound(error)) {
				return;
			}
			throw error;
		}
		for (const file of files) {
			if (file.endsWith('.json')) {
				await unlink(join(directory, file));
			}
		}
	}

	private async _listJsonIds(directory: string): Promise<string[]> {
		try {
			const files = await readdir(directory);
			return files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5));
		} catch (error) {
			if (isFileNotFound(error)) {
				return [];
			}
			throw new PersistenceCorruptionError(directory, error);
		}
	}
}
