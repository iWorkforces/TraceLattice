/**
 * Summary store contract — defines the interface for persisting and querying
 * compressed thought summaries produced by the compression subsystem.
 *
 * Implementations must provide per-session isolation: summaries from one
 * session must never appear in queries scoped to another session.
 *
 * @module contracts/summary
 */

import type { Summary } from '../core/compression/Summary.js';
import type { BranchId, SessionId, SummaryId } from './ids.js';

export type { Summary };

/**
 * Storage and query contract for {@link Summary} records.
 *
 * Implementations are expected to be in-process (no I/O) and synchronous.
 * Persistence backends may wrap this interface in async adapters.
 *
 * @example
 * ```ts
 * const store: ISummaryStore = new InMemorySummaryStore();
 * store.add(summary);
 * const all = store.forSession('sess_42');
 * const branch = store.forBranch('sess_42', 'alt-1');
 * ```
 */
export interface ISummaryStore {
	/**
	 * Add a summary to the store.
	 *
	 * @param summary - The summary record to add
	 *
	 * @example
	 * ```ts
	 * store.add({ id: '01HX...', sessionId: 's1', rootThoughtId: 't5', ... });
	 * ```
	 */
	add(summary: Summary): void;

	/**
	 * Retrieve a summary by its unique id.
	 *
	 * @param id - The summary's unique identifier
	 * @returns The summary, or `undefined` if not found
	 *
	 * @example
	 * ```ts
	 * const s = store.get('01HX...');
	 * if (s) console.log(s.topics);
	 * ```
	 */
	get(id: SummaryId): Summary | undefined;

	/**
	 * Get all summaries for a session, in insertion order.
	 *
	 * @param sessionId - Session to query
	 * @returns Read-only array of summaries (may be empty)
	 *
	 * @example
	 * ```ts
	 * for (const s of store.forSession('sess_42')) {
	 *   console.log(s.coveredRange);
	 * }
	 * ```
	 */
	forSession(sessionId: SessionId): readonly Summary[];

	/**
	 * Get all summaries for a specific branch within a session.
	 *
	 * @param sessionId - Session to query
	 * @param branchId - Branch identifier to filter by
	 * @returns Read-only array of summaries on that branch (may be empty)
	 *
	 * @example
	 * ```ts
	 * const altSummaries = store.forBranch('sess_42', 'alt-1');
	 * ```
	 */
	forBranch(sessionId: SessionId, branchId: BranchId): readonly Summary[];

	/**
	 * Remove all summaries for a session. Other sessions are unaffected.
	 *
	 * @param sessionId - Session to clear
	 *
	 * @example
	 * ```ts
	 * store.clearSession('sess_42');
	 * ```
	 */
	clearSession(sessionId: SessionId): void;

	/**
	 * Discard summaries from every session namespace.
	 * Use only for a trusted process-wide reset; scoped callers must use `clearSession`.
	 */
	clearAll(): void;

	/**
	 * Count summaries.
	 *
	 * @param sessionId - If provided, count for that session only;
	 *   otherwise return the total across all sessions
	 * @returns The number of summaries
	 *
	 * @example
	 * ```ts
	 * const total = store.size();
	 * const perSession = store.size('sess_42');
	 * ```
	 */
	size(sessionId?: SessionId): number;
}
