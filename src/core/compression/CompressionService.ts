/**
 * CompressionService — deterministic branch summarization.
 *
 * Compresses a terminated branch (or any subtree rooted at a thought) into a
 * single {@link Summary} record. Pure offline computation: no LLM, no I/O.
 *
 * Topic extraction is unigram frequency with stopword filtering; aggregate
 * confidence is the arithmetic mean of per-thought calibrated (or raw)
 * confidence values. The covered set is identified via
 * {@link GraphView.descendants}. Compression is **additive**: original
 * thoughts are never mutated or deleted.
 *
 * @module core/compression/CompressionService
 */

import type { ISummaryStore, Summary } from '../../contracts/summary.js';
import type { IEdgeStore } from '../../contracts/interfaces.js';
import type { Logger } from '../../logger/StructuredLogger.js';
import type { IHistoryManager } from '../IHistoryManager.js';
import type { ThoughtData } from '../thought.js';
import type { ConfidenceSignals } from '../reasoning.js';
import { GraphView } from '../graph/GraphView.js';
import { generateUlid } from '../ids.js';
import type { BranchId, SessionId, ThoughtId } from '../../contracts/ids.js';

/** Stopwords excluded from topic extraction (lowercase). */
const STOPWORDS: ReadonlySet<string> = new Set([
	'the', 'this', 'that', 'then', 'than', 'with', 'from', 'have', 'will', 'been',
	'they', 'them', 'their', 'there', 'about', 'would', 'could', 'should', 'which',
	'where', 'when', 'what', 'some', 'into', 'also', 'just', 'like', 'over', 'such',
	'after', 'only', 'most', 'very', 'much', 'well', 'even', 'still', 'since',
	'being', 'doing', 'going', 'using',
]);

const MIN_TOKEN_LENGTH = 4;
const TOP_TOPICS = 3;

/** Local view of {@link ThoughtData} that exposes optional confidence signals. */
type ThoughtWithSignals = ThoughtData & { readonly confidence_signals?: ConfidenceSignals };

/** Dependencies required by {@link CompressionService}. */
export interface CompressionDeps {
	readonly historyManager: IHistoryManager;
	readonly edgeStore: IEdgeStore;
	readonly summaryStore: ISummaryStore;
	readonly onSummaryCreated?: (summary: Summary) => void;
	readonly logger?: Logger;
}

/**
 * Deterministic, offline compression of branch subtrees into {@link Summary}.
 *
 * @example
 * ```typescript
 * const svc = new CompressionService({ historyManager, edgeStore, summaryStore });
 * const summary = svc.compressBranch('s1', 'alt-1', 'thought-root');
 * ```
 */
export class CompressionService {
	private readonly _deps: CompressionDeps;
	private readonly _graph: GraphView;

	constructor(deps: CompressionDeps) {
		this._deps = deps;
		this._graph = new GraphView(deps.edgeStore);
	}

	/**
	 * Compress the subtree rooted at `rootThoughtId` into a {@link Summary}.
	 *
	 * Idempotency: if a summary for the same `(branchId, rootThoughtId)` already
	 * exists in the store, the existing summary is returned unchanged — same
	 * inputs always yield the same Summary identity.
	 */
	compressBranch(sessionId: SessionId, branchId: BranchId, rootThoughtId: ThoughtId): Summary {
		const existing = this._findExistingForRoot(sessionId, branchId, rootThoughtId);
		if (existing) return existing;

		const coveredIds = this._collectCovered(sessionId, rootThoughtId);
		const thoughts = this._lookupThoughts(sessionId, coveredIds);
		const summary: Summary = {
			id: generateUlid(),
			sessionId,
			branchId,
			rootThoughtId,
			coveredIds,
			coveredRange: this._coveredRange(thoughts),
			topics: this._extractTopics(thoughts),
			aggregateConfidence: this._meanConfidence(thoughts),
			createdAt: Date.now(),
		};

		this._deps.summaryStore.add(summary);
		this._deps.onSummaryCreated?.(summary);
		this._deps.logger?.debug('compression.branch.compressed', {
			sessionId,
			branchId,
			rootThoughtId,
			covered: coveredIds.length,
			topics: summary.topics,
		});
		return summary;
	}

