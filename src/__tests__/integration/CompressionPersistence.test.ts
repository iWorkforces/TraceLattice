import { asBranchId, asSessionId, type ThoughtId } from '../../contracts/ids.js';
/**
 * Integration tests for compression persistence across all 3 backends.
 *
 * Verifies the end-to-end flow:
 *   1. Build a branched session in HistoryManager (with dagEdges so the
 *      compression service can walk descendants).
 *   2. Run CompressionService.compressBranch() to produce a Summary in the
 *      InMemorySummaryStore (flag-ON path).
 *   3. Persist via persistence.saveSummaries(...) and round-trip via
 *      persistence.loadSummaries(...) — assert structural equality.
 *
 * Matrix: 3 backends (Memory / File / SQLite) × 2 flag states (on / off).
 *
 * SQLite: skipped at module level when `better-sqlite3` is unavailable.
 */


import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HistoryManager } from '../../core/HistoryManager.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { CompressionService } from '../../core/compression/CompressionService.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import { generateUlid } from '../../core/ids.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { FilePersistence } from '../../persistence/FilePersistence.js';
import { SqlitePersistence } from '../../persistence/SqlitePersistence.js';
import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import type { ThoughtData } from '../../core/thought.js';
import { createTestThought } from '../helpers/factories.js';

const SESSION = asSessionId('compression-persistence-sess');
const BRANCH = asBranchId('alt-1');

// SQLite persistence requires the optional `better-sqlite3` package.
const SQLITE_AVAILABLE = await (async () => {
	try {
		await import('better-sqlite3');
		return true;
	} catch {
		return false;
	}
})();

type BackendKind = 'memory' | 'file' | 'sqlite';

interface BackendHarness {
	readonly persistence: PersistenceBackend;
	readonly reopen: () => Promise<PersistenceBackend>;
}

function makeThought(num: number, overrides?: Partial<ThoughtData>): ThoughtData {
	return createTestThought({
		id: generateUlid(),
		thought_number: num,
		total_thoughts: 10,
		thought:
			'compression candidate thought number ' +
			num +
			' discussing cache lookup latency tradeoffs',
		next_thought_needed: true,
		session_id: SESSION,
		...overrides,
	});
}

/**
 * Seed a branched session (3 main + 3 branched thoughts) and return the
 * branch root id so tests can call compressBranch on it.
 */
function seedBranchedSession(manager: HistoryManager): { branchRootId: ThoughtId } {
	const t1 = makeThought(1);
	const t2 = makeThought(2);
	const t3 = makeThought(3);
	manager.addThought(t1);
	manager.addThought(t2);
	manager.addThought(t3);

	// Branch off thought 2 — first branch thought is the root for compression.
	const b1 = makeThought(4, {
		branch_from_thought: 2,
		branch_id: BRANCH,
		thought: 'branch root thought four exploring alternative caching strategy',
	});
	const b2 = makeThought(5, {
		branch_from_thought: 2,
		branch_id: BRANCH,
		thought: 'branch follow-up five comparing latency results across caches',
	});
	const b3 = makeThought(6, {
		branch_from_thought: 2,
		branch_id: BRANCH,
		next_thought_needed: false,
		thought: 'branch terminal six summarising findings on lookup performance',
	});
	manager.addThought(b1);
	manager.addThought(b2);
	manager.addThought(b3);

	return { branchRootId: b1.id! as ThoughtId };
}

