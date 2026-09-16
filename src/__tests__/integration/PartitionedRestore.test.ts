import { afterEach, describe, expect, it } from 'vitest';
import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asSummaryId,
	asThoughtId,
	GLOBAL_SESSION_ID,
	type BranchId,
	type SessionId,
} from '../../contracts/ids.js';
import { runWithContext } from '../../context/RequestContext.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import type { Summary } from '../../core/compression/Summary.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import type { Edge } from '../../core/graph/Edge.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import type { ThoughtData } from '../../core/thought.js';
import { PersistenceCapabilityError, SessionAccessDeniedError } from '../../errors.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { FilePersistence } from '../../persistence/FilePersistence.js';
import { SqlitePersistence } from '../../persistence/SqlitePersistence.js';
import { createTestThought } from '../helpers/factories.js';
import { StatefulSqliteDatabase } from '../helpers/StatefulSqliteDatabase.js';

const managers = new Set<HistoryManager>();

function thought(
	sessionId: SessionId,
	number: number,
	overrides: Partial<ThoughtData> = {}
): ThoughtData {
	return createTestThought({
		id: `${sessionId}-thought-${number}`,
		session_id: sessionId === GLOBAL_SESSION_ID ? undefined : sessionId,
		thought_number: number,
		thought: `${sessionId}-${number}`,
		available_mcp_tools: undefined,
		available_skills: undefined,
		...overrides,
	});
}

function edge(sessionId: SessionId, id: string): Edge {
	return {
		id: asEdgeId(id),
		from: asThoughtId(`${id}-from`),
		to: asThoughtId(`${id}-to`),
		kind: 'sequence',
		sessionId,
		createdAt: 1,
	};
}

function summary(sessionId: SessionId, id: string, branchId?: BranchId): Summary {
	return {
		id: asSummaryId(id),
		sessionId,
		...(branchId === undefined ? {} : { branchId }),
		rootThoughtId: asThoughtId(`${id}-root`),
		coveredIds: [asThoughtId(`${id}-root`)],
		coveredRange: [1, 1],
		topics: ['restore'],
		aggregateConfidence: 0.8,
		createdAt: 1,
	};
}

function manager(
	persistence: PersistenceBackend,
	options: {
		readonly edgeStore?: EdgeStore;
		readonly summaryStore?: InMemorySummaryStore;
		readonly maxHistorySize?: number;
		readonly maxBranchSize?: number;
		readonly maxBranches?: number;
	} = {}
): HistoryManager {
	const value = new HistoryManager({
		persistence,
		persistenceFlushInterval: 60_000,
		...options,
	});
	managers.add(value);
	return value;
}

class RecordingPersistence extends MemoryPersistence {
	readonly calls: string[] = [];

	override async healthy(): Promise<boolean> {
		this.calls.push('healthy');
		return await super.healthy();
	}

	override async listSessions(): Promise<SessionId[]> {
		this.calls.push('listSessions');
		return await super.listSessions();
	}

	override async loadHistory(): Promise<ThoughtData[]> {
		this.calls.push('loadHistory');
		return await super.loadHistory();
	}

	override async listBranches(): Promise<BranchId[]> {
		this.calls.push('listBranches');
		return await super.listBranches();
	}

	override async listEdgeSessions(): Promise<SessionId[]> {
		this.calls.push('listEdgeSessions');
		return await super.listEdgeSessions();
	}

