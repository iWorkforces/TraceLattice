/**
 * Tests for edge persistence integration in HistoryManager.
 *
 * Covers:
 * - Flag OFF: edges never persisted
 * - Flag ON: edges flushed alongside thoughts on _flushBuffer()
 * - Flag ON: edges restored via loadFromPersistence()
 * - Flag ON: clear() purges EdgeStore as well
 * - Roundtrip: flush then load into a fresh HistoryManager
 */

import { describe, it, expect, vi } from 'vitest';
import { HistoryManager } from '../../core/HistoryManager.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { generateUlid } from '../../core/ids.js';
import { createTestThought } from '../helpers/factories.js';
import type { ThoughtData } from '../../core/thought.js';
import type { Edge } from '../../core/graph/Edge.js';
import { asSessionId, asThoughtId, type EdgeId, type SessionId, type ThoughtId } from '../../contracts/ids.js';

const GLOBAL: SessionId = asSessionId('__global__');

function makeThought(num: number, overrides?: Partial<Omit<ThoughtData, 'session_id'>> & { session_id?: string }): ThoughtData {
	const { session_id, ...rest } = overrides ?? {};
	return createTestThought({
		id: generateUlid() as ThoughtId,
		thought_number: num,
		total_thoughts: 10,
		thought: `t${num}`,
		...(session_id !== undefined ? { session_id: asSessionId(session_id) } : {}),
		...rest,
	});
}

function setup(opts?: {
	dagEdges?: boolean;
	persistence?: MemoryPersistence;
	edgeStore?: EdgeStore;
}): {
	manager: HistoryManager;
	edgeStore: EdgeStore;
	persistence: MemoryPersistence;
} {
	const persistence = opts?.persistence ?? new MemoryPersistence();
	const edgeStore = opts?.edgeStore ?? new EdgeStore();
	const manager = new HistoryManager({
		edgeStore,
		dagEdges: opts?.dagEdges ?? true,
		persistence,
		persistenceFlushInterval: 60_000, // disable timer-driven flushes
		persistenceBufferSize: 1000,
	});
	return { manager, edgeStore, persistence };
}