describe('Compression persistence integration', () => {
	let tmpRoot: string;

	beforeAll(async () => {
		tmpRoot = await mkdtemp(join(tmpdir(), 'compression-persistence-'));
	});

	afterAll(async () => {
		await rm(tmpRoot, { recursive: true, force: true });
	});

	async function makeBackend(kind: BackendKind): Promise<BackendHarness> {
		switch (kind) {
			case 'memory': {
				const persistence = new MemoryPersistence();
				return { persistence, reopen: async () => persistence };
			}
			case 'file': {
				const dataDir = await mkdtemp(join(tmpRoot, 'file-'));
				return {
					persistence: await FilePersistence.create({ dataDir }),
					reopen: async () => await FilePersistence.create({ dataDir }),
				};
			}
			case 'sqlite': {
				const dbPath = join(await mkdtemp(join(tmpRoot, 'sqlite-')), 'history.db');
				return {
					persistence: await SqlitePersistence.create({ dbPath }),
					reopen: async () => await SqlitePersistence.create({ dbPath }),
				};
			}
		}
	}

	const backends: BackendKind[] = ['memory', 'file', 'sqlite'];

	for (const kind of backends) {
		const skip = kind === 'sqlite' && !SQLITE_AVAILABLE;

		// -------------------------------------------------------------------
		// Flag-ON: compression service is wired and explicitly invoked
		// -------------------------------------------------------------------
		it.skipIf(skip)(
			`flag ON: persists and reloads a Summary after reopening the ${kind} backend`,
			async () => {
				const backend = await makeBackend(kind);
				const { persistence } = backend;
				const edgeStore = new EdgeStore();
				const summaryStore = new InMemorySummaryStore();
				const manager = new HistoryManager({
					edgeStore,
					dagEdges: true,
					persistence,
					persistenceFlushInterval: 60_000,
					persistenceBufferSize: 1000,
				});
				const compression = new CompressionService({
					historyManager: manager,
					edgeStore,
					summaryStore,
				});

				const { branchRootId } = seedBranchedSession(manager);

				// Compress the branch — flag-ON path.
				const summary = compression.compressBranch(SESSION, BRANCH, branchRootId);
				expect(summary.sessionId).toBe(SESSION);
				expect(summary.branchId).toBe(BRANCH);
				expect(summary.rootThoughtId).toBe(branchRootId);
				expect(summary.coveredIds.length).toBeGreaterThanOrEqual(1);

				// In-memory summary store reflects the new Summary.
				const inMem = summaryStore.forBranch(SESSION, BRANCH);
				expect(inMem).toHaveLength(1);

				await persistence.saveSummaries(SESSION, summaryStore.forSession(SESSION));
				await manager.shutdown();
				await persistence.close();
				const reopened = await backend.reopen();
				const reloaded = await reopened.loadSummaries(SESSION);

				expect(reloaded).toHaveLength(1);
				const r = reloaded[0]!;
				expect(r.id).toBe(summary.id);
				expect(r.sessionId).toBe(SESSION);
				expect(r.branchId).toBe(BRANCH);
				expect(r.rootThoughtId).toBe(branchRootId);
				expect([...r.coveredIds]).toEqual([...summary.coveredIds]);
				expect([r.coveredRange[0], r.coveredRange[1]]).toEqual([
					summary.coveredRange[0],
					summary.coveredRange[1],
				]);
				expect([...r.topics]).toEqual([...summary.topics]);
				expect(r.aggregateConfidence).toBeCloseTo(summary.aggregateConfidence);
				expect(r.createdAt).toBe(summary.createdAt);

				await reopened.close();
			}
		);

		// -------------------------------------------------------------------
		// Flag-OFF: compression service is NOT wired / not invoked
		// -------------------------------------------------------------------
		it.skipIf(skip)(
			`flag OFF: produces no summaries after reopening the ${kind} backend`,
			async () => {
				const backend = await makeBackend(kind);
				const { persistence } = backend;
				const edgeStore = new EdgeStore();
				const summaryStore = new InMemorySummaryStore();
				const manager = new HistoryManager({
					edgeStore,
					dagEdges: true,
					persistence,
					persistenceFlushInterval: 60_000,
					persistenceBufferSize: 1000,
				});

				// NOTE: deliberately do NOT construct/invoke CompressionService.
				seedBranchedSession(manager);

				// In-memory summary store is empty.
				expect(summaryStore.size()).toBe(0);

				// Save the (empty) summary set, then reload — backend must report nothing.
				await persistence.saveSummaries(SESSION, summaryStore.forSession(SESSION));
				await manager.shutdown();
				await persistence.close();
				const reopened = await backend.reopen();
				const reloaded = await reopened.loadSummaries(SESSION);
				expect(reloaded).toHaveLength(0);

				await reopened.close();
			}
		);
	}
});