	override async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		this.calls.push(`history:${sessionId}`);
		return await super.loadHistoryForSession(sessionId);
	}

	override async listBranchesForSession(sessionId: SessionId): Promise<BranchId[]> {
		this.calls.push(`branches:${sessionId}`);
		return await super.listBranchesForSession(sessionId);
	}

	override async loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		this.calls.push(`branch:${sessionId}:${branchId}`);
		return await super.loadBranchForSession(sessionId, branchId);
	}

	override async loadEdges(sessionId: SessionId): Promise<Edge[]> {
		this.calls.push(`edges:${sessionId}`);
		return await super.loadEdges(sessionId);
	}

	override async loadSummaries(sessionId: SessionId): Promise<Summary[]> {
		this.calls.push(`summaries:${sessionId}`);
		return await super.loadSummaries(sessionId);
	}

	override async saveThoughtForSession(sessionId: SessionId, value: ThoughtData): Promise<void> {
		this.calls.push(`save-thought:${sessionId}`);
		await super.saveThoughtForSession(sessionId, value);
	}

	override async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		values: readonly ThoughtData[]
	): Promise<void> {
		this.calls.push(`save-branch:${sessionId}:${branchId}`);
		await super.saveBranchForSession(sessionId, branchId, values);
	}

	override async deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		this.calls.push(`delete-branch:${sessionId}:${branchId}`);
		await super.deleteBranchForSession(sessionId, branchId);
	}

	override async saveEdges(sessionId: SessionId, values: readonly Edge[]): Promise<void> {
		this.calls.push(`save-edges:${sessionId}`);
		await super.saveEdges(sessionId, values);
	}

	override async saveSummaries(sessionId: SessionId, values: readonly Summary[]): Promise<void> {
		this.calls.push(`save-summaries:${sessionId}`);
		await super.saveSummaries(sessionId, values);
	}

	override async clear(): Promise<void> {
		this.calls.push('clear');
		await super.clear();
	}

	override async clearSession(sessionId: SessionId): Promise<void> {
		this.calls.push(`clear:${sessionId}`);
		await super.clearSession(sessionId);
	}
}

class FailingPartitionPersistence extends MemoryPersistence {
	readonly failingSession: SessionId;

	constructor(failingSession: SessionId) {
		super();
		this.failingSession = failingSession;
	}

	override async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		if (sessionId === this.failingSession) throw new Error(`read failed for ${sessionId}`);
		return await super.loadHistoryForSession(sessionId);
	}
}

class FailedResetPersistence extends MemoryPersistence {
	override async clearSession(sessionId: SessionId): Promise<void> {
		throw new Error(`clear failed for ${sessionId}`);
	}

	override async clear(): Promise<void> {
		throw new Error('clear all failed');
	}
}

class LegacyOnlyPersistence implements PersistenceBackend {
	async saveThought(): Promise<void> {}
	async loadHistory(): Promise<ThoughtData[]> {
		return [];
	}
	async saveBranch(): Promise<void> {}
	async loadBranch(): Promise<ThoughtData[] | undefined> {
		return undefined;
	}
	async listBranches(): Promise<BranchId[]> {
		return [];
	}
	async healthy(): Promise<boolean> {
		return true;
	}
	async clear(): Promise<void> {}
	async close(): Promise<void> {}
	async saveEdges(): Promise<void> {}
	async loadEdges(): Promise<Edge[]> {
		return [];
	}
	async listEdgeSessions(): Promise<SessionId[]> {
		return [];
	}
	async saveSummaries(): Promise<void> {}
	async loadSummaries(): Promise<Summary[]> {
		return [];
	}
}

afterEach(async () => {
	for (const value of managers) await value.shutdown();
	managers.clear();
});

