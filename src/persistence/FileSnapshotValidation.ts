import type { SessionId } from '../contracts/ids.js';
import { PersistenceCompatibilityError } from '../errors.js';
import type { FileSnapshotV2 } from './FileSnapshotTypes.js';
import {
	assertBranchScope,
	assertPersistableThoughtCollections,
	assertThoughtScope,
	compareCodePoint,
	compareCreatedThenId,
	type PersistedThoughtCollection,
} from './PersistenceScope.js';

function assertUniqueOrderedRecords(
	records: readonly { readonly sessionId: SessionId }[],
	sourcePath: string,
	label: string
): void {
	for (let index = 0; index < records.length; index++) {
		const current = records[index];
		const previous = records[index - 1];
		if (
			current !== undefined &&
			previous !== undefined &&
			compareCodePoint(previous.sessionId, current.sessionId) >= 0
		) {
			throw new PersistenceCompatibilityError(
				sourcePath,
				`${label} records are duplicate or out of order`
			);
		}
	}
}

function assertUniqueIds(
	values: readonly { readonly id: string }[],
	sourcePath: string,
	label: string
): void {
	const identifiers = new Set<string>();
	for (const value of values) {
		if (identifiers.has(value.id)) {
			throw new PersistenceCompatibilityError(sourcePath, `duplicate ${label} id '${value.id}'`);
		}
		identifiers.add(value.id);
	}
}

function assertSorted(
	values: readonly { readonly createdAt: number; readonly id: string }[],
	sourcePath: string,
	label: string
): void {
	for (let index = 1; index < values.length; index++) {
		const previous = values[index - 1];
		const current = values[index];
		if (
			previous !== undefined &&
			current !== undefined &&
			compareCreatedThenId(previous, current) > 0
		) {
			throw new PersistenceCompatibilityError(sourcePath, `${label} records are out of order`);
		}
	}
}

/**
 * Validates semantic invariants that are stricter than the File v2 shape schema.
 *
 * @param snapshot - Parsed or canonical File v2 snapshot.
 * @param sourcePath - Source path included in compatibility errors.
 * @returns Nothing when all snapshot invariants hold.
 *
 * @example
 * ```ts
 * validateFileSnapshotV2(snapshot, '/data/snapshot.json');
 * ```
 */
export function validateFileSnapshotV2(snapshot: FileSnapshotV2, sourcePath: string): void {
	assertUniqueOrderedRecords(snapshot.thoughts, sourcePath, 'thought');
	assertUniqueOrderedRecords(snapshot.edges, sourcePath, 'edge');
	assertUniqueOrderedRecords(snapshot.summaries, sourcePath, 'summary');
	const thoughtCollections: PersistedThoughtCollection[] = [];
	for (const record of snapshot.thoughts) {
		if (record.thoughts.length === 0)
			throw new PersistenceCompatibilityError(sourcePath, 'empty thought record');
		for (const thought of record.thoughts) {
			assertThoughtScope('saveThoughtForSession', record.sessionId, thought);
		}
		thoughtCollections.push({ sessionId: record.sessionId, thoughts: record.thoughts });
	}
	let previousBranchKey: string | undefined;
	for (const record of snapshot.branches) {
		const branchKey = `${record.sessionId}\u0000${record.branchId}`;
		if (previousBranchKey !== undefined && compareCodePoint(previousBranchKey, branchKey) >= 0) {
			throw new PersistenceCompatibilityError(
				sourcePath,
				'branch records are duplicate or out of order'
			);
		}
		previousBranchKey = branchKey;
		assertBranchScope('saveBranchForSession', record.sessionId, record.branchId, record.thoughts);
		thoughtCollections.push({ sessionId: record.sessionId, thoughts: record.thoughts });
	}
	assertPersistableThoughtCollections(thoughtCollections, sourcePath);
	for (const record of snapshot.edges) {
		if (record.edges.length === 0)
			throw new PersistenceCompatibilityError(sourcePath, 'empty edge record');
		assertUniqueIds(record.edges, sourcePath, 'edge');
		if (record.edges.some((edge) => edge.sessionId !== record.sessionId)) {
			throw new PersistenceCompatibilityError(sourcePath, 'edge session does not match its record');
		}
		assertSorted(record.edges, sourcePath, 'edge');
	}
	for (const record of snapshot.summaries) {
		if (record.summaries.length === 0)
			throw new PersistenceCompatibilityError(sourcePath, 'empty summary record');
		assertUniqueIds(record.summaries, sourcePath, 'summary');
		if (record.summaries.some((summary) => summary.sessionId !== record.sessionId)) {
			throw new PersistenceCompatibilityError(
				sourcePath,
				'summary session does not match its record'
			);
		}
		assertSorted(record.summaries, sourcePath, 'summary');
	}
}
