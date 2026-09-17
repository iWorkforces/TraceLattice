/**
 * Tests for the EdgeStore implementation.
 */

import { asSessionId, asThoughtId, type ThoughtId } from '../../../contracts/ids.js';
import { describe, it, expect } from 'vitest';
import { EdgeStore } from '../../../core/graph/EdgeStore.js';
import { generateUlid } from '../../../core/ids.js';
import { InvalidEdgeError } from '../../../errors.js';
import type { Edge } from '../../../core/graph/Edge.js';

function createTestEdge(
	overrides: { from: string; to: string; sessionId: string } & Partial<
		Omit<Edge, 'from' | 'to' | 'sessionId'>
	>
): Edge {
	return {
		id: generateUlid() as Edge['id'],
		kind: 'sequence',
		createdAt: Date.now(),
		...overrides,
		from: overrides.from as Edge['from'],
		to: overrides.to as Edge['to'],
		sessionId: overrides.sessionId as Edge['sessionId'],
	};
}

function retained(...ids: string[]): ReadonlySet<ThoughtId> {
	return new Set(ids.map(asThoughtId));
}

describe('EdgeStore', () => {
	describe('addEdge / getEdge', () => {
		it('addEdge stores edge retrievable via getEdge', () => {
			const store = new EdgeStore();
			const edge = createTestEdge({ from: 'a', to: 'b', sessionId: 's1' });
			store.addEdge(edge);
			expect(store.getEdge(edge.id)).toEqual(edge);
		});

		it('getEdge returns undefined for unknown id', () => {
			const store = new EdgeStore();
			expect(store.getEdge('does-not-exist')).toBeUndefined();
		});
	});

	describe('outgoing / incoming indexes', () => {
		it('addEdge stores edge in outgoing index', () => {
			const store = new EdgeStore();
			const edge = createTestEdge({ from: 'a', to: 'b', sessionId: 's1' });
			store.addEdge(edge);
			const outgoing = store.outgoing(asSessionId('s1'), 'a');
			expect(outgoing).toHaveLength(1);
			expect(outgoing[0]).toEqual(edge);
		});

		it('addEdge stores edge in incoming index', () => {
			const store = new EdgeStore();
			const edge = createTestEdge({ from: 'a', to: 'b', sessionId: 's1' });
			store.addEdge(edge);
			const incoming = store.incoming(asSessionId('s1'), 'b');
			expect(incoming).toHaveLength(1);
			expect(incoming[0]).toEqual(edge);
		});

		it('outgoing returns edges sorted by createdAt ascending', () => {
			const store = new EdgeStore();
			const e1 = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', createdAt: 300 });
			const e2 = createTestEdge({ from: 'a', to: 'c', sessionId: 's1', createdAt: 100 });
			const e3 = createTestEdge({ from: 'a', to: 'd', sessionId: 's1', createdAt: 200 });
			store.addEdge(e1);
			store.addEdge(e2);
			store.addEdge(e3);
			const outgoing = store.outgoing(asSessionId('s1'), 'a');
			expect(outgoing.map((e) => e.createdAt)).toEqual([100, 200, 300]);
		});

		it('incoming returns edges sorted by createdAt ascending', () => {
			const store = new EdgeStore();
			const e1 = createTestEdge({ from: 'a', to: 'z', sessionId: 's1', createdAt: 300 });
			const e2 = createTestEdge({ from: 'b', to: 'z', sessionId: 's1', createdAt: 100 });
			const e3 = createTestEdge({ from: 'c', to: 'z', sessionId: 's1', createdAt: 200 });
			store.addEdge(e1);
			store.addEdge(e2);
			store.addEdge(e3);
			const incoming = store.incoming(asSessionId('s1'), 'z');
			expect(incoming.map((e) => e.createdAt)).toEqual([100, 200, 300]);
		});

		it('outgoing returns empty array for unknown session', () => {
			const store = new EdgeStore();
			expect(store.outgoing(asSessionId('nope'), 'a')).toEqual([]);
		});

		it('incoming returns empty array for unknown session', () => {
			const store = new EdgeStore();
			expect(store.incoming(asSessionId('nope'), 'a')).toEqual([]);
		});

		it('outgoing returns empty array for unknown source thought', () => {
			const store = new EdgeStore();
			store.addEdge(createTestEdge({ from: 'a', to: 'b', sessionId: 's1' }));
			expect(store.outgoing(asSessionId('s1'), 'unknown')).toEqual([]);
		});
	});

	describe('validation', () => {
		it('addEdge rejects self-edge with InvalidEdgeError', () => {
			const store = new EdgeStore();
			const edge = createTestEdge({ from: 'a', to: 'a', sessionId: 's1' });
			expect(() => store.addEdge(edge)).toThrow(InvalidEdgeError);
			expect(() => store.addEdge(edge)).toThrow(/Self-edge not allowed/);
		});

		it('InvalidEdgeError has code INVALID_EDGE', () => {
			const store = new EdgeStore();
			try {
				store.addEdge(createTestEdge({ from: 'x', to: 'x', sessionId: 's1' }));
				expect.fail('expected throw');
			} catch (err) {
				expect(err).toBeInstanceOf(InvalidEdgeError);
				expect((err as InvalidEdgeError).code).toBe('INVALID_EDGE');
			}
		});
	});

	describe('deduplication', () => {
		it('addEdge dedupes identical (from, to, kind, sessionId) - no error, no duplicate', () => {
			const store = new EdgeStore();
			const first = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', kind: 'sequence' });
			const second = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', kind: 'sequence' });
			store.addEdge(first);
			store.addEdge(second);
			expect(store.size(asSessionId('s1'))).toBe(1);
			// First wins; second's id is not present.
			expect(store.getEdge(first.id)).toEqual(first);
			expect(store.getEdge(second.id)).toBeUndefined();
			expect(store.outgoing(asSessionId('s1'), 'a')).toHaveLength(1);
			expect(store.incoming(asSessionId('s1'), 'b')).toHaveLength(1);
		});

		it('addEdge allows same (from, to) with different kind', () => {
			const store = new EdgeStore();
			const e1 = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', kind: 'sequence' });
			const e2 = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', kind: 'verifies' });
			store.addEdge(e1);
			store.addEdge(e2);
			expect(store.size(asSessionId('s1'))).toBe(2);
			expect(store.outgoing(asSessionId('s1'), 'a')).toHaveLength(2);
		});

		it('addEdge allows same (from, to, kind) in different sessions', () => {
			const store = new EdgeStore();
			const e1 = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', kind: 'sequence' });
			const e2 = createTestEdge({ from: 'a', to: 'b', sessionId: 's2', kind: 'sequence' });
			store.addEdge(e1);
			store.addEdge(e2);
			expect(store.size(asSessionId('s1'))).toBe(1);
			expect(store.size(asSessionId('s2'))).toBe(1);
			expect(store.size()).toBe(2);
		});
	});

	describe('clearSession', () => {
		it("clearSession removes only that session's edges", () => {
			const store = new EdgeStore();
			store.addEdge(createTestEdge({ from: 'a', to: 'b', sessionId: 's1' }));
			store.addEdge(createTestEdge({ from: 'c', to: 'd', sessionId: 's1' }));
			store.clearSession(asSessionId('s1'));
			expect(store.size(asSessionId('s1'))).toBe(0);
			expect(store.outgoing(asSessionId('s1'), 'a')).toEqual([]);
			expect(store.incoming(asSessionId('s1'), 'b')).toEqual([]);
			expect(store.edgesForSession(asSessionId('s1'))).toEqual([]);
		});

		it('clearSession does not affect other sessions', () => {
			const store = new EdgeStore();
			const keep = createTestEdge({ from: 'x', to: 'y', sessionId: 's2' });
			store.addEdge(createTestEdge({ from: 'a', to: 'b', sessionId: 's1' }));
			store.addEdge(keep);
			store.clearSession(asSessionId('s1'));
			expect(store.size(asSessionId('s1'))).toBe(0);
			expect(store.size(asSessionId('s2'))).toBe(1);
			expect(store.getEdge(keep.id)).toEqual(keep);
		});

		it('clearSession on unknown session is a no-op', () => {
			const store = new EdgeStore();
			store.addEdge(createTestEdge({ from: 'a', to: 'b', sessionId: 's1' }));
			expect(() => store.clearSession(asSessionId('unknown'))).not.toThrow();
			expect(store.size(asSessionId('s1'))).toBe(1);
		});
	});

	describe('pruneSession', () => {
		it('removes an edge when its source is absent from the retained set', () => {
			// Given
			const store = new EdgeStore();
			const edge = createTestEdge({ from: 'removed-source', to: 'kept-target', sessionId: 's1' });
			store.addEdge(edge);

			// When
			const removed = store.pruneSession(asSessionId('s1'), retained('kept-target'));

			// Then
			expect(removed).toBe(1);
			expect(store.getEdge(edge.id)).toBeUndefined();
		});

		it('removes an edge when its target is absent from the retained set', () => {
			// Given
			const store = new EdgeStore();
			const edge = createTestEdge({ from: 'kept-source', to: 'removed-target', sessionId: 's1' });
			store.addEdge(edge);

			// When
			const removed = store.pruneSession(asSessionId('s1'), retained('kept-source'));

			// Then
			expect(removed).toBe(1);
			expect(store.getEdge(edge.id)).toBeUndefined();
		});

		it('removes an edge when both endpoints are absent from the retained set', () => {
			// Given
			const store = new EdgeStore();
			store.addEdge(
				createTestEdge({ from: 'removed-source', to: 'removed-target', sessionId: 's1' })
			);

			// When
			const removed = store.pruneSession(asSessionId('s1'), retained());

			// Then
			expect(removed).toBe(1);
			expect(store.size(asSessionId('s1'))).toBe(0);
		});

		it('preserves an edge only when both endpoints are retained', () => {
			// Given
			const store = new EdgeStore();
			const edge = createTestEdge({ from: 'kept-source', to: 'kept-target', sessionId: 's1' });
			store.addEdge(edge);

			// When
			const removed = store.pruneSession(asSessionId('s1'), retained('kept-source', 'kept-target'));

			// Then
			expect(removed).toBe(0);
			expect(store.getEdge(edge.id)).toEqual(edge);
		});

		it('treats main-history and branch-provided thought ids as one retained union', () => {
			// Given
			const store = new EdgeStore();
			const edge = createTestEdge({ from: 'main-thought', to: 'branch-thought', sessionId: 's1' });
			const mainThoughtIds = retained('main-thought');
			const branchThoughtIds = retained('branch-thought');
			const retainedUnion = new Set<ThoughtId>([...mainThoughtIds, ...branchThoughtIds]);
			store.addEdge(edge);

			// When
			const removed = store.pruneSession(asSessionId('s1'), retainedUnion);

			// Then
			expect(removed).toBe(0);
			expect(store.edgesForSession(asSessionId('s1'))).toEqual([edge]);
		});

		it('returns the exact removal count and rebuilds every index from retained edges', () => {
			// Given
			const store = new EdgeStore();
			const keep = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', createdAt: 200 });
			const removeByTarget = createTestEdge({
				from: 'a',
				to: 'c',
				sessionId: 's1',
				createdAt: 100,
			});
			const removeBySource = createTestEdge({
				from: 'd',
				to: 'b',
				sessionId: 's1',
				createdAt: 300,
			});
			store.addEdge(keep);
			store.addEdge(removeByTarget);
			store.addEdge(removeBySource);

			// When
			const removed = store.pruneSession(asSessionId('s1'), retained('a', 'b'));

			// Then
			expect(removed).toBe(2);
			expect(store.edgesForSession(asSessionId('s1'))).toEqual([keep]);
			expect(store.outgoing(asSessionId('s1'), asThoughtId('a'))).toEqual([keep]);
			expect(store.incoming(asSessionId('s1'), asThoughtId('b'))).toEqual([keep]);
			expect(store.getEdge(removeByTarget.id)).toBeUndefined();
			expect(store.getEdge(removeBySource.id)).toBeUndefined();
			expect(store.size(asSessionId('s1'))).toBe(1);
		});

		it('pruning to empty removes all session indexes without affecting later inserts', () => {
			// Given
			const store = new EdgeStore();
			const removedEdge = createTestEdge({ from: 'old-a', to: 'old-b', sessionId: 's1' });
			const laterEdge = createTestEdge({ from: 'new-a', to: 'new-b', sessionId: 's1' });
			store.addEdge(removedEdge);

			// When
			const removed = store.pruneSession(asSessionId('s1'), retained());
			store.addEdge(laterEdge);

			// Then
			expect(removed).toBe(1);
			expect(store.getEdge(removedEdge.id)).toBeUndefined();
			expect(store.edgesForSession(asSessionId('s1'))).toEqual([laterEdge]);
			expect(store.outgoing(asSessionId('s1'), asThoughtId('old-a'))).toEqual([]);
			expect(store.incoming(asSessionId('s1'), asThoughtId('old-b'))).toEqual([]);
		});

		it('does not affect edges in another session', () => {
			// Given
			const store = new EdgeStore();
			const remove = createTestEdge({ from: 'a', to: 'b', sessionId: 's1' });
			const keep = createTestEdge({ from: 'x', to: 'y', sessionId: 's2' });
			store.addEdge(remove);
			store.addEdge(keep);

			// When
			const removed = store.pruneSession(asSessionId('s1'), retained());

			// Then
			expect(removed).toBe(1);
			expect(store.edgesForSession(asSessionId('s2'))).toEqual([keep]);
			expect(store.getEdge(keep.id)).toEqual(keep);
			expect(store.size()).toBe(1);
		});

		it('preserves createdAt ordering after rebuilding retained indexes', () => {
			// Given
			const store = new EdgeStore();
			const latest = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', createdAt: 300 });
			const earliest = createTestEdge({ from: 'a', to: 'c', sessionId: 's1', createdAt: 100 });
			const middle = createTestEdge({ from: 'a', to: 'd', sessionId: 's1', createdAt: 200 });
			const remove = createTestEdge({ from: 'a', to: 'removed', sessionId: 's1', createdAt: 50 });
			store.addEdge(latest);
			store.addEdge(earliest);
			store.addEdge(middle);
			store.addEdge(remove);

			// When
			store.pruneSession(asSessionId('s1'), retained('a', 'b', 'c', 'd'));

			// Then
			expect(
				store.outgoing(asSessionId('s1'), asThoughtId('a')).map((edge) => edge.createdAt)
			).toEqual([100, 200, 300]);
			expect(store.edgesForSession(asSessionId('s1')).map((edge) => edge.createdAt)).toEqual([
				100, 200, 300,
			]);
		});

		it('returns zero when the session is unknown', () => {
			// Given
			const store = new EdgeStore();

			// When
			const removed = store.pruneSession(asSessionId('unknown'), retained('a'));

			// Then
			expect(removed).toBe(0);
			expect(store.size()).toBe(0);
		});
	});

	describe('size', () => {
		it('size() with sessionId returns per-session count', () => {
			const store = new EdgeStore();
			store.addEdge(createTestEdge({ from: 'a', to: 'b', sessionId: 's1' }));
			store.addEdge(createTestEdge({ from: 'c', to: 'd', sessionId: 's1' }));
			store.addEdge(createTestEdge({ from: 'e', to: 'f', sessionId: 's2' }));
			expect(store.size(asSessionId('s1'))).toBe(2);
			expect(store.size(asSessionId('s2'))).toBe(1);
			expect(store.size(asSessionId('unknown'))).toBe(0);
		});

		it('size() without sessionId returns total count', () => {
			const store = new EdgeStore();
			store.addEdge(createTestEdge({ from: 'a', to: 'b', sessionId: 's1' }));
			store.addEdge(createTestEdge({ from: 'c', to: 'd', sessionId: 's1' }));
			store.addEdge(createTestEdge({ from: 'e', to: 'f', sessionId: 's2' }));
			expect(store.size()).toBe(3);
		});

		it('size() returns 0 on empty store', () => {
			const store = new EdgeStore();
			expect(store.size()).toBe(0);
			expect(store.size(asSessionId('any'))).toBe(0);
		});
	});

	describe('edgesForSession', () => {
		it('edgesForSession returns all edges sorted by createdAt', () => {
			const store = new EdgeStore();
			const e1 = createTestEdge({ from: 'a', to: 'b', sessionId: 's1', createdAt: 300 });
			const e2 = createTestEdge({ from: 'c', to: 'd', sessionId: 's1', createdAt: 100 });
			const e3 = createTestEdge({ from: 'e', to: 'f', sessionId: 's1', createdAt: 200 });
			store.addEdge(e1);
			store.addEdge(e2);
			store.addEdge(e3);
			const edges = store.edgesForSession(asSessionId('s1'));
			expect(edges.map((e) => e.createdAt)).toEqual([100, 200, 300]);
		});

		it('edgesForSession returns empty array for unknown session', () => {
			const store = new EdgeStore();
			expect(store.edgesForSession(asSessionId('nope'))).toEqual([]);
		});
	});
});
