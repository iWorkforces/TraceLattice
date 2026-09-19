/**
 * Tests for the GraphView read-only graph traversal.
 */

import { describe, it, expect } from 'vitest';
import { EdgeStore } from '../../../core/graph/EdgeStore.js';
import { GraphView } from '../../../core/graph/GraphView.js';
import { generateUlid } from '../../../core/ids.js';
import { CycleDetectedError } from '../../../errors.js';
import type { Edge, EdgeKind } from '../../../core/graph/Edge.js';
import { asSessionId, asThoughtId, type EdgeId, type SessionId } from '../../../contracts/ids.js';

const SESSION: SessionId = asSessionId('s1');

function makeEdge(
	from: string,
	to: string,
	createdAt: number,
	kind: EdgeKind = 'sequence',
	sessionId: SessionId = SESSION
): Edge {
	return {
		id: generateUlid() as EdgeId,
		from: asThoughtId(from),
		to: asThoughtId(to),
		kind,
		sessionId,
		createdAt,
	};
}

function setup(edges: Edge[]): GraphView {
	const store = new EdgeStore();
	for (const edge of edges) {
		store.addEdge(edge);
	}
	return new GraphView(store);
}

const ALL_EDGE_KINDS: readonly EdgeKind[] = [
	'sequence',
	'branch',
	'merge',
	'verifies',
	'critiques',
	'derives_from',
	'tool_invocation',
	'revises',
];

