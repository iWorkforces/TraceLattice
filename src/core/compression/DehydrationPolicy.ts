/**
 * DehydrationPolicy — sliding-window history compaction.
 *
 * Replaces older thoughts (the "cold" prefix beyond the most recent K) with
 * lightweight {@link SummaryRef} placeholders that point to existing
 * {@link Summary} records in an {@link ISummaryStore}. Recent thoughts (the
 * "hot" suffix of length K) are preserved verbatim.
 *
 * Pure and **non-mutating**: the input history array is never modified, and
 * neither the summary store nor any thought record is altered. When a cold
 * thought has no matching summary, the original {@link ThoughtData} is emitted
 * unchanged. Consecutive cold thoughts listed in the same summary's stable
 * `coveredIds` are deduplicated to a single `SummaryRef`.
 *
 * @module core/compression/DehydrationPolicy
 */

import type { ISummaryStore, Summary } from '../../contracts/summary.js';
import type { ThoughtData } from '../thought.js';
import type { SessionId, ThoughtId } from '../../contracts/ids.js';

/** Default value for {@link DehydrationOptions.keepLastK}. */
const DEFAULT_KEEP_LAST_K = 50;

/** Options controlling sliding-window dehydration. */
export interface DehydrationOptions {
	/**
	 * Number of most-recent thoughts to keep verbatim ("hot" window).
	 * Older thoughts (the "cold" prefix) are eligible for replacement by
	 * summary references.
	 * @default 50
	 */
	readonly keepLastK?: number;
}

/**
 * Lightweight reference replacing one or more cold thoughts covered by a
 * {@link Summary}. Carries only the summary id and the inclusive
 * `thought_number` range it covers.
 */
export interface SummaryRef {
	readonly kind: 'summary';
	readonly summaryId: string;
	readonly coveredRange: readonly [number, number];
}

/** Output entry in a dehydrated history: either a verbatim thought or a ref. */
export type HydratedEntry = ThoughtData | SummaryRef;

/**
 * Sliding-window dehydration policy.
 *
 * @example
 * ```typescript
 * const policy = new DehydrationPolicy(summaryStore);
 * const hydrated = policy.apply(history, sessionId, { keepLastK: 50 });
 * ```
 */
export class DehydrationPolicy {
	constructor(private readonly _summaryStore: ISummaryStore) {}

	/**
	 * Apply sliding-window dehydration to a history array.
	 *
	 * Returns a new array of `(ThoughtData | SummaryRef)` where:
	 * - The last `keepLastK` thoughts are preserved verbatim.
	 * - Older thoughts whose stable `id` appears in an existing summary's
	 *   `coveredIds` are replaced by a single {@link SummaryRef}.
	 * - Consecutive cold thoughts covered by the same summary collapse to one
	 *   `SummaryRef`.
	 * - Cold thoughts with no matching summary are emitted verbatim.
	 *
	 * Non-mutating: the input array is not modified and original thoughts are
	 * never altered.
	 *
	 * @param history - Input history (chronological)
	 * @param sessionId - Session whose summaries should be considered
	 * @param opts - Optional dehydration options
	 * @returns A new array of hydrated entries
	 */
	apply(
		history: readonly ThoughtData[],
		sessionId: SessionId,
		opts?: DehydrationOptions
	): HydratedEntry[] {
		const k = opts?.keepLastK ?? DEFAULT_KEEP_LAST_K;
		if (history.length === 0) return [];
		if (history.length <= k) return history.slice();

		const splitAt = history.length - k;
		const cold = history.slice(0, splitAt);
		const hot = history.slice(splitAt);

		const summaries = this._summaryStore.forSession(sessionId);
		const out: HydratedEntry[] = [];
		let lastEmittedSummaryId: string | undefined;

		for (const thought of cold) {
			const match =
				thought.id === undefined ? undefined : findCoveringSummary(summaries, thought.id);
			if (match === undefined) {
				out.push(thought);
				lastEmittedSummaryId = undefined;
				continue;
			}
			if (match.id === lastEmittedSummaryId) continue;
			out.push({
				kind: 'summary',
				summaryId: match.id,
				coveredRange: match.coveredRange,
			});
			lastEmittedSummaryId = match.id;
		}

		for (const t of hot) out.push(t);
		return out;
	}
}

/**
 * Find the first summary whose stable `coveredIds` includes the thought.
 * Returns `undefined` when none match.
 */
function findCoveringSummary(
	summaries: readonly Summary[],
	thoughtId: ThoughtId
): Summary | undefined {
	for (const s of summaries) {
		if (s.coveredIds.includes(thoughtId)) return s;
	}
	return undefined;
}