describe('Task 10 partitioned startup restore', () => {
	it('T10-R01/R02/R03 restores the authoritative global/A/B namespace union', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const edgeOnly = asSessionId('edge-only');
		const summaryOnly = asSessionId('summary-only');
		const shared = asBranchId('shared');
		const empty = asBranchId('empty');
		await persistence.saveThought(thought(GLOBAL_SESSION_ID, 1));
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		await persistence.saveThoughtForSession(sessionB, thought(sessionB, 1));
		await persistence.saveBranchForSession(sessionA, shared, [
			thought(sessionA, 2, { branch_id: shared }),
		]);
		await persistence.saveBranchForSession(sessionB, shared, [
			thought(sessionB, 2, { branch_id: shared }),
		]);
		await persistence.saveBranchForSession(sessionA, empty, []);
		await persistence.saveEdges(edgeOnly, [edge(edgeOnly, 'edge-only-id')]);
		await persistence.saveSummaries(summaryOnly, [summary(summaryOnly, 'summary-only-id')]);
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, { edgeStore, summaryStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(history.getSessionIds().sort()).toEqual([
			'A',
			'B',
			'__global__',
			'edge-only',
			'summary-only',
		]);
		expect(history.getHistory(GLOBAL_SESSION_ID)).toHaveLength(1);
		expect(history.getHistory(sessionA)).toHaveLength(1);
		expect(history.getHistory(sessionB)).toHaveLength(1);
		expect(history.getBranch(shared, sessionA)?.[0]?.session_id).toBe(sessionA);
		expect(history.getBranch(shared, sessionB)?.[0]?.session_id).toBe(sessionB);
		expect(history.getBranch(empty, sessionA)).toEqual([]);
		expect(edgeStore.edgesForSession(edgeOnly)).toEqual([]);
		expect(summaryStore.forSession(summaryOnly)).toHaveLength(1);
	});

	it('T10-R04 uses scoped listSessions once and never calls legacy or durable mutation APIs', async () => {
		// Given
		const persistence = new RecordingPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		persistence.calls.length = 0;
		const history = manager(persistence);

		// When
		await history.loadFromPersistence();

		// Then
		expect(persistence.calls).toEqual([
			'healthy',
			'listSessions',
			'history:A',
			'branches:A',
			'edges:A',
			'summaries:A',
		]);
	});

	it('T10-R05 derives tool and skill context before applying history and branch retention', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		const first = thought(sessionA, 1, { available_mcp_tools: ['tool-from-full-history'] });
		const second = thought(sessionA, 2, { available_skills: ['skill-from-full-history'] });
		const third = thought(sessionA, 3);
		await persistence.saveThoughtForSession(sessionA, first);
		await persistence.saveThoughtForSession(sessionA, second);
		await persistence.saveThoughtForSession(sessionA, third);
		for (const [branchName, firstNumber] of [
			['a', 4],
			['z', 6],
		] as const) {
			const branchId = asBranchId(branchName);
			await persistence.saveBranchForSession(sessionA, branchId, [
				thought(sessionA, firstNumber, { branch_id: branchId }),
				thought(sessionA, firstNumber + 1, { branch_id: branchId }),
			]);
		}
		const history = manager(persistence, { maxHistorySize: 1, maxBranchSize: 1, maxBranches: 1 });

		// When
		await history.loadFromPersistence();

		// Then
		expect(history.getHistory(sessionA).map((entry) => entry.thought_number)).toEqual([3]);
		expect(history.getAvailableMcpTools(sessionA)).toEqual(['tool-from-full-history']);
		expect(history.getAvailableSkills(sessionA)).toEqual(['skill-from-full-history']);
		expect(history.getBranchIds(sessionA)).toEqual([asBranchId('z')]);
		expect(
			history.getBranch(asBranchId('z'), sessionA)?.map((entry) => entry.thought_number)
		).toEqual([7]);
		expect(await persistence.loadHistoryForSession(sessionA)).toEqual([first, second, third]);
		expect(await persistence.loadBranchForSession(sessionA, asBranchId('a'))).toHaveLength(2);
	});

	it('restores exact zero branches and prunes their edges without mutating persistence', async () => {
		const persistence = new RecordingPersistence();
		const sessionA = asSessionId('zero-restore');
		const branchId = asBranchId('stale');
		const branchThought = thought(sessionA, 2, { branch_id: branchId });
		await persistence.saveBranchForSession(sessionA, branchId, [branchThought]);
		await persistence.saveEdges(sessionA, [
			{
				id: asEdgeId('stale-edge'),
				from: asThoughtId('missing-root'),
				to: branchThought.id ?? asThoughtId('missing-branch'),
				kind: 'branch',
				sessionId: sessionA,
				createdAt: 1,
			},
		]);
		persistence.calls.length = 0;
		const edgeStore = new EdgeStore();
		const history = manager(persistence, { maxBranches: 0, edgeStore });

		await history.loadFromPersistence();

		expect(history.getBranchIds(sessionA)).toEqual([]);
		expect(edgeStore.edgesForSession(sessionA)).toEqual([]);
		expect(await persistence.loadBranchForSession(sessionA, branchId)).toEqual([branchThought]);
		expect(persistence.calls.filter((call) => call.startsWith('save-'))).toEqual([]);
		expect(persistence.calls.filter((call) => call.startsWith('delete-'))).toEqual([]);
	});

	it('drops a restored edge with a missing source without mutating persistence', async () => {
		// Given
		const persistence = new RecordingPersistence();
		const sessionA = asSessionId('missing-source');
		const targetId = asThoughtId('retained-target');
		const danglingEdge: Edge = {
			id: asEdgeId('missing-source-edge'),
			from: asThoughtId('missing-source-id'),
			to: targetId,
			kind: 'sequence',
			sessionId: sessionA,
			createdAt: 1,
		};
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1, { id: targetId }));
		await persistence.saveEdges(sessionA, [danglingEdge]);
		persistence.calls.length = 0;
		const edgeStore = new EdgeStore();
		const history = manager(persistence, { edgeStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(edgeStore.edgesForSession(sessionA)).toEqual([]);
		expect(await persistence.loadEdges(sessionA)).toEqual([danglingEdge]);
		expect(
			persistence.calls.filter(
				(call) => call.startsWith('save-') || call.startsWith('delete-') || call.startsWith('clear')
			)
		).toEqual([]);
	});

	it('drops a restored edge with a missing target', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('missing-target');
		const sourceId = asThoughtId('retained-source');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1, { id: sourceId }));
		await persistence.saveEdges(sessionA, [
			{
				id: asEdgeId('missing-target-edge'),
				from: sourceId,
				to: asThoughtId('missing-target-id'),
				kind: 'sequence',
				sessionId: sessionA,
				createdAt: 1,
			},
		]);
		const edgeStore = new EdgeStore();
		const history = manager(persistence, { edgeStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(edgeStore.edgesForSession(sessionA)).toEqual([]);
	});

	it('restores a branch edge only when its target is a retained branch thought', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('branch-target');
		const branchId = asBranchId('retained-branch');
		const sourceId = asThoughtId('branch-source');
		const mainTargetId = asThoughtId('main-only-target');
		const branchTargetId = asThoughtId('branch-target-id');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1, { id: sourceId }));
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 2, { id: mainTargetId }));
		await persistence.saveBranchForSession(sessionA, branchId, [
			thought(sessionA, 3, { id: branchTargetId, branch_id: branchId }),
		]);
		const mainTargetEdge: Edge = {
			id: asEdgeId('main-target-branch-edge'),
			from: sourceId,
			to: mainTargetId,
			kind: 'branch',
			sessionId: sessionA,
			createdAt: 1,
		};
		const branchTargetEdge: Edge = {
			id: asEdgeId('branch-target-branch-edge'),
			from: sourceId,
			to: branchTargetId,
			kind: 'branch',
			sessionId: sessionA,
			createdAt: 2,
		};
		await persistence.saveEdges(sessionA, [mainTargetEdge, branchTargetEdge]);
		const edgeStore = new EdgeStore();
		const history = manager(persistence, { edgeStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(edgeStore.edgesForSession(sessionA)).toEqual([branchTargetEdge]);
	});

	it('T10-R06 rejects cross-partition thought scope without mutating the input or live state', async () => {
		// Given
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const misplaced = thought(sessionB, 1);
		const persistence = new MemoryPersistence();
		await persistence.saveThoughtForSession(sessionB, misplaced);
		const crossPartition = new (class extends MemoryPersistence {
			override async listSessions(): Promise<SessionId[]> {
				return [sessionA];
			}
			override async loadHistoryForSession(): Promise<ThoughtData[]> {
				return [misplaced];
			}
		})();
		const before = structuredClone(misplaced);
		const history = manager(crossPartition);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_SCOPE_MISMATCH',
		});
		expect(misplaced).toEqual(before);
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-R07 allows a missing thought id only in the global partition', async () => {
		// Given
		const globalWithoutId = thought(GLOBAL_SESSION_ID, 1);
		Reflect.deleteProperty(globalWithoutId, 'id');
		const persistence = new (class extends MemoryPersistence {
			override async listSessions(): Promise<SessionId[]> {
				return [GLOBAL_SESSION_ID];
			}
			override async loadHistoryForSession(): Promise<ThoughtData[]> {
				return [globalWithoutId];
			}
		})();
		const history = manager(persistence);

		// When
		await history.loadFromPersistence();

		// Then
		expect(history.getHistory(GLOBAL_SESSION_ID)).toEqual([globalWithoutId]);
	});

	it('T10-R08 rejects a missing thought id in a named partition before mutation', async () => {
		// Given
		const sessionA = asSessionId('A');
		const namedWithoutId = thought(sessionA, 1);
		Reflect.deleteProperty(namedWithoutId, 'id');
		const persistence = new (class extends MemoryPersistence {
			override async listSessions(): Promise<SessionId[]> {
				return [sessionA];
			}
			override async loadHistoryForSession(): Promise<ThoughtData[]> {
				return [namedWithoutId];
			}
		})();
		const history = manager(persistence);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-R09 stages every partition before atomically replacing any live state', async () => {
		// Given
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const persistence = new FailingPartitionPersistence(sessionB);
		await persistence.saveThought(thought(GLOBAL_SESSION_ID, 1));
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		await persistence.saveThoughtForSession(sessionB, thought(sessionB, 1));
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, { edgeStore, summaryStore });
		const liveThought = thought(GLOBAL_SESSION_ID, 99);
		const liveEdge = edge(GLOBAL_SESSION_ID, 'live-edge');
		const liveSummary = summary(GLOBAL_SESSION_ID, 'live-summary');
		history.addThought(liveThought);
		edgeStore.addEdge(liveEdge);
		summaryStore.add(liveSummary);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toThrow('read failed for B');
		expect(history.getHistory(GLOBAL_SESSION_ID)).toEqual([liveThought]);
		expect(history.getSessionIds()).toEqual([GLOBAL_SESSION_ID]);
		expect(edgeStore.edgesForSession(GLOBAL_SESSION_ID)).toEqual([liveEdge]);
		expect(summaryStore.forSession(GLOBAL_SESSION_ID)).toEqual([liveSummary]);
	});

	it('T10-R10 rejects a backend without the complete scoped capability', async () => {
		// Given
		const history = manager(new LegacyOnlyPersistence());

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toBeInstanceOf(PersistenceCapabilityError);
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-R11 rejects malformed listed session identities before live mutation', async () => {
		// Given
		const persistence = new (class extends MemoryPersistence {
			override async listSessions(): Promise<SessionId[]> {
				const sessions: SessionId[] = [];
				Array.prototype.push.call(sessions, 'bad/session');
				return sessions;
			}
		})();
		const history = manager(persistence);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-I01 rejects a listed branch that disappears during staging', async () => {
		// Given
		const sessionA = asSessionId('A');
		const persistence = new (class extends MemoryPersistence {
			override async listSessions(): Promise<SessionId[]> {
				return [sessionA];
			}
			override async listBranchesForSession(): Promise<BranchId[]> {
				return [asBranchId('missing')];
			}
		})();
		const history = manager(persistence);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-I02 restores same summary ids across sessions and rejects duplicates within one', async () => {
		// Given
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const valid = new MemoryPersistence();
		await valid.saveSummaries(sessionA, [summary(sessionA, 'same-id')]);
		await valid.saveSummaries(sessionB, [summary(sessionB, 'same-id')]);
		const summaryStore = new InMemorySummaryStore();
		const validHistory = manager(valid, { summaryStore });
		const duplicateSummary = summary(sessionA, 'duplicate-id');
		const invalid = new (class extends MemoryPersistence {
			override async listSessions(): Promise<SessionId[]> {
				return [sessionA];
			}
			override async loadSummaries(): Promise<Summary[]> {
				return [duplicateSummary, duplicateSummary];
			}
		})();
		const invalidHistory = manager(invalid, { summaryStore: new InMemorySummaryStore() });

		// When
		await validHistory.loadFromPersistence();

		// Then
		expect(summaryStore.forSession(sessionA)).toHaveLength(1);
		expect(summaryStore.forSession(sessionB)).toHaveLength(1);
		await expect(invalidHistory.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
	});

	it('T10-I03 reopens a File snapshot without changing bytes during restore retention', async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task10-file-'));
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const branchId = asBranchId('shared');
		try {
			const seed = await FilePersistence.create({ dataDir: root });
			for (const number of [1, 2, 3]) {
				await seed.saveThoughtForSession(sessionA, thought(sessionA, number));
			}
			await seed.saveThoughtForSession(
				sessionB,
				thought(sessionB, 1, { id: asThoughtId('file-edge-from') })
			);
			await seed.saveBranchForSession(sessionB, branchId, [
				thought(sessionB, 2, {
					id: asThoughtId('file-edge-to'),
					branch_id: branchId,
				}),
			]);
			await seed.saveBranchForSession(sessionA, branchId, [
				thought(sessionA, 4, { branch_id: branchId }),
				thought(sessionA, 5, { branch_id: branchId }),
			]);
			await seed.saveEdges(sessionB, [edge(sessionB, 'file-edge')]);
			await seed.saveSummaries(sessionA, [summary(sessionA, 'file-summary', branchId)]);
			await seed.close();
			const snapshotPath = join(root, 'snapshot.json');
			const before = await readFile(snapshotPath);
			const reopened = await FilePersistence.create({ dataDir: root });
			const edgeStore = new EdgeStore();
			const summaryStore = new InMemorySummaryStore();
			const history = manager(reopened, {
				edgeStore,
				summaryStore,
				maxHistorySize: 1,
				maxBranchSize: 1,
			});

			// When
			await history.loadFromPersistence();

			// Then
			expect(history.getHistory(sessionA).map((value) => value.thought_number)).toEqual([3]);
			expect(history.getBranch(branchId, sessionA)?.map((value) => value.thought_number)).toEqual([
				5,
			]);
			expect(edgeStore.edgesForSession(sessionB)).toHaveLength(1);
			expect(summaryStore.forSession(sessionA)).toHaveLength(1);
			expect(await readFile(snapshotPath)).toEqual(before);
			await reopened.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('T10-I04 rejects corrupt File input without changing its bytes', async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task10-corrupt-'));
		try {
			const snapshotPath = join(root, 'snapshot.json');
			const corrupt = Buffer.from('{"version":2,"thoughts":[');
			await writeFile(snapshotPath, corrupt);

			// When / Then
			await expect(FilePersistence.create({ dataDir: root })).rejects.toMatchObject({
				code: 'PERSISTENCE_CORRUPTION',
			});
			expect(await readFile(snapshotPath)).toEqual(corrupt);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('T10-I05 restores structural SQLite partitions without mutating the database', async () => {
		// Given
		const database = new StatefulSqliteDatabase();
		const persistence = SqlitePersistence.createWithDatabase(database);
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const branchId = asBranchId('shared');
		await persistence.saveThoughtForSession(
			sessionA,
			thought(sessionA, 1, { id: asThoughtId('sqlite-edge-from') })
		);
		await persistence.saveThoughtForSession(sessionB, thought(sessionB, 1));
		await persistence.saveBranchForSession(sessionA, branchId, [
			thought(sessionA, 2, {
				id: asThoughtId('sqlite-edge-to'),
				branch_id: branchId,
			}),
		]);
		await persistence.saveBranchForSession(sessionB, branchId, [
			thought(sessionB, 2, { branch_id: branchId }),
		]);
		await persistence.saveEdges(sessionA, [edge(sessionA, 'sqlite-edge')]);
		await persistence.saveSummaries(sessionB, [summary(sessionB, 'sqlite-summary')]);
		const before = database.snapshot();
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, { edgeStore, summaryStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(history.getHistory(sessionA)).toHaveLength(1);
		expect(history.getHistory(sessionB)).toHaveLength(1);
		expect(history.getBranch(branchId, sessionA)).toHaveLength(1);
		expect(history.getBranch(branchId, sessionB)).toHaveLength(1);
		expect(edgeStore.edgesForSession(sessionA)).toHaveLength(1);
		expect(summaryStore.forSession(sessionB)).toHaveLength(1);
		expect(database.snapshot()).toEqual(before);
		await persistence.close();
	});

	it('T10-O01/O02 ownerless access can mutate restored data without removing provenance', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const history = manager(persistence);
		await history.loadFromPersistence();

		// When
		history.addThought(thought(sessionA, 2));

		// Then
		expect(history.getHistory(sessionA)).toHaveLength(2);
		expect(() =>
			runWithContext({ requestId: 'owner-read', owner: 'network-owner' }, () =>
				history.getHistory(sessionA)
			)
		).toThrow(SessionAccessDeniedError);
	});

	it('T10-O03 rejects owner-aware reads, writes, registration, and reset on restored data', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const history = manager(persistence);
		await history.loadFromPersistence();

		// When / Then
		await runWithContext({ requestId: 'owner-actions', owner: 'network-owner' }, async () => {
			expect(() => history.getHistory(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getHistoryLength(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getBranches(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getBranchIds(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.branchExists(sessionA, asBranchId('new'))).toThrow(
				SessionAccessDeniedError
			);
			expect(() => history.getAvailableMcpTools(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getAvailableSkills(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getBranch(asBranchId('new'), sessionA)).toThrow(
				SessionAccessDeniedError
			);
			expect(() => history.inspectSession(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.addThought(thought(sessionA, 2))).toThrow(SessionAccessDeniedError);
			expect(() => history.registerBranch(sessionA, asBranchId('new'))).toThrow(
				SessionAccessDeniedError
			);
			await expect(history.resetSession(sessionA)).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});
		expect(history.getHistory(sessionA)).toHaveLength(1);
	});

	it('T10-O04 rejects owner-aware global, edge-only, and summary-only restored namespaces', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const edgeOnly = asSessionId('edge-only');
		const summaryOnly = asSessionId('summary-only');
		await persistence.saveThought(thought(GLOBAL_SESSION_ID, 1));
		await persistence.saveEdges(edgeOnly, [edge(edgeOnly, 'edge-id')]);
		await persistence.saveSummaries(summaryOnly, [summary(summaryOnly, 'summary-id')]);
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, {
			edgeStore,
			summaryStore,
		});
		await history.loadFromPersistence();

		// When / Then
		await runWithContext({ requestId: 'owner-edge', owner: 'network-owner' }, async () => {
			expect(() => history.getHistory()).toThrow(SessionAccessDeniedError);
			expect(() => history.getHistory(edgeOnly)).toThrow(SessionAccessDeniedError);
			expect(() => history.getHistory(summaryOnly)).toThrow(SessionAccessDeniedError);
			await expect(history.resetSession(GLOBAL_SESSION_ID)).rejects.toBeInstanceOf(
				SessionAccessDeniedError
			);
			await expect(history.resetSession(edgeOnly)).rejects.toBeInstanceOf(SessionAccessDeniedError);
			await expect(history.resetSession(summaryOnly)).rejects.toBeInstanceOf(
				SessionAccessDeniedError
			);
		});
		expect(history.getHistory()).toHaveLength(1);
		expect(edgeStore.edgesForSession(edgeOnly)).toEqual([]);
		expect(summaryStore.forSession(summaryOnly)).toHaveLength(1);
	});

	it('T10-O05 successful ownerless reset removes restored provenance', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const history = manager(persistence);
		await history.loadFromPersistence();

		// When
		await history.resetSession(sessionA);

		// Then
		runWithContext({ requestId: 'owner-after-reset', owner: 'network-owner' }, () => {
			expect(history.getHistory(sessionA)).toEqual([]);
		});
	});

	it('T10-O06 failed ownerless reset preserves restored provenance', async () => {
		// Given
		const persistence = new FailedResetPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const history = manager(persistence);
		await history.loadFromPersistence();

		// When
		await expect(history.resetSession(sessionA)).rejects.toThrow('clear failed for A');

		// Then
		expect(() =>
			runWithContext({ requestId: 'owner-after-failure', owner: 'network-owner' }, () =>
				history.getHistory(sessionA)
			)
		).toThrow(SessionAccessDeniedError);
		expect(history.getHistory(sessionA)).toHaveLength(1);
	});

	it('T10-O07 resetAll removes restored provenance only after durable success', async () => {
		// Given
		const sessionA = asSessionId('A');
		const successful = new MemoryPersistence();
		await successful.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const resetHistory = manager(successful);
		await resetHistory.loadFromPersistence();
		const failing = new FailedResetPersistence();
		await failing.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const failedHistory = manager(failing);
		await failedHistory.loadFromPersistence();

		// When
		await resetHistory.resetAll();
		await expect(failedHistory.resetAll()).rejects.toThrow('clear all failed');

		// Then
		runWithContext({ requestId: 'owner-reset-all', owner: 'network-owner' }, () => {
			expect(resetHistory.getHistory(sessionA)).toEqual([]);
			expect(() => failedHistory.getHistory(sessionA)).toThrow(SessionAccessDeniedError);
		});
	});
});
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
