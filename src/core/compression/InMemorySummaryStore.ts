/**
 * InMemorySummaryStore — in-memory implementation of {@link ISummaryStore}.
 *
 * Stores compressed thought summaries in three indexes for O(1) point lookups
 * and O(n) bucket reads (n = result size). Per-session and per-branch isolation
 * is enforced by maintaining independent buckets keyed by session and
 * `${sessionId}:${branchId}`.
 *
 * The store is intentionally synchronous and pure in-memory — no I/O. Persistence
 * adapters may wrap this implementation if durability is required.
 *
 * @module core/compression/InMemorySummaryStore
 */

import { SequentialThinkingError } from '../../errors.js';
import type { ISummaryStore, Summary } from '../../contracts/summary.js';
import {
	asBranchId,
	asSessionId,
	asSummaryId,
	type BranchId,
	type SessionId,
	type SummaryId,
} from '../../contracts/ids.js';

/**
 * Compose the composite branch key used by the per-branch index.
 *
 * The colon separator mirrors namespace conventions in the rest of the codebase
 * and is safe because session/branch ids are constrained to alphanumeric,
 * hyphen and underscore characters.
 */
function branchKey(sessionId: SessionId, branchId: BranchId): BranchId {
	return asBranchId(`${sessionId}:${branchId}`);
}

/**
 * In-memory implementation of {@link ISummaryStore}.
 *
 * Maintains three indexes:
 * - `_byId`: id → summary (global lookup)
 * - `_bySession`: sessionId → summaries[] (sorted by `createdAt` ascending)
 * - `_byBranch`: `${sessionId}:${branchId}` → summaries[] (sorted by `createdAt`)
 *
 * @example
 * ```typescript
 * const store = new InMemorySummaryStore();
 * store.add({
 *   id: '01HX...',
 *   sessionId: 's1',
 *   rootThoughtId: 't5',
 *   coveredIds: ['t5', 't6'],
 *   coveredRange: [5, 6],
 *   topics: ['cache', 'lookup'],
 *   aggregateConfidence: 0.8,
 *   createdAt: Date.now(),
 * });
 * const all = store.forSession('s1');
 * ```
 */
export class InMemorySummaryStore implements ISummaryStore {
	private readonly _byId: Map<SummaryId, Summary> = new Map();
	private readonly _bySession: Map<SessionId, Summary[]> = new Map();
	private readonly _byBranch: Map<BranchId, Summary[]> = new Map();

	/**
	 * Add a summary to the store.
	 *
	 * Inserts the summary into all three indexes, maintaining ascending
	 * `createdAt` order in the per-session and per-branch buckets via binary
	 * search insertion (O(log n)).
	 *
	 * @param summary - The summary record to add
	 * @throws {SequentialThinkingError} When a summary with the same id already exists
	 *
	 * @example
	 * ```typescript
	 * store.add(summary);
	 * ```
	 */
	add(summary: Summary): void {
		if (this._byId.has(asSummaryId(summary.id))) {
			throw new SequentialThinkingError(`Duplicate summary id: ${summary.id}`, 'DUPLICATE_SUMMARY');
		}

		this._byId.set(asSummaryId(summary.id), summary);
		this._insertSorted(this._bySession, summary.sessionId, summary);
		if (summary.branchId !== undefined) {
			this._insertSorted(
				this._byBranch,
				branchKey(asSessionId(summary.sessionId), summary.branchId),
				summary
			);
		}
	}

	/**
	 * Retrieve a summary by its unique id.
	 *
	 * @param id - The summary's unique identifier
	 * @returns The summary, or `undefined` if not found
	 *
	 * @example
	 * ```typescript
	 * const s = store.get('01HX...');
	 * ```
	 */
	get(id: string): Summary | undefined {
		return this._byId.get(asSummaryId(id));
	}

	/**
	 * Get all summaries for a session, sorted by `createdAt` ascending.
	 *
	 * @param sessionId - Session to query
	 * @returns Read-only array of summaries (empty if none)
	 *
	 * @example
	 * ```typescript
	 * for (const s of store.forSession('s1')) console.log(s.topics);
	 * ```
	 */
	forSession(sessionId: string): readonly Summary[] {
		return this._bySession.get(asSessionId(sessionId)) ?? [];
	}

	/**
	 * Get all summaries on a specific branch within a session.
	 *
	 * @param sessionId - Session to query
	 * @param branchId - Branch identifier
	 * @returns Read-only array of summaries (empty if none)
	 *
	 * @example
	 * ```typescript
	 * const branch = store.forBranch('s1', 'alt-1');
	 * ```
	 */
	forBranch(sessionId: string, branchId: BranchId): readonly Summary[] {
		return this._byBranch.get(branchKey(asSessionId(sessionId), branchId)) ?? [];
	}

	/**
	 * Remove all summaries for a session. Other sessions are unaffected.
	 *
	 * Removes entries from all three indexes in a single pass over the
	 * session's summary list.
	 *
	 * @param sessionId - Session to clear
	 *
	 * @example
	 * ```typescript
	 * store.clearSession('s1');
	 * ```
	 */
	clearSession(sessionId: string): void {
		const summaries = this._bySession.get(asSessionId(sessionId));
		if (!summaries) {
			return;
		}

		for (const summary of summaries) {
			this._byId.delete(asSummaryId(summary.id));
			if (summary.branchId !== undefined) {
				this._byBranch.delete(branchKey(asSessionId(sessionId), summary.branchId));
			}
		}
		this._bySession.delete(asSessionId(sessionId));
	}

	clearAll(): void {
		this._byId.clear();
		this._bySession.clear();
		this._byBranch.clear();
	}

	/**
	 * Count summaries.
	 *
	 * @param sessionId - If provided, count for that session only;
	 *   otherwise return the total across all sessions
	 * @returns The number of summaries
	 *
	 * @example
	 * ```typescript
	 * const total = store.size();
	 * const perSession = store.size('s1');
	 * ```
	 */
	size(sessionId?: string): number {
		if (sessionId !== undefined) {
			return this._bySession.get(asSessionId(sessionId))?.length ?? 0;
		}
		return this._byId.size;
	}

	/**
	 * Insert a summary into a bucket maintaining ascending `createdAt` order
	 * via binary search (O(log n) search, O(n) splice).
	 */
	private _insertSorted<K>(index: Map<K, Summary[]>, key: K, summary: Summary): void {
		let bucket = index.get(key);
		if (!bucket) {
			bucket = [];
			index.set(key, bucket);
		}

		let lo = 0;
		let hi = bucket.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (bucket[mid]!.createdAt <= summary.createdAt) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		bucket.splice(lo, 0, summary);
	}
}
