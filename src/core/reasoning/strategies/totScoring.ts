/**
 * Tree-of-Thought scoring helpers — pure functions for ranking and frontier
 * exploration over the thought DAG.
 *
 * This module exposes three primitives used by the ToT strategy:
 *
 * - {@link scoreThought}: combine confidence and quality into a [0, 1] score.
 * - {@link selectBeam}: pick the top-K candidates with deterministic tiebreaks.
 * - {@link breadthFirstFrontier}: BFS from roots, returning leaves of the
 *   explored subgraph capped by depth.
 *
 * All functions are pure: no I/O, no mutable module state, no DI.
 *
 * @module core/reasoning/strategies/totScoring
 */

import type { ThoughtData } from '../../thought.js';
import type { ThoughtType } from '../../../contracts/reasoning-types.js';
import type { ConfidenceSignals } from '../../reasoning.js';
import type { GraphView } from '../../graph/GraphView.js';
import type { SessionId, ThoughtId } from '../../../contracts/ids.js';
import { assertNever } from '../../../utils.js';

/**
 * Optional `confidence_signals` carried alongside a thought. The core
 * `ThoughtData` type does not declare this field, but evaluator output may
 * be attached by callers that want calibrated scoring.
 */
type ThoughtWithSignals = ThoughtData & {
	readonly confidence_signals?: ConfidenceSignals;
};

/**
 * A scored candidate suitable for {@link selectBeam}.
 */
export interface ScoredCandidate {
	readonly id: string;
	readonly score: number;
}

/**
 * Per-type score multiplier applied on top of the base confidence×quality score.
 *
 * Weights bias the ToT frontier towards productive thought kinds:
 * - `assumption` (0.5): low confidence until backed by verification.
 * - `decomposition` (1.2): encouraged for problem-splitting.
 * - `backtrack` (0.8): signals exploration but not preferred.
 * - `tool_call` / `tool_observation` (1.0): neutral exogenous information.
 * - All other types (regular, hypothesis, verification, critique, synthesis, meta): 1.0.
 *
 * Pure function: deterministic, no I/O.
 */
function getTypeWeight(type: ThoughtType | undefined): number {
	if (type === undefined) return 1.0;
	switch (type) {
		case 'assumption':
			return 0.5;
		case 'decomposition':
			return 1.2;
		case 'backtrack':
			return 0.8;
		case 'tool_call':
			return 1.0;
		case 'tool_observation':
			return 1.0;
		case 'regular':
		case 'hypothesis':
		case 'verification':
		case 'critique':
		case 'synthesis':
		case 'meta':
			return 1.0;
		default:
			return assertNever(type);
	}
}

/**
 * Score a thought by combining its (calibrated) confidence with its
 * self-assessed quality, then applying a per-type weight.
 *
 * Formula: `(calibrated_confidence ?? confidence ?? 0) * (quality_score ?? 0.5) * typeWeight(thought_type)`
 *
 * The `calibrated_confidence` (when present on `confidence_signals`) is
 * preferred over the raw `confidence` field. The result is clamped to the
 * inclusive range `[0, 1]`.
 *
 * @param t - The thought to score.
 * @returns A score in `[0, 1]`.
 *
 * @example
 * ```typescript
 * const s = scoreThought({ ...base, confidence: 0.8, quality_score: 0.5 });
 * // s === 0.4
 * ```
 */
export function scoreThought(t: ThoughtData): number {
	const calibrated = (t as ThoughtWithSignals).confidence_signals?.calibrated_confidence;
	const confidence = calibrated ?? t.confidence ?? 0;
	const quality = t.quality_score ?? 0.5;
	const raw = confidence * quality * getTypeWeight(t.thought_type);
	if (raw < 0) return 0;
	if (raw > 1) return 1;
	return raw;
}

/**
 * Select the top-`width` candidates by score, descending.
 *
 * Sorting is stable and deterministic: ties on `score` are broken by
 * lexicographic comparison of `id` (ascending). When `width >= candidates.length`
 * all candidates are returned in sorted order. When `width <= 0` the result
 * is empty.
 *
 * @param candidates - Scored candidates (input is not mutated).
 * @param width - Beam width (top-K).
 * @returns Selected ids in descending score order.
 *
 * @example
 * ```typescript
 * const top = selectBeam([{ id: 'a', score: 0.1 }, { id: 'b', score: 0.9 }], 1);
 * // top === ['b']
 * ```
 */
export function selectBeam(
	candidates: readonly ScoredCandidate[],
	width: number
): readonly string[] {
	if (width <= 0 || candidates.length === 0) {
		return [];
	}
	const sorted = [...candidates].sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.id < b.id ? -1 : 1;
	});
	const k = width >= sorted.length ? sorted.length : width;
	const result: string[] = [];
	for (let i = 0; i < k; i++) {
		result.push(sorted[i]!.id);
	}
	return result;
}

/**
 * Compute the BFS frontier reachable from `roots` within `depthCap` levels.
 *
 * Traverses outgoing edges via `graph.descendants(sessionId, id, 1)`. The returned
 * set contains the *leaves* of the explored subgraph — nodes that either
 * (a) sit at the depth cap, or (b) have no outgoing edges within the
 * explored region.
 *
 * Special cases:
 * - `depthCap === 0` returns the unique roots in input order.
 * - empty `roots` returns an empty array.
 *
 * Each node is visited at most once, so cycles cannot cause infinite loops.
 *
 * @param graph - Read-only graph view.
 * @param sessionId - Session scoping the traversal.
 * @param roots - Starting thought ids.
 * @param depthCap - Maximum BFS depth (0 = roots only).
 * @returns Frontier (leaf) thought ids of the explored subgraph.
 *
 * @example
 * ```typescript
 * const frontier = breadthFirstFrontier(view, 's1', ['root'], 2);
 * ```
 */
export function breadthFirstFrontier(
	graph: GraphView,
	sessionId: SessionId,
	roots: readonly string[],
	depthCap: number
): readonly string[] {
	if (roots.length === 0) {
		return [];
	}
	const uniqueRoots: string[] = [];
	const seenRoots = new Set<string>();
	for (const r of roots) {
		if (!seenRoots.has(r)) {
			seenRoots.add(r);
			uniqueRoots.push(r);
		}
	}
	if (depthCap <= 0) {
		return uniqueRoots;
	}

	const visited = new Set<string>(uniqueRoots);
	let frontier: string[] = [...uniqueRoots];
	let depth = 0;

	while (frontier.length > 0 && depth < depthCap) {
		const next: string[] = [];
		for (const node of frontier) {
			for (const child of graph.descendants(sessionId, node as ThoughtId, 1)) {
				if (visited.has(child)) continue;
				visited.add(child);
				next.push(child);
			}
		}
		frontier = next;
		depth++;
	}

	const explored = visited;
	const leaves: string[] = [];
	const seenLeaf = new Set<string>();
	const collect = (id: string): void => {
		seenLeaf.add(id);
		leaves.push(id);
	};

	if (depth >= depthCap && frontier.length > 0) {
		// Hit the depth cap — current frontier is leaves regardless of children.
		for (const id of frontier) collect(id);
	}
	// Any explored node with no outgoing edges inside the explored set is also
	// a leaf (covers nodes shallower than depthCap that terminated naturally).
	for (const id of explored) {
		if (seenLeaf.has(id)) continue;
		const children = graph.descendants(sessionId, id as ThoughtId, 1);
		if (children.length === 0) collect(id);
	}
	return leaves;
}