	/** Look up an existing summary on this branch with a matching root. */
	private _findExistingForRoot(
		sessionId: SessionId,
		branchId: BranchId,
		rootThoughtId: ThoughtId
	): Summary | undefined {
		for (const s of this._deps.summaryStore.forBranch(sessionId, branchId)) {
			if (s.rootThoughtId === rootThoughtId) return s;
		}
		return undefined;
	}

	/** Collect the root and all of its descendants (chronological BFS). */
	private _collectCovered(sessionId: SessionId, rootThoughtId: ThoughtId): readonly ThoughtId[] {
		const descendants = this._graph.descendants(sessionId, rootThoughtId);
		return [rootThoughtId, ...descendants];
	}

	/**
	 * Resolve covered ids to {@link ThoughtData}, dropping any not found in
	 * the history (defensive — graph may reference evicted thoughts).
	 */
	private _lookupThoughts(sessionId: SessionId, coveredIds: readonly ThoughtId[]): ThoughtData[] {
		const history = this._deps.historyManager.getHistory(sessionId);
		const byId = new Map<string, ThoughtData>();
		for (const t of history) {
			if (t.id !== undefined) byId.set(t.id, t);
		}
		const out: ThoughtData[] = [];
		for (const id of coveredIds) {
			const t = byId.get(id);
			if (t) out.push(t);
		}
		return out;
	}

	/**
	 * Mean of (`calibrated_confidence` ?? `confidence` ?? 0) across covered.
	 * Returns 0 when no thoughts are covered.
	 */
	private _meanConfidence(thoughts: readonly ThoughtData[]): number {
		if (thoughts.length === 0) return 0;
		let sum = 0;
		for (const t of thoughts) {
			const withSignals = t as ThoughtWithSignals;
			const calibrated = withSignals.confidence_signals?.calibrated_confidence;
			sum += calibrated ?? t.confidence ?? 0;
		}
		return sum / thoughts.length;
	}

	/**
	 * Inclusive `[min, max]` of `thought_number` across covered thoughts.
	 * Returns `[0, 0]` when no thoughts are covered.
	 */
	private _coveredRange(thoughts: readonly ThoughtData[]): readonly [number, number] {
		if (thoughts.length === 0) return [0, 0];
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (const t of thoughts) {
			const n = t.thought_number;
			if (n < min) min = n;
			if (n > max) max = n;
		}
		return [min, max];
	}

	/**
	 * Extract top-3 unigrams by frequency from concatenated thought text.
	 * Ties broken by first-occurrence order (stable).
	 */
	private _extractTopics(thoughts: readonly ThoughtData[]): readonly string[] {
		if (thoughts.length === 0) return [];
		const counts = new Map<string, number>();
		const order = new Map<string, number>();
		let position = 0;
		for (const t of thoughts) {
			for (const raw of (t.thought ?? '').split(/\s+/)) {
				const token = this._normalizeToken(raw);
				if (token === null) continue;
				if (!counts.has(token)) order.set(token, position++);
				counts.set(token, (counts.get(token) ?? 0) + 1);
			}
		}
		if (counts.size === 0) return [];
		const entries = Array.from(counts.entries());
		entries.sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1];
			return (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0);
		});
		return entries.slice(0, TOP_TOPICS).map(([word]) => word);
	}

	/** Lowercase + strip non-alphanumerics; reject if too short or a stopword. */
	private _normalizeToken(raw: string): string | null {
		const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
		if (cleaned.length < MIN_TOKEN_LENGTH) return null;
		if (STOPWORDS.has(cleaned)) return null;
		return cleaned;
	}
}