describe('HistoryManager edge persistence', () => {
	it('does not call saveEdges when dagEdges flag is OFF', async () => {
		const persistence = new MemoryPersistence();
		const saveEdgesSpy = vi.spyOn(persistence, 'saveEdges');
		const { manager } = setup({ dagEdges: false, persistence });

		manager.addThought(makeThought(1));
		manager.addThought(makeThought(2));
		manager.addThought(makeThought(3));

		await manager._flushBuffer();

		expect(saveEdgesSpy).not.toHaveBeenCalled();
		await manager.shutdown();
	});

	it('flushes edges to persistence when flag is ON', async () => {
		const persistence = new MemoryPersistence();
		const saveEdgesSpy = vi.spyOn(persistence, 'saveEdges');
		const { manager } = setup({ persistence });

		manager.addThought(makeThought(1));
		manager.addThought(makeThought(2));
		manager.addThought(makeThought(3));

		await manager._flushBuffer();

		expect(saveEdgesSpy).toHaveBeenCalledTimes(1);
		const [sessionId, edges] = saveEdgesSpy.mock.calls[0]!;
		expect(sessionId).toBe(GLOBAL);
		expect(edges.length).toBe(2);
		expect(edges.every((e: Edge) => e.kind === 'sequence')).toBe(true);

		const persisted = await persistence.loadEdges(GLOBAL);
		expect(persisted).toHaveLength(2);
		await manager.shutdown();
	});

	it('does not register an empty edge snapshot for the first thought', async () => {
		const persistence = new MemoryPersistence();
		const saveEdgesSpy = vi.spyOn(persistence, 'saveEdges');
		const { manager } = setup({ persistence });

		manager.addThought(makeThought(1));
		await manager._flushBuffer();

		expect(saveEdgesSpy).not.toHaveBeenCalled();
		await manager.shutdown();
	});

	it('loads edges into EdgeStore on loadFromPersistence', async () => {
		const persistence = new MemoryPersistence();
		const seedEdges: Edge[] = [
			{
				id: generateUlid() as EdgeId,
				from: asThoughtId('thought-a'),
				to: asThoughtId('thought-b'),
				kind: 'sequence',
				sessionId: GLOBAL,
				createdAt: 100,
			},
			{
				id: generateUlid() as EdgeId,
				from: asThoughtId('thought-b'),
				to: asThoughtId('thought-c'),
				kind: 'derives_from',
				sessionId: GLOBAL,
				createdAt: 200,
			},
		];
		await persistence.saveEdges(GLOBAL, seedEdges);

		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			edgeStore,
			dagEdges: true,
			persistence,
			persistenceFlushInterval: 60_000,
		});

		await manager.loadFromPersistence();

		expect(edgeStore.size(GLOBAL)).toBe(2);
		const loaded = edgeStore.edgesForSession(GLOBAL);
		expect(loaded.map((e) => e.kind).sort()).toEqual(['derives_from', 'sequence']);
		await manager.shutdown();
	});

	it('clear() purges edges from the EdgeStore', async () => {
		const { manager, edgeStore } = setup();

		manager.addThought(makeThought(1));
		manager.addThought(makeThought(2));
		manager.addThought(makeThought(3));

		expect(edgeStore.size(GLOBAL)).toBeGreaterThan(0);

		manager.clear();

		expect(edgeStore.size(GLOBAL)).toBe(0);
		await manager.shutdown();
	});

	it('roundtrips: flush in one manager then load into a fresh manager', async () => {
		const persistence = new MemoryPersistence();
		const { manager } = setup({ persistence });

		manager.addThought(makeThought(1));
		manager.addThought(makeThought(2));
		manager.addThought(makeThought(3));
		manager.addThought(makeThought(4));

		await manager._flushBuffer();
		await manager.shutdown();

		// Spin up a fresh manager with the same persistence backend
		const freshEdgeStore = new EdgeStore();
		const fresh = new HistoryManager({
			edgeStore: freshEdgeStore,
			dagEdges: true,
			persistence,
			persistenceFlushInterval: 60_000,
		});

		await fresh.loadFromPersistence();

		expect(freshEdgeStore.size(GLOBAL)).toBe(3);
		const loaded = freshEdgeStore.edgesForSession(GLOBAL);
		expect(loaded.every((e) => e.kind === 'sequence')).toBe(true);
		await fresh.shutdown();
	});

	it('listEdgeSessions returns all sessions with persisted edges', async () => {
		const persistence = new MemoryPersistence();
		await persistence.saveEdges(asSessionId('test-A'), [
			{
				id: generateUlid() as EdgeId,
				from: asThoughtId('a1'),
				to: asThoughtId('a2'),
				kind: 'sequence',
				sessionId: asSessionId('test-A'),
				createdAt: 1,
			},
		]);
		await persistence.saveEdges(asSessionId('test-B'), [
			{
				id: generateUlid() as EdgeId,
				from: asThoughtId('b1'),
				to: asThoughtId('b2'),
				kind: 'sequence',
				sessionId: asSessionId('test-B'),
				createdAt: 2,
			},
		]);

		const sessions = await persistence.listEdgeSessions();
		expect(sessions.sort()).toEqual(['test-A', 'test-B']);
	});

	it('restores edges for ALL sessions, not just global', async () => {
		const persistence = new MemoryPersistence();
		const seedA: Edge[] = [
			{
				id: generateUlid() as EdgeId,
				from: asThoughtId('a1'),
				to: asThoughtId('a2'),
				kind: 'sequence',
				sessionId: asSessionId('test-A'),
				createdAt: 100,
			},
			{
				id: generateUlid() as EdgeId,
				from: asThoughtId('a2'),
				to: asThoughtId('a3'),
				kind: 'sequence',
				sessionId: asSessionId('test-A'),
				createdAt: 101,
			},
		];
		const seedB: Edge[] = [
			{
				id: generateUlid() as EdgeId,
				from: asThoughtId('b1'),
				to: asThoughtId('b2'),
				kind: 'derives_from',
				sessionId: asSessionId('test-B'),
				createdAt: 200,
			},
		];
		await persistence.saveEdges(asSessionId('test-A'), seedA);
		await persistence.saveEdges(asSessionId('test-B'), seedB);

		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			edgeStore,
			dagEdges: true,
			persistence,
			persistenceFlushInterval: 60_000,
		});

		await manager.loadFromPersistence();

		expect(edgeStore.size(asSessionId('test-A'))).toBe(2);
		expect(edgeStore.size(asSessionId('test-B'))).toBe(1);
		expect(edgeStore.edgesForSession(asSessionId('test-A')).map((e) => e.kind)).toEqual([
			'sequence',
			'sequence',
		]);
		expect(edgeStore.edgesForSession(asSessionId('test-B')).map((e) => e.kind)).toEqual(['derives_from']);
		await manager.shutdown();
	});

	it('roundtrips multi-session edges via _flushBuffer + loadFromPersistence', async () => {
		const persistence = new MemoryPersistence();
		const { manager } = setup({ persistence });

		manager.addThought(makeThought(1, { session_id: 'test-A' }));
		manager.addThought(makeThought(2, { session_id: 'test-A' }));
		manager.addThought(makeThought(1, { session_id: 'test-B' }));
		manager.addThought(makeThought(2, { session_id: 'test-B' }));

		await manager._flushBuffer();
		await manager.shutdown();

		const sessions = await persistence.listEdgeSessions();
		expect(sessions.sort()).toEqual(['test-A', 'test-B']);

		const freshEdgeStore = new EdgeStore();
		const fresh = new HistoryManager({
			edgeStore: freshEdgeStore,
			dagEdges: true,
			persistence,
			persistenceFlushInterval: 60_000,
		});

		await fresh.loadFromPersistence();

		expect(freshEdgeStore.size(asSessionId('test-A'))).toBe(1);
		expect(freshEdgeStore.size(asSessionId('test-B'))).toBe(1);
		await fresh.shutdown();
	});
});