describe('GraphView', () => {
	describe('chronological', () => {
		it('returns empty array when session has no edges', () => {
			const view = setup([]);
			expect(view.chronological(asSessionId('empty'))).toEqual([]);
		});

		it('returns thoughts ordered by BFS from roots following createdAt', () => {
			// a -> b -> c, a -> d
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('a', 'd', 300),
			];
			const view = setup(edges);
			const result = view.chronological(SESSION);
			// roots first (a), then BFS by createdAt
			expect(result[0]).toBe('a');
			expect(result).toContain('b');
			expect(result).toContain('c');
			expect(result).toContain('d');
			expect(result).toHaveLength(4);
			// b appears before c (since c depends on b)
			expect(result.indexOf(asThoughtId('b'))).toBeLessThan(result.indexOf(asThoughtId('c')));
		});

		it('handles disconnected components with multiple roots', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('x', 'y', 50)];
			const view = setup(edges);
			const result = view.chronological(SESSION);
			expect(result).toHaveLength(4);
			expect(result).toEqual(expect.arrayContaining(['a', 'b', 'x', 'y']));
		});
	});

	describe('branchThoughts', () => {
		it('returns thoughts reachable via branch edges from root', () => {
			const edges = [
				makeEdge('root', 'b1', 100, 'branch'),
				makeEdge('b1', 'b2', 200, 'branch'),
				makeEdge('root', 'seq', 150, 'sequence'),
			];
			const view = setup(edges);
			const result = view.branchThoughts(SESSION, asThoughtId('root'));
			expect(result).toEqual(expect.arrayContaining(['root', 'b1', 'b2']));
			expect(result).not.toContain('seq');
		});

		it('returns just the root id when no branch edges exist', () => {
			const edges = [makeEdge('root', 'x', 100, 'sequence')];
			const view = setup(edges);
			expect(view.branchThoughts(SESSION, asThoughtId('root'))).toEqual(['root']);
		});
	});

	describe('topological', () => {
		it('returns valid topological order for a DAG', () => {
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('a', 'c', 150),
			];
			const view = setup(edges);
			const result = view.topological(SESSION);
			expect(result).toHaveLength(3);
			expect(result.indexOf(asThoughtId('a'))).toBeLessThan(result.indexOf(asThoughtId('b')));
			expect(result.indexOf(asThoughtId('b'))).toBeLessThan(result.indexOf(asThoughtId('c')));
			expect(result.indexOf(asThoughtId('a'))).toBeLessThan(result.indexOf(asThoughtId('c')));
		});

		it('throws CycleDetectedError on cycle', () => {
			// EdgeStore allows non-self cycles: a->b->a
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'a', 200)];
			const view = setup(edges);
			expect(() => view.topological(SESSION)).toThrow(CycleDetectedError);
		});

		it('returns empty array when session has no edges', () => {
			const view = setup([]);
			expect(view.topological(asSessionId('nope'))).toEqual([]);
		});
	});

	describe('ancestors', () => {
		it('returns all ancestors via incoming closure (BFS)', () => {
			// a -> b -> c -> d
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('c', 'd', 300),
			];
			const view = setup(edges);
			const result = view.ancestors(SESSION, asThoughtId('d'));
			expect(result).toEqual(expect.arrayContaining(['a', 'b', 'c']));
			expect(result).not.toContain('d');
		});

		it('respects maxDepth parameter', () => {
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('c', 'd', 300),
			];
			const view = setup(edges);
			const result = view.ancestors(SESSION, asThoughtId('d'), 1);
			expect(result).toEqual(['c']);
		});

		it('returns empty when no ancestors', () => {
			const edges = [makeEdge('a', 'b', 100)];
			const view = setup(edges);
			expect(view.ancestors(SESSION, asThoughtId('a'))).toEqual([]);
		});
	});

	describe('descendants', () => {
		it('returns all descendants via outgoing closure (BFS)', () => {
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('c', 'd', 300),
			];
			const view = setup(edges);
			const result = view.descendants(SESSION, asThoughtId('a'));
			expect(result).toEqual(expect.arrayContaining(['b', 'c', 'd']));
			expect(result).not.toContain('a');
		});

		it('respects maxDepth parameter', () => {
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('c', 'd', 300),
			];
			const view = setup(edges);
			const result = view.descendants(SESSION, asThoughtId('a'), 2);
			expect(result).toEqual(expect.arrayContaining(['b', 'c']));
			expect(result).not.toContain('d');
		});

		it('handles cycles without infinite loop', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'a', 200)];
			const view = setup(edges);
			const result = view.descendants(SESSION, asThoughtId('a'));
			expect(result).toEqual(expect.arrayContaining(['b']));
		});
	});

	describe('leaves', () => {
		it('returns thoughts with no outgoing edges', () => {
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('a', 'c', 200),
				makeEdge('b', 'd', 300),
			];
			const view = setup(edges);
			const result = view.leaves(SESSION);
			// c and d have no outgoing
			expect(result).toEqual(expect.arrayContaining(['c', 'd']));
			expect(result).not.toContain('a');
			expect(result).not.toContain('b');
		});

		it('returns empty for empty session', () => {
			const view = setup([]);
			expect(view.leaves(asSessionId('nope'))).toEqual([]);
		});
	});

	describe('depthFromRoots', () => {
		it('counts every edge kind from a zero-incoming root', () => {
			// Given
			const edges = ALL_EDGE_KINDS.map((kind, index) =>
				makeEdge(`t${index}`, `t${index + 1}`, index, kind)
			);
			const view = setup(edges);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('t8'));

			// Then
			expect(distance).toBe(8);
		});

		it('assigns depth zero to a root', () => {
			// Given
			const view = setup([makeEdge('root', 'child', 1)]);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('root'));

			// Then
			expect(distance).toBe(0);
		});

		it('chooses the shortest path across multiple roots and a merge', () => {
			// Given
			const view = setup([
				makeEdge('long-root', 'a', 1),
				makeEdge('a', 'b', 2),
				makeEdge('b', 'current', 3, 'merge'),
				makeEdge('short-root', 'current', 4, 'merge'),
			]);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('current'));

			// Then
			expect(distance).toBe(1);
		});

		it('treats a retained node as a new root after pruning removes its parent', () => {
			// Given
			const store = new EdgeStore();
			store.addEdge(makeEdge('evicted', 'retained-root', 1));
			store.addEdge(makeEdge('retained-root', 'current', 2));
			store.pruneSession(
				SESSION,
				new Set([asThoughtId('retained-root'), asThoughtId('current')])
			);
			const view = new GraphView(store);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('current'));

			// Then
			expect(distance).toBe(1);
		});

		it('finds a root-reachable node despite a cycle', () => {
			// Given
			const view = setup([
				makeEdge('root', 'a', 1),
				makeEdge('a', 'b', 2),
				makeEdge('b', 'a', 3),
				makeEdge('b', 'current', 4),
			]);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('current'));

			// Then
			expect(distance).toBe(3);
		});

		it.each([
			['an empty graph', [], 'missing'],
			['a rootless cycle', [makeEdge('a', 'b', 1), makeEdge('b', 'a', 2)], 'a'],
		] as const)('returns undefined for %s', (_label, edges, target) => {
			// Given
			const view = setup([...edges]);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId(target));

			// Then
			expect(distance).toBeUndefined();
		});

		it('keeps root distance isolated by session', () => {
			// Given
			const otherSession = asSessionId('s2');
			const view = setup([
				makeEdge('root', 'current', 1),
				makeEdge('other-root', 'other-current', 2, 'sequence', otherSession),
			]);

			// When
			const localDistance = view.depthFromRoots(SESSION, asThoughtId('current'));
			const foreignDistance = view.depthFromRoots(SESSION, asThoughtId('other-current'));

			// Then
			expect(localDistance).toBe(1);
			expect(foreignDistance).toBeUndefined();
		});
	});

	describe('session isolation', () => {
		it('does not leak across sessions', () => {
			const edges = [
				makeEdge('a', 'b', 100, 'sequence', asSessionId('s1')),
				makeEdge('x', 'y', 200, 'sequence', asSessionId('s2')),
			];
			const view = setup(edges);
			expect(view.chronological(asSessionId('s1'))).toEqual(expect.arrayContaining(['a', 'b']));
			expect(view.chronological(asSessionId('s1'))).not.toContain('x');
			expect(view.descendants(asSessionId('s1'), asThoughtId('x'))).toEqual([]);
		});
	});

	describe('multi-node cycle detection', () => {
		it('throws CycleDetectedError on 3-node cycle a->b->c->b', () => {
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('c', 'b', 300),
			];
			const view = setup(edges);
			expect(() => view.topological(SESSION)).toThrow(CycleDetectedError);
		});

		it('throws CycleDetectedError on 4-node mixed-edge-kind cycle', () => {
			const edges = [
				makeEdge('a', 'b', 100, 'sequence'),
				makeEdge('b', 'c', 200, 'derives_from'),
				makeEdge('c', 'd', 300, 'verifies'),
				makeEdge('d', 'a', 400, 'critiques'),
			];
			const view = setup(edges);
			expect(() => view.topological(SESSION)).toThrow(CycleDetectedError);
		});

		it('throws CycleDetectedError on cycle formed by merge edges', () => {
			const edges = [
				makeEdge('a', 'b', 100, 'sequence'),
				makeEdge('b', 'c', 200, 'merge'),
				makeEdge('c', 'a', 300, 'merge'),
			];
			const view = setup(edges);
			expect(() => view.topological(SESSION)).toThrow(CycleDetectedError);
		});

		it('descendants() terminates on 3-node cycle and visits each node at most once', () => {
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('c', 'b', 300),
			];
			const view = setup(edges);
			const result = view.descendants(SESSION, asThoughtId('a'));
			expect(result).toEqual(expect.arrayContaining(['b', 'c']));
			expect(result).not.toContain('a');
			// Each visited at most once: no duplicates
			expect(new Set(result).size).toBe(result.length);
		});

		it('ancestors() terminates on 3-node cycle without infinite loop', () => {
			const edges = [
				makeEdge('a', 'b', 100),
				makeEdge('b', 'c', 200),
				makeEdge('c', 'b', 300),
			];
			const view = setup(edges);
			const result = view.ancestors(SESSION, asThoughtId('c'));
			expect(result).toEqual(expect.arrayContaining(['a', 'b']));
			expect(new Set(result).size).toBe(result.length);
		});
	});
});
