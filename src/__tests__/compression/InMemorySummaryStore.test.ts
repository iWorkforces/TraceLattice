/**
 * Tests for {@link InMemorySummaryStore}.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import { SequentialThinkingError } from '../../errors.js';
import type { Summary } from '../../core/compression/Summary.js';
import { asSessionId, asBranchId, type ThoughtId } from '../../contracts/ids.js';

let counter = 0;

function makeSummary(
	overrides: Partial<Omit<Summary, 'sessionId' | 'rootThoughtId' | 'coveredIds' | 'branchId'>> & {
		sessionId?: string;
		rootThoughtId?: string;
		coveredIds?: readonly string[];
		branchId?: string;
	} = {}
): Summary {
	counter += 1;
	return {
		id: overrides.id ?? `sum-${counter}`,
		sessionId: asSessionId(overrides.sessionId ?? 's1'),
		branchId: overrides.branchId === undefined ? undefined : asBranchId(overrides.branchId),
		rootThoughtId: (overrides.rootThoughtId ?? `t-${counter}`) as ThoughtId,
		coveredIds: (overrides.coveredIds ?? [`t-${counter}`]) as readonly ThoughtId[],
		coveredRange: overrides.coveredRange ?? [counter, counter],
		topics: overrides.topics ?? ['x', 'y', 'z'],
		aggregateConfidence: overrides.aggregateConfidence ?? 0.5,
		createdAt: overrides.createdAt ?? counter,
		meta: overrides.meta,
	};
}

describe('InMemorySummaryStore', () => {
	let store: InMemorySummaryStore;

	beforeEach(() => {
		store = new InMemorySummaryStore();
		counter = 0;
	});

	it('add() then get() returns the same summary', () => {
		const s = makeSummary({ id: 'a1' });
		store.add(s);
		expect(store.get('a1')).toBe(s);
	});

	it('get() returns undefined for unknown id', () => {
		expect(store.get('missing')).toBeUndefined();
	});

	it('add() throws on duplicate id', () => {
		const s = makeSummary({ id: 'dup' });
		store.add(s);
		expect(() => store.add(makeSummary({ id: 'dup' }))).toThrow(SequentialThinkingError);
		try {
			store.add(makeSummary({ id: 'dup' }));
		} catch (err) {
			expect((err as SequentialThinkingError).code).toBe('DUPLICATE_SUMMARY');
		}
	});

	it('T10-S01 permits the same summary id in different sessions', () => {
		// Given
		const first = makeSummary({ id: 'shared-id', sessionId: 's1' });
		const second = makeSummary({ id: 'shared-id', sessionId: 's2' });

		// When
		store.add(first);
		store.add(second);

		// Then
		expect(store.forSession('s1')).toEqual([first]);
		expect(store.forSession('s2')).toEqual([second]);
		expect(store.get('shared-id')).toBe(first);
	});

	it('T10-S02 clearing one session preserves a same-id summary in another session', () => {
		// Given
		const first = makeSummary({ id: 'shared-id', sessionId: 's1' });
		const second = makeSummary({ id: 'shared-id', sessionId: 's2' });
		store.add(first);
		store.add(second);

		// When
		store.clearSession('s1');

		// Then
		expect(store.forSession('s1')).toEqual([]);
		expect(store.forSession('s2')).toEqual([second]);
		expect(store.get('shared-id')).toBe(second);
	});

	it('forSession() returns summaries sorted by createdAt ascending', () => {
		const s2 = makeSummary({ id: 's-b', sessionId: 's1', createdAt: 200 });
		const s1 = makeSummary({ id: 's-a', sessionId: 's1', createdAt: 100 });
		const s3 = makeSummary({ id: 's-c', sessionId: 's1', createdAt: 300 });
		store.add(s2);
		store.add(s1);
		store.add(s3);
		const list = store.forSession('s1');
		expect(list.map((s) => s.id)).toEqual(['s-a', 's-b', 's-c']);
	});

	it('forSession() returns empty array for unknown session', () => {
		expect(store.forSession('nope')).toEqual([]);
	});

	it('forBranch() returns only summaries for the given (session, branch)', () => {
		const a = makeSummary({ id: 'a', sessionId: 's1', branchId: 'b1', createdAt: 1 });
		const b = makeSummary({ id: 'b', sessionId: 's1', branchId: 'b2', createdAt: 2 });
		const c = makeSummary({ id: 'c', sessionId: 's1', branchId: 'b1', createdAt: 3 });
		const d = makeSummary({ id: 'd', sessionId: 's2', branchId: 'b1', createdAt: 4 });
		store.add(a);
		store.add(b);
		store.add(c);
		store.add(d);
		expect(store.forBranch('s1', asBranchId('b1')).map((s) => s.id)).toEqual(['a', 'c']);
		expect(store.forBranch('s1', asBranchId('b2')).map((s) => s.id)).toEqual(['b']);
		expect(store.forBranch('s2', asBranchId('b1')).map((s) => s.id)).toEqual(['d']);
	});

	it('forBranch() returns empty for unknown branch', () => {
		expect(store.forBranch('nope', asBranchId('x'))).toEqual([]);
	});

	it('summaries without branchId are not indexed by branch', () => {
		store.add(makeSummary({ id: 'm1', sessionId: 's1' }));
		expect(store.forBranch('s1', asBranchId('anything'))).toEqual([]);
		expect(store.forSession('s1').map((s) => s.id)).toEqual(['m1']);
	});

	it('size() without arg returns total across sessions', () => {
		store.add(makeSummary({ id: 'a', sessionId: 's1' }));
		store.add(makeSummary({ id: 'b', sessionId: 's2' }));
		store.add(makeSummary({ id: 'c', sessionId: 's2' }));
		expect(store.size()).toBe(3);
	});

	it('size(sessionId) returns count for that session', () => {
		store.add(makeSummary({ id: 'a', sessionId: 's1' }));
		store.add(makeSummary({ id: 'b', sessionId: 's2' }));
		store.add(makeSummary({ id: 'c', sessionId: 's2' }));
		expect(store.size('s1')).toBe(1);
		expect(store.size('s2')).toBe(2);
		expect(store.size('unknown')).toBe(0);
	});

	it('clearSession() removes summaries from all indexes', () => {
		const a = makeSummary({ id: 'a', sessionId: 's1', branchId: 'b1' });
		const b = makeSummary({ id: 'b', sessionId: 's1' });
		const c = makeSummary({ id: 'c', sessionId: 's2', branchId: 'b1' });
		store.add(a);
		store.add(b);
		store.add(c);

		store.clearSession('s1');

		expect(store.get('a')).toBeUndefined();
		expect(store.get('b')).toBeUndefined();
		expect(store.get('c')).toBe(c);
		expect(store.forSession('s1')).toEqual([]);
		expect(store.forBranch('s1', asBranchId('b1'))).toEqual([]);
		expect(store.forSession('s2').map((s) => s.id)).toEqual(['c']);
		expect(store.size()).toBe(1);
		expect(store.size('s1')).toBe(0);
	});

	it('clearSession() on unknown session is a no-op', () => {
		store.add(makeSummary({ id: 'a', sessionId: 's1' }));
		expect(() => store.clearSession('unknown')).not.toThrow();
		expect(store.size()).toBe(1);
	});

	it('after clearSession, ids can be re-added without duplicate error', () => {
		store.add(makeSummary({ id: 'a', sessionId: 's1' }));
		store.clearSession('s1');
		expect(() => store.add(makeSummary({ id: 'a', sessionId: 's1' }))).not.toThrow();
		expect(store.get('a')).toBeDefined();
	});

	it('forBranch results sorted by createdAt ascending', () => {
		store.add(makeSummary({ id: 'b1', sessionId: 's1', branchId: 'b', createdAt: 30 }));
		store.add(makeSummary({ id: 'b2', sessionId: 's1', branchId: 'b', createdAt: 10 }));
		store.add(makeSummary({ id: 'b3', sessionId: 's1', branchId: 'b', createdAt: 20 }));
		expect(store.forBranch('s1', asBranchId('b')).map((s) => s.id)).toEqual(['b2', 'b3', 'b1']);
	});

	it('isolates branch keys with the same branchId across sessions', () => {
		store.add(makeSummary({ id: 'x', sessionId: 's1', branchId: 'shared' }));
		store.add(makeSummary({ id: 'y', sessionId: 's2', branchId: 'shared' }));
		expect(store.forBranch('s1', asBranchId('shared')).map((s) => s.id)).toEqual(['x']);
		expect(store.forBranch('s2', asBranchId('shared')).map((s) => s.id)).toEqual(['y']);
	});
});
