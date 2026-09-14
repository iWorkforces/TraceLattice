import type { Summary } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import type { ThoughtData } from '../core/thought.js';
import { PersistenceCorruptionError } from '../errors.js';
import { parseEdge, parseSummary, parseThoughtData } from './PersistenceCodec.js';

function field(row: unknown, key: string, sourcePath: string): unknown {
	if (typeof row !== 'object' || row === null || !(key in row)) {
		throw new PersistenceCorruptionError(sourcePath, new TypeError(`missing column '${key}'`));
	}
	return Object.getOwnPropertyDescriptor(row, key)?.value;
}

export function stringField(row: unknown, key: string, sourcePath: string): string {
	const value = field(row, key, sourcePath);
	if (typeof value !== 'string') {
		throw new PersistenceCorruptionError(sourcePath, new TypeError(`column '${key}' is not text`));
	}
	return value;
}

export function nullableStringField(row: unknown, key: string, sourcePath: string): string | null {
	const value = field(row, key, sourcePath);
	if (value !== null && typeof value !== 'string') {
		throw new PersistenceCorruptionError(
			sourcePath,
			new TypeError(`column '${key}' is not nullable text`)
		);
	}
	return value;
}

export function numberField(row: unknown, key: string, sourcePath: string): number {
	const value = field(row, key, sourcePath);
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new PersistenceCorruptionError(
			sourcePath,
			new TypeError(`column '${key}' is not numeric`)
		);
	}
	return value;
}

export function parseSqliteJson(json: string, sourcePath: string): unknown {
	try {
		return JSON.parse(json);
	} catch (error) {
		throw new PersistenceCorruptionError(sourcePath, error);
	}
}

export function decodeThoughtRow(row: unknown, sourcePath: string): ThoughtData {
	try {
		return parseThoughtData(
			parseSqliteJson(stringField(row, 'data', sourcePath), sourcePath),
			sourcePath
		);
	} catch (error) {
		if (error instanceof PersistenceCorruptionError) throw error;
		throw new PersistenceCorruptionError(sourcePath, error);
	}
}

export function decodeEdgeRow(row: unknown, sourcePath: string): Edge {
	const metadata = nullableStringField(row, 'metadata', sourcePath);
	try {
		return parseEdge({
			id: stringField(row, 'id', sourcePath),
			sessionId: stringField(row, 'session_id', sourcePath),
			from: stringField(row, 'from_id', sourcePath),
			to: stringField(row, 'to_id', sourcePath),
			kind: stringField(row, 'kind', sourcePath),
			createdAt: numberField(row, 'created_at', sourcePath),
			...(metadata === null ? {} : { metadata: parseSqliteJson(metadata, sourcePath) }),
		});
	} catch (error) {
		if (error instanceof PersistenceCorruptionError) throw error;
		throw new PersistenceCorruptionError(sourcePath, error);
	}
}

export function decodeSummaryRow(row: unknown, sourcePath: string): Summary {
	const branchId = nullableStringField(row, 'branch_id', sourcePath);
	const meta = nullableStringField(row, 'meta', sourcePath);
	try {
		return parseSummary(
			{
				id: stringField(row, 'id', sourcePath),
				sessionId: stringField(row, 'session_id', sourcePath),
				...(branchId === null ? {} : { branchId }),
				rootThoughtId: stringField(row, 'root_thought_id', sourcePath),
				coveredIds: parseSqliteJson(stringField(row, 'covered_ids', sourcePath), sourcePath),
				coveredRange: [
					numberField(row, 'covered_range_start', sourcePath),
					numberField(row, 'covered_range_end', sourcePath),
				],
				topics: parseSqliteJson(stringField(row, 'topics', sourcePath), sourcePath),
				aggregateConfidence: numberField(row, 'aggregate_confidence', sourcePath),
				createdAt: numberField(row, 'created_at', sourcePath),
				...(meta === null ? {} : { meta: parseSqliteJson(meta, sourcePath) }),
			},
			sourcePath
		);
	} catch (error) {
		if (error instanceof PersistenceCorruptionError) throw error;
		throw new PersistenceCorruptionError(sourcePath, error);
	}
}
