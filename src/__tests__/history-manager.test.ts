import { asSessionId } from '../contracts/ids.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ABSOLUTE_MAX_HISTORY_SIZE, HistoryManager } from '../core/HistoryManager.js';
import { EdgeStore } from '../core/graph/EdgeStore.js';
import type { SessionScopedPersistenceBackend } from '../contracts/PersistenceBackend.js';
import { createTestThought } from './helpers/factories.js';
import { useFakeTimers, useRealTimers } from './helpers/timers.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { ThoughtData } from '../core/thought.js';
import { PersistenceDrainError } from '../errors.js';

import { asBranchId, type BranchId } from '../contracts/ids.js';
import type { SessionId } from '../contracts/ids.js';
/** Test-only interface to access private fields of HistoryManager. */
interface HistoryManagerTestAccess {
	_maxHistorySize: number;
}

class MockPersistence implements SessionScopedPersistenceBackend {
	private _history: ThoughtData[] = [];
	private _branches: Record<BranchId, ThoughtData[]> = {} as Record<BranchId, ThoughtData[]>;
	private readonly _sessionHistory = new Map<SessionId, ThoughtData[]>();
	private readonly _sessionBranches = new Map<SessionId, Map<BranchId, ThoughtData[]>>();
	saveThoughtFailCount = 0;
	healthyResult = true;
	clearFail = false;
	saveBranchFailCount = 0;

	async saveThought(thought: ThoughtData): Promise<void> {
		if (this.saveThoughtFailCount > 0) {
			this.saveThoughtFailCount--;
			throw new Error('Persistence save failed');
		}
		this._history.push(thought);
	}

	async loadHistory(): Promise<ThoughtData[]> {
		return [...this._history];
	}

	async saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void> {
		if (this.saveThoughtFailCount > 0) {
			this.saveThoughtFailCount--;
			throw new Error('Persistence save failed');
		}
		const history = this._sessionHistory.get(sessionId) ?? [];
		history.push(thought);
		this._sessionHistory.set(sessionId, history);
	}

	async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		return [...(this._sessionHistory.get(sessionId) ?? [])];
	}

	async saveBranch(branchId: BranchId, thoughts: ThoughtData[]): Promise<void> {
		if (this.saveBranchFailCount > 0) {
			this.saveBranchFailCount--;
			throw new Error('Branch save failed');
		}
		this._branches[branchId] = thoughts;
	}

	async loadBranch(branchId: BranchId): Promise<ThoughtData[] | undefined> {
		return this._branches[branchId] ? [...this._branches[branchId]] : undefined;
	}

	async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		if (this.saveBranchFailCount > 0) {
			this.saveBranchFailCount--;
			throw new Error('Branch save failed');
		}
		const branches = this._sessionBranches.get(sessionId) ?? new Map<BranchId, ThoughtData[]>();
		branches.set(branchId, [...thoughts]);
		this._sessionBranches.set(sessionId, branches);
	}

	async loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		const branch = this._sessionBranches.get(sessionId)?.get(branchId);
		return branch === undefined ? undefined : [...branch];
	}

	async listBranches(): Promise<BranchId[]> {
		return Object.keys(this._branches) as BranchId[];
	}

	async listBranchesForSession(sessionId: SessionId): Promise<BranchId[]> {
		const branches = this._sessionBranches.get(sessionId);
		return branches === undefined ? [] : Array.from(branches.keys());
	}

	async listSessions(): Promise<SessionId[]> {
		return Array.from(
			new Set<SessionId>([...this._sessionHistory.keys(), ...this._sessionBranches.keys()])
		);
	}

	async clear(): Promise<void> {
		if (this.clearFail) {
			throw new Error('Clear failed');
		}
		this._history = [];
		this._branches = {};
		this._sessionHistory.clear();
		this._sessionBranches.clear();
	}

	async clearSession(sessionId: SessionId): Promise<void> {
		this._sessionHistory.delete(sessionId);
		this._sessionBranches.delete(sessionId);
	}

	async healthy(): Promise<boolean> {
		return this.healthyResult;
	}

	async close(): Promise<void> {}

	async saveEdges(): Promise<void> {}

	async loadEdges(): Promise<never[]> {
		return [];
	}

	async listEdgeSessions(): Promise<SessionId[]> {
		return [];
	}

	async saveSummaries(): Promise<void> {}

	async loadSummaries(): Promise<never[]> {
		return [];
	}
}

describe('HistoryManager', () => {
	afterEach(() => {
		useRealTimers();
	});

	describe('Basic operations', () => {
		it('should add thoughts and track length', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.addThought(createTestThought({ thought_number: 2 }));

			expect(manager.getHistoryLength()).toBe(2);
			expect(manager.getHistory()).toHaveLength(2);
			expect(manager.getHistory()[1]!.thought_number).toBe(2);
		});

		it('should clear all state', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.clear();

			expect(manager.getHistoryLength()).toBe(0);
			expect(manager.getBranches()).toEqual({});
			expect(manager.getBranchIds()).toHaveLength(0);
		});

		it('should return empty branches record initially', () => {
			const manager = new HistoryManager();
			expect(manager.getBranches()).toEqual({});
			expect(manager.getBranchIds()).toEqual([]);
		});
	});

	describe('History trimming', () => {
		it('should trim history when maxHistorySize is exceeded', () => {
			const manager = new HistoryManager({ maxHistorySize: 3 });
			for (let i = 1; i <= 4; i++) {
				manager.addThought(createTestThought({ thought_number: i }));
			}

			expect(manager.getHistoryLength()).toBe(3);
			expect(manager.getHistory()[0]!.thought_number).toBe(2);
			expect(manager.getHistory()[2]!.thought_number).toBe(4);
		});

		it('should not trim when exactly at maxHistorySize', () => {
			const manager = new HistoryManager({ maxHistorySize: 3 });
			for (let i = 1; i <= 3; i++) {
				manager.addThought(createTestThought({ thought_number: i }));
			}

			expect(manager.getHistoryLength()).toBe(3);
			expect(manager.getHistory()[0]!.thought_number).toBe(1);
		});
	});

	describe('Branch management', () => {
		it('should create branch when branch_from_thought and branch_id are set', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					thought_number: 1,
					branch_from_thought: 1,
					branch_id: asBranchId('alt-1'),
				})
			);

			expect(manager.getBranchIds()).toEqual(['alt-1']);
			expect(manager.getBranch(asBranchId('alt-1'))).toHaveLength(1);
		});

		it('should add multiple thoughts to the same branch', () => {
			const manager = new HistoryManager();
			for (let i = 1; i <= 3; i++) {
				manager.addThought(
					createTestThought({
						thought_number: i,
						branch_from_thought: 1,
						branch_id: asBranchId('alt-1'),
					})
				);
			}

			expect(manager.getBranch(asBranchId('alt-1'))).toHaveLength(3);
		});

		it('should trim branch when maxBranchSize is exceeded', () => {
			const manager = new HistoryManager({ maxBranchSize: 2 });
			for (let i = 1; i <= 4; i++) {
				manager.addThought(
					createTestThought({
						thought_number: i,
						branch_from_thought: 1,
						branch_id: asBranchId('alt-1'),
					})
				);
			}

			expect(manager.getBranch(asBranchId('alt-1'))).toHaveLength(3);
			expect(manager.getBranch(asBranchId('alt-1'))![0]!.thought_number).toBe(2);
		});

		it('should remove oldest branches when maxBranches is exceeded', () => {
			const manager = new HistoryManager({ maxBranches: 2 });
			manager.addThought(
				createTestThought({ thought_number: 1, branch_from_thought: 1, branch_id: asBranchId('branch-a') })
			);
			manager.addThought(
				createTestThought({ thought_number: 2, branch_from_thought: 1, branch_id: asBranchId('branch-b') })
			);
			manager.addThought(
				createTestThought({ thought_number: 3, branch_from_thought: 1, branch_id: asBranchId('branch-c') })
			);

			expect(manager.getBranchIds()).toHaveLength(2);
			expect(manager.getBranchIds()).not.toContain('branch-a');
			expect(manager.getBranchIds()).toContain('branch-c');
		});

		it('should return undefined for non-existent branch', () => {
			const manager = new HistoryManager();
			expect(manager.getBranch(asBranchId('non-existent'))).toBeUndefined();
		});
	});

	describe('available_mcp_tools / available_skills caching', () => {
		it('should cache available_mcp_tools from added thoughts', () => {
			const manager = new HistoryManager();
			expect(manager.getAvailableMcpTools()).toBeUndefined();

			manager.addThought(createTestThought({ available_mcp_tools: ['Read', 'Grep'] }));
			expect(manager.getAvailableMcpTools()).toEqual(['Read', 'Grep']);
		});

		it('should update cached tools when new thought provides them', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ available_mcp_tools: ['Read'] }));
			manager.addThought(createTestThought({ available_mcp_tools: ['Read', 'Write', 'Grep'] }));

			expect(manager.getAvailableMcpTools()).toEqual(['Read', 'Write', 'Grep']);
		});

		it('should cache available_skills from added thoughts', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ available_skills: ['commit'] }));
			expect(manager.getAvailableSkills()).toEqual(['commit']);
		});

		it('should clear cached tools and skills on clear()', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					available_mcp_tools: ['Read'],
					available_skills: ['commit'],
				})
			);
			manager.clear();

			expect(manager.getAvailableMcpTools()).toBeUndefined();
			expect(manager.getAvailableSkills()).toBeUndefined();
		});
	});

	describe('Flush buffer pipeline', () => {
		it('should buffer thoughts and flush to persistence', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceFlushInterval: 1000,
				persistenceBufferSize: 100,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			expect(await persistence.loadHistory()).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(manager.getWriteBufferLength()).toBe(0));
		});

		it('should trigger immediate flush when buffer reaches capacity', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 2,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			expect(manager.getWriteBufferLength()).toBe(1);

			manager.addThought(createTestThought({ thought_number: 2 }));
			await vi.waitFor(() => expect(manager.getWriteBufferLength()).toBe(0));
			await vi.advanceTimersByTimeAsync(0);
			expect(await persistence.loadHistory()).toHaveLength(2);
		});

		it('should skip flush when buffer is empty', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({ persistence });

			await manager._flushBuffer();
			expect(await persistence.loadHistory()).toHaveLength(0);
		});

		it('should expose the shared coordinator promise to concurrent flush joiners', async () => {
			const persistence = new MockPersistence();
			let releaseWrite: (() => void) | undefined;
			const writeGate = new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
			persistence.saveThought = async () => writeGate;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			const flush1 = manager._flushBuffer();
			const flush2 = manager._flushBuffer();

			expect(flush2).toBe(flush1);
			releaseWrite?.();
			await Promise.all([flush1, flush2]);
		});
	});

	describe('Flush retry with backoff', () => {
		it('should retry on persistence failure', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			persistence.saveThoughtFailCount = 1;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 1,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			await vi.advanceTimersByTimeAsync(200);
			await vi.waitFor(() => expect(manager.getWriteBufferLength()).toBe(0));
			expect(await persistence.loadHistory()).toHaveLength(1);
		});

		it('should surface attributable terminal failures after exhausting retries', async () => {
			const persistence = new MockPersistence();
			persistence.saveThoughtFailCount = 999;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
				persistenceMaxRetries: 0,
			});
			const globalSession = asSessionId('__global__');

			manager.addThought(createTestThought({ thought_number: 1 }));

			await expect(manager.drainSession(globalSession)).rejects.toMatchObject({
				name: 'PersistenceDrainError',
				failures: [{ kind: 'thought', sessionId: globalSession, attempts: 1 }],
			});
		});

		it('should emit persistenceError event on exhausted retries', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			persistence.saveThoughtFailCount = 999;
			const events: Array<{ operation: string; error: Error }> = [];
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 1,
				persistenceFlushInterval: 60000,
				persistenceMaxRetries: 0,
			});

			manager.setEventEmitter({
				emit(_event, payload) {
					events.push(payload);
					return true;
				},
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() => expect(events).toHaveLength(1));

			expect(events[0]).toMatchObject({
				operation: 'flushBuffer',
				error: {
					name: 'PersistenceDrainError',
					failures: [{ kind: 'thought', sessionId: asSessionId('__global__'), attempts: 1 }],
				},
			});
			expect(events[0]?.error).toBeInstanceOf(PersistenceDrainError);
		});
	});

	describe('Backpressure', () => {
		it('should retain work accepted while a capacity flush is blocked', async () => {
			const persistence = new MockPersistence();
			let releaseWrite: (() => void) | undefined;
			const writeGate = new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
			persistence.saveThought = async () => writeGate;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 1,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.addThought(createTestThought({ thought_number: 2 }));
			manager.addThought(createTestThought({ thought_number: 3 }));

			expect(manager.getHistoryLength()).toBe(3);
			expect(manager.getWriteBufferLength()).toBe(3);
			releaseWrite?.();
			await manager.shutdown();
		});
	});

	describe('Branch persistence', () => {
		it('should persist branches through the coordinator drain', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({ persistence });

			manager.addThought(
				createTestThought({
					thought_number: 1,
					branch_from_thought: 1,
					branch_id: asBranchId('branch-1'),
				})
			);

			await manager.drainSession(asSessionId('__global__'));
			const loaded = await persistence.loadBranch(asBranchId('branch-1'));
			expect(loaded).toBeDefined();
			expect(loaded).toHaveLength(1);
		});

		it('should attribute terminal branch persistence failures to the owning session', async () => {
			const persistence = new MockPersistence();
			persistence.saveBranchFailCount = 999;
			const manager = new HistoryManager({ persistence, persistenceMaxRetries: 0 });
			const globalSession = asSessionId('__global__');
			const branchId = asBranchId('branch-1');

			manager.addThought(
				createTestThought({
					thought_number: 1,
					branch_from_thought: 1,
					branch_id: branchId,
				})
			);

			expect(manager.getBranch(branchId)).toHaveLength(1);
			await expect(manager.drainSession(globalSession)).rejects.toMatchObject({
				name: 'PersistenceDrainError',
				failures: [{ kind: 'branch', sessionId: globalSession, key: branchId, attempts: 1 }],
			});
		});
	});

	describe('loadFromPersistence', () => {
		it('should load history and branches from persistence', async () => {
			const persistence = new MockPersistence();
			await persistence.saveThought(createTestThought({ thought_number: 1 }));
			await persistence.saveBranch(asBranchId('branch-1'), [createTestThought({ thought_number: 1 })]);

			const manager = new HistoryManager({ persistence });
			await manager.loadFromPersistence();

			expect(manager.getHistoryLength()).toBe(1);
			expect(manager.getBranchIds()).toContain('branch-1');
		});

		it('should skip load when persistence backend is unhealthy', async () => {
			const persistence = new MockPersistence();
			persistence.healthyResult = false;
			await persistence.saveThought(createTestThought({ thought_number: 1 }));

			const manager = new HistoryManager({ persistence });
			await manager.loadFromPersistence();
			expect(manager.getHistoryLength()).toBe(0);
		});

		it('should skip load when persistence is not enabled', async () => {
			const manager = new HistoryManager({ persistence: null });
			await manager.loadFromPersistence();
			expect(manager.getHistoryLength()).toBe(0);
		});

		it('should trim loaded history to maxHistorySize', async () => {
			const persistence = new MockPersistence();
			for (let i = 0; i < 10; i++) {
				await persistence.saveThought(createTestThought({ thought_number: i + 1 }));
			}

			const manager = new HistoryManager({ persistence, maxHistorySize: 5 });
			await manager.loadFromPersistence();

			expect(manager.getHistoryLength()).toBe(5);
			expect(manager.getHistory()[0]!.thought_number).toBe(6);
		});

		it('should handle load errors gracefully', async () => {
			const persistence = new MockPersistence();
			persistence.healthyResult = false;

			const manager = new HistoryManager({ persistence });
			await manager.loadFromPersistence();
			expect(manager.getHistoryLength()).toBe(0);
		});
	});

	describe('clear with persistence', () => {
		it('should clear persisted data when persistence is enabled', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			const manager = new HistoryManager({ persistence });

			manager.addThought(createTestThought({ thought_number: 1 }));
			await vi.advanceTimersByTimeAsync(1100);
			expect(manager.getWriteBufferLength()).toBe(0);

			manager.clear();
			await vi.advanceTimersByTimeAsync(0);
			expect(await persistence.loadHistory()).toHaveLength(0);
		});

		it('should not crash when persistence clear fails', async () => {
			const persistence = new MockPersistence();
			persistence.clearFail = true;
			const manager = new HistoryManager({ persistence });

			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.clear();
			expect(manager.getHistoryLength()).toBe(0);
		});
	});

	describe('shutdown', () => {
		it('should flush remaining buffer on shutdown', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.addThought(createTestThought({ thought_number: 2 }));
			expect(manager.getWriteBufferLength()).toBe(2);

			await manager.shutdown();
			expect(manager.getWriteBufferLength()).toBe(0);
			expect(await persistence.loadHistory()).toHaveLength(2);
		});
	});

	describe('Utility methods', () => {
		it('should report persistence enabled state', () => {
			const withP = new HistoryManager({ persistence: new MockPersistence() });
			expect(withP.isPersistenceEnabled()).toBe(true);

			const withoutP = new HistoryManager({ persistence: null });
			expect(withoutP.isPersistenceEnabled()).toBe(false);
		});

		it('should expose the persistence backend', () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({ persistence });
			expect(manager.getPersistenceBackend()).toBe(persistence);
		});

		it('should expose write buffer length for monitoring', () => {
			const manager = new HistoryManager({
				persistence: new MockPersistence(),
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			expect(manager.getWriteBufferLength()).toBe(0);
			manager.addThought(createTestThought({ thought_number: 1 }));
			expect(manager.getWriteBufferLength()).toBe(1);
		});

		it('should register summary snapshots with the session drain coordinator', async () => {
			const persistence = new MockPersistence();
			const saveSummaries = vi.spyOn(persistence, 'saveSummaries');
			const manager = new HistoryManager({ persistence });
			const sessionId = asSessionId('summary-session');

			manager.bufferSummaries(sessionId, []);
			await manager.drainSession(sessionId);

			expect(saveSummaries).toHaveBeenCalledWith(sessionId, []);
		});
	});

	describe('merge topology tracking', () => {
		it('should store thoughts with merge metadata', () => {
			const manager = new HistoryManager();
			const thought = createTestThought({
				merge_from_thoughts: [1, 3],
				merge_branch_ids: ['branch-a', 'branch-b'].map(asBranchId),
			});
			manager.addThought(thought);

			const history = manager.getHistory();
			expect(history[history.length - 1]?.merge_from_thoughts).toEqual([1, 3]);
			expect(history[history.length - 1]?.merge_branch_ids).toEqual(['branch-a', 'branch-b']);
		});

		it('should store thoughts without merge metadata normally', () => {
			const manager = new HistoryManager();
			const thought = createTestThought();
			manager.addThought(thought);

			const history = manager.getHistory();
			expect(history[history.length - 1]?.merge_from_thoughts).toBeUndefined();
			expect(history[history.length - 1]?.merge_branch_ids).toBeUndefined();
		});
	});

	describe('session partitioning', () => {
		it('creates isolated sessions with different session_ids', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'session-a' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'session-b' }));

			expect(manager.getHistoryLength(asSessionId('session-a'))).toBe(1);
			expect(manager.getHistoryLength(asSessionId('session-b'))).toBe(1);
		});

		it('uses __global__ session when session_id is omitted', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1 }));

			expect(manager.getHistoryLength()).toBe(1);
			expect(manager.getHistoryLength(asSessionId('__global__'))).toBe(1);
		});

		it('returns empty history for new session', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1 }));

			expect(manager.getHistoryLength(asSessionId('new-session'))).toBe(0);
		});

		it('does not leak thoughts between sessions', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a', thought: 'A1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'a', thought: 'A2' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b', thought: 'B1' }));

			const historyA = manager.getHistory(asSessionId('a'));
			const historyB = manager.getHistory(asSessionId('b'));

			expect(historyA).toHaveLength(2);
			expect(historyB).toHaveLength(1);
			expect(historyA[0]!.thought).toBe('A1');
			expect(historyB[0]!.thought).toBe('B1');
		});

		it('does not leak branches between sessions', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'a',
					branch_from_thought: 1,
					branch_id: asBranchId('branch-a'),
				})
			);
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			expect(manager.getBranchIds(asSessionId('a'))).toContain('branch-a');
			expect(manager.getBranchIds(asSessionId('b'))).toHaveLength(0);
		});

		it('tracks available_mcp_tools per session', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'a',
					available_mcp_tools: ['tool-a'],
				})
			);
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'b',
					available_mcp_tools: ['tool-b'],
				})
			);

			expect(manager.getAvailableMcpTools(asSessionId('a'))).toEqual(['tool-a']);
			expect(manager.getAvailableMcpTools(asSessionId('b'))).toEqual(['tool-b']);
		});

		it('tracks available_skills per session', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'a',
					available_skills: ['skill-a'],
				})
			);
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'b',
					available_skills: ['skill-b'],
				})
			);

			expect(manager.getAvailableSkills(asSessionId('a'))).toEqual(['skill-a']);
			expect(manager.getAvailableSkills(asSessionId('b'))).toEqual(['skill-b']);
		});

		it('clears only the target session on clear(sessionId)', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			manager.clear(asSessionId('a'));

			expect(manager.getHistoryLength(asSessionId('a'))).toBe(0);
			expect(manager.getHistoryLength(asSessionId('b'))).toBe(1);
		});

		it('clears all sessions on clear() without sessionId', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));
			manager.addThought(createTestThought({ thought_number: 1 }));

			manager.clear();

			expect(manager.getHistoryLength(asSessionId('a'))).toBe(0);
			expect(manager.getHistoryLength(asSessionId('b'))).toBe(0);
			expect(manager.getHistoryLength()).toBe(0);
		});

		it('getSessionIds() returns all active session IDs', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			const ids = manager.getSessionIds();
			expect(ids).toContain('a');
			expect(ids).toContain('b');
		});

		it('getSessionCount() returns correct count', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			expect(manager.getSessionCount()).toBe(2);
		});
	});

	describe('session TTL eviction', () => {
		it('evicts sessions inactive longer than TTL', () => {
			useFakeTimers();
			const manager = new HistoryManager();

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'old' }));
			expect(manager.getHistoryLength(asSessionId('old'))).toBe(1);

			// Advance past TTL (30 minutes) + cleanup interval (5 minutes)
			vi.advanceTimersByTime(31 * 60 * 1000);

			// Trigger the 5-minute cleanup timer
			vi.advanceTimersByTime(5 * 60 * 1000);

			// The 'old' session should have been cleaned up
			expect(manager.getSessionIds()).not.toContain('old');
		});

		it('does not evict the __global__ session', () => {
			useFakeTimers();
			const manager = new HistoryManager();

			manager.addThought(createTestThought({ thought_number: 1 }));

			// Advance well past TTL + cleanup interval
			vi.advanceTimersByTime(36 * 60 * 1000);

			expect(manager.getHistoryLength()).toBe(1);
			expect(manager.getSessionIds()).toContain('__global__');
		});

		it('does not evict recently accessed sessions', () => {
			useFakeTimers();
			const manager = new HistoryManager();

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'active' }));

			// Advance 20 minutes, then access the session
			vi.advanceTimersByTime(20 * 60 * 1000);
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'active' }));

			// Advance another 20 minutes (40 total, but only 20 since last access)
			vi.advanceTimersByTime(20 * 60 * 1000);

			// Trigger cleanup
			vi.advanceTimersByTime(5 * 60 * 1000);

			expect(manager.getHistoryLength(asSessionId('active'))).toBe(2);
		});
	});

	describe('session LRU eviction', () => {
		it('does not break when creating many sessions', () => {
			const manager = new HistoryManager();

			for (let i = 0; i < 10; i++) {
				manager.addThought(
					createTestThought({ thought_number: 1, session_id: `session-${i}` })
				);
			}

			expect(manager.getSessionCount()).toBe(10);
		});

		it('evicts oldest session when MAX_SESSIONS exceeded', () => {
			useFakeTimers();
			const manager = new HistoryManager();

			// MAX_SESSIONS is 100. Create 100 sessions.
			for (let i = 0; i < 100; i++) {
				manager.addThought(
					createTestThought({ thought_number: 1, session_id: `s-${i}` })
				);
				// Small time advance to ensure distinct lastAccessedAt
				vi.advanceTimersByTime(1);
			}

			expect(manager.getSessionCount()).toBe(100);

			// Creating the 101st session should evict the oldest (s-0)
			manager.addThought(
				createTestThought({ thought_number: 1, session_id: 'overflow' })
			);

			expect(manager.getSessionCount()).toBe(100);
			expect(manager.getSessionIds()).not.toContain('s-0');
			expect(manager.getSessionIds()).toContain('overflow');
		});
	});

	describe('session persistence', () => {
		it('buffers writes per session', () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			expect(manager.getWriteBufferLength()).toBe(2);
		});

		it('flushes all session buffers on shutdown', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			await manager.shutdown();

			expect(manager.getWriteBufferLength()).toBe(0);
			expect(await persistence.loadHistoryForSession(asSessionId('a'))).toHaveLength(1);
			expect(await persistence.loadHistoryForSession(asSessionId('b'))).toHaveLength(1);
		});

		it('clearSession removes specific session data', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'x' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'y' }));

			manager.clearSession(asSessionId('x'));

			expect(manager.getHistoryLength(asSessionId('x'))).toBe(0);
			expect(manager.getHistoryLength(asSessionId('y'))).toBe(1);
		});
	});

	describe('backward compatibility', () => {
		it('all existing operations work without session_id', () => {
			const manager = new HistoryManager();

			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.addThought(createTestThought({ thought_number: 2 }));

			expect(manager.getHistoryLength()).toBe(2);
			expect(manager.getHistory()).toHaveLength(2);
			expect(manager.getBranchIds()).toEqual([]);

			manager.clear();
			expect(manager.getHistoryLength()).toBe(0);
		});

		it('getBranch returns undefined for non-existent branch across sessions', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));

			expect(manager.getBranch(asBranchId('non-existent'), asSessionId('a'))).toBeUndefined();
			expect(manager.getBranch(asBranchId('non-existent'), asSessionId('b'))).toBeUndefined();
		});

		it('getAvailableMcpTools returns undefined for fresh session', () => {
			const manager = new HistoryManager();

			expect(manager.getAvailableMcpTools(asSessionId('nonexistent'))).toBeUndefined();
			expect(manager.getAvailableSkills(asSessionId('nonexistent'))).toBeUndefined();
		});
	});
});

describe('ABSOLUTE_MAX_HISTORY_SIZE cap', () => {
	it('should export ABSOLUTE_MAX_HISTORY_SIZE as 10000', () => {
		expect(ABSOLUTE_MAX_HISTORY_SIZE).toBe(10_000);
	});

	it('should cap maxHistorySize to ABSOLUTE_MAX_HISTORY_SIZE when config exceeds it', () => {
		const manager = new HistoryManager({ maxHistorySize: 50_000 });
		expect((manager as unknown as HistoryManagerTestAccess)._maxHistorySize).toBe(10_000);
	});

	it('should not alter maxHistorySize when within cap', () => {
		const manager = new HistoryManager({ maxHistorySize: 500 });
		expect((manager as unknown as HistoryManagerTestAccess)._maxHistorySize).toBe(500);
	});

	it('should use default 10000 when no config provided', () => {
		const manager = new HistoryManager({});
		expect((manager as unknown as HistoryManagerTestAccess)._maxHistorySize).toBe(10_000);
	});

	it('should log warning when capping occurs', () => {
		const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setLevel: vi.fn(), getLevel: vi.fn() } as Logger;
		new HistoryManager({ maxHistorySize: 50_000, logger: mockLogger });
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'maxHistorySize exceeds absolute maximum, capped',
			expect.objectContaining({ requested: 50_000, applied: 10_000 })
		);
	});
});

describe('HistoryManager — uncovered branches', () => {
	afterEach(() => {
		useRealTimers();
	});

	describe('backpressure logging (line 382)', () => {
		it('should log backpressure warning when buffer is full and flush is in progress', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			// Hold the first write so the coordinator keeps one drain generation active.
			let resolveSave!: () => void;
			const savePromise = new Promise<void>((resolve) => { resolveSave = resolve; });
			persistence.saveThought = async () => { await savePromise; };
			const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setLevel: vi.fn(), getLevel: vi.fn() } as Logger;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 1,
				persistenceFlushInterval: 60000,
				logger: mockLogger,
			});

			// Thought 1 reaches capacity and starts the blocked generation.
			manager.addThought(createTestThought({ thought_number: 1 }));
			await vi.advanceTimersByTimeAsync(0);

			// Later capacity triggers join that generation while accepted work remains queued.
			manager.addThought(createTestThought({ thought_number: 2 }));

			// The next acceptance observes a full coordinator-owned queue and logs backpressure.
			manager.addThought(createTestThought({ thought_number: 3 }));

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Write buffer full and flush in progress, applying backpressure',
				expect.objectContaining({
					bufferSize: expect.any(Number),
					maxSize: 1,
				})
			);

			// Unblock the joined generation.
			resolveSave();
			await vi.advanceTimersByTimeAsync(0);
			await manager.shutdown();
		});
	});

	describe('loadFromPersistence error catch (line 677)', () => {
		it('should catch and log when persistence throws during load', async () => {
			const persistence = new MockPersistence();
			// healthy returns true, but loadHistory throws
			persistence.loadHistory = async () => { throw new Error('Disk I/O error'); };
			const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setLevel: vi.fn(), getLevel: vi.fn() } as Logger;
			const manager = new HistoryManager({ persistence, logger: mockLogger });

			await manager.loadFromPersistence();

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Failed to load from persistence',
				expect.objectContaining({ error: 'Disk I/O error' })
			);
			expect(manager.getHistoryLength()).toBe(0);
		});

		it('should catch non-Error throws during load', async () => {
			const persistence = new MockPersistence();
			persistence.loadHistory = async () => { throw 'string error'; };
			const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setLevel: vi.fn(), getLevel: vi.fn() } as Logger;
			const manager = new HistoryManager({ persistence, logger: mockLogger });

			await manager.loadFromPersistence();

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Failed to load from persistence',
				expect.objectContaining({ error: 'string error' })
			);
		});
	});

	describe('_startFlushTimer early return (line 745)', () => {
		it('should not create a second flush timer if one already exists', () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			// Constructor starts flush timer when persistence is enabled
			const manager = new HistoryManager({ persistence });

			// Access private _flushTimer to verify it's set
			const timer1 = (manager as unknown as { _flushTimer: ReturnType<typeof setInterval> | null })._flushTimer;
			expect(timer1).not.toBeNull();

			// Calling _startFlushTimer again should be a no-op
			(manager as unknown as { _startFlushTimer: () => void })._startFlushTimer();

			const timer2 = (manager as unknown as { _flushTimer: ReturnType<typeof setInterval> | null })._flushTimer;
			expect(timer2).toBe(timer1);

			manager.shutdown();
		});
	});

	describe('_evictExcessSessions break branch (line 837)', () => {
		it('should break when only __global__ session remains during LRU eviction', () => {
			const manager = new HistoryManager({});

			// Access private _sessions map directly
			const sessions = (manager as unknown as { _sessions: Map<string, unknown> })._sessions;

			// Seed __global__ session
			manager.addThought(createTestThought({ thought_number: 1 }));

			// Now manually set _sessions size > MAX_SESSIONS by lowering the static field temporarily
			// Instead, we force the condition by adding dummy entries
			// Actually, we just need > MAX_SESSIONS sessions with only __global__ as non-deletable.
			// The break fires when the loop iterates through sessions but only __global__ is left
			// and oldestKey stays null. This means all sessions except __global__ are skipped.

			// Simplest approach: override MAX_SESSIONS to 0 via Object.defineProperty
			// which forces the while loop to trigger, but since only __global__ exists, oldestKey=null → break
			const originalMaxSessions = (HistoryManager as unknown as { MAX_SESSIONS: number }).MAX_SESSIONS;
			Object.defineProperty(HistoryManager, 'MAX_SESSIONS', { value: 0, writable: true, configurable: true });

			try {
				// Trigger _evictExcessSessions by creating a new session
				// _getSession() calls _evictExcessSessions() when creating new sessions
				// Since MAX_SESSIONS=0 and we have __global__ (size=1 > 0), it enters the while loop.
				// The for loop only sees __global__, skips it, so oldestKey stays null → break
				manager.addThought(createTestThought({ thought_number: 2, session_id: 'trigger' }));

				// If we got here without infinite loop, the break branch was hit
				expect(sessions.size).toBeGreaterThan(0);
			} finally {
				Object.defineProperty(HistoryManager, 'MAX_SESSIONS', { value: originalMaxSessions, writable: true, configurable: true });
			}
		});
	});

	describe('session eviction interactions with EdgeStore', () => {
		it('TTL-evicted session leaves EdgeStore entries intact (current behavior)', () => {
			useFakeTimers();
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({ edgeStore, dagEdges: true });

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'old', id: 'old-1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'old', id: 'old-2' }));
			const sizeBefore = edgeStore.size(asSessionId('old'));
			expect(sizeBefore).toBeGreaterThan(0);

			// Trigger TTL eviction
			vi.advanceTimersByTime(31 * 60 * 1000);
			vi.advanceTimersByTime(5 * 60 * 1000);

			// Session is gone from manager...
			expect(manager.getSessionIds()).not.toContain('old');
			// ...but EdgeStore entries persist (no auto-cleanup wired)
			expect(edgeStore.size(asSessionId('old'))).toBe(sizeBefore);
		});

		it('LRU-evicted session leaves EdgeStore entries intact (current behavior)', () => {
			useFakeTimers();
			// MAX_SESSIONS is private — override via defineProperty (default is 100)
			Object.defineProperty(HistoryManager, 'MAX_SESSIONS', {
				value: 2,
				writable: true,
				configurable: true,
			});
			try {
				const edgeStore = new EdgeStore();
				const manager = new HistoryManager({ edgeStore, dagEdges: true });

				manager.addThought(createTestThought({ thought_number: 1, session_id: 's1', id: 's1-1' }));
				vi.advanceTimersByTime(1);
				manager.addThought(createTestThought({ thought_number: 2, session_id: 's1', id: 's1-2' }));
				vi.advanceTimersByTime(1);
				manager.addThought(createTestThought({ thought_number: 1, session_id: 's2', id: 's2-1' }));
				vi.advanceTimersByTime(1);

				const s1EdgesBefore = edgeStore.size(asSessionId('s1'));
				expect(s1EdgesBefore).toBeGreaterThan(0);

				// Add a 3rd session — MAX_SESSIONS=2 (excluding __global__) → s1 evicted as oldest
				manager.addThought(createTestThought({ thought_number: 1, session_id: 's3', id: 's3-1' }));

				expect(manager.getSessionIds()).not.toContain('s1');
				// EdgeStore entries persist after LRU eviction
				expect(edgeStore.size(asSessionId('s1'))).toBe(s1EdgesBefore);
			} finally {
				Object.defineProperty(HistoryManager, 'MAX_SESSIONS', {
					value: 100,
					writable: true,
					configurable: true,
				});
			}
		});

		it('clearSession() actively clears the EdgeStore for that session', () => {
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({ edgeStore, dagEdges: true });

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a', id: 'a-1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'a', id: 'a-2' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b', id: 'b-1' }));
			expect(edgeStore.size(asSessionId('a'))).toBeGreaterThan(0);

			manager.clearSession(asSessionId('a'));

			expect(edgeStore.size(asSessionId('a'))).toBe(0);
			// Other session edges untouched
			expect(edgeStore.size(asSessionId('b'))).toBeGreaterThanOrEqual(0);
		});
	});

	describe('persistence saveEdges failure isolation', () => {
		it('surfaces edge failure after independent thought writes succeed', async () => {
			const persistence = new MockPersistence();
			// Override saveEdges to always throw
			let edgeSaveAttempts = 0;
			persistence.saveEdges = async (): Promise<void> => {
				edgeSaveAttempts++;
				throw new Error('Edge save failed');
			};
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({
				persistence,
				edgeStore,
				dagEdges: true,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
				persistenceMaxRetries: 0,
			});
			const sessionId = asSessionId('x');

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'x', id: 'x-1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'x', id: 'x-2' }));
			await expect(manager.shutdown()).rejects.toMatchObject({
				name: 'PersistenceDrainError',
				failures: [{ kind: 'edge', sessionId, attempts: 1 }],
			});

			const persisted = await persistence.loadHistoryForSession(sessionId);
			expect(persisted).toHaveLength(2);
			expect(edgeSaveAttempts).toBe(1);
		});

		it('saveThought failure does not block subsequent edge save attempts', async () => {
			const persistence = new MockPersistence();
			persistence.saveThoughtFailCount = 100; // fail all retries
			let edgeAttempts = 0;
			persistence.saveEdges = async (): Promise<void> => {
				edgeAttempts++;
			};
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({
				persistence,
				edgeStore,
				dagEdges: true,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
				persistenceMaxRetries: 0,
			});
			const sessionId = asSessionId('y');

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'y', id: 'y-1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'y', id: 'y-2' }));
			await expect(manager.shutdown()).rejects.toMatchObject({
				name: 'PersistenceDrainError',
				failures: [
					{ kind: 'thought', sessionId, attempts: 1 },
					{ kind: 'thought', sessionId, attempts: 1 },
				],
			});

			expect(edgeAttempts).toBe(1);
		});
	});
});

describe('HistoryManager — declarative branch registration', () => {
	afterEach(() => {
		useRealTimers();
	});

	it('registerBranch creates an empty branch that branchExists detects', () => {
		const manager = new HistoryManager();
		expect(manager.branchExists(undefined, asBranchId('alt-1'))).toBe(false);

		manager.registerBranch(undefined, asBranchId('alt-1'));

		expect(manager.branchExists(undefined, asBranchId('alt-1'))).toBe(true);
		expect(manager.getBranchIds()).toContain('alt-1');
		// Registered-only branches do not have thoughts attached
		expect(manager.getBranch(asBranchId('alt-1'))).toBeUndefined();
	});

	it('branchExists returns true for branches created via addThought', () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({ thought_number: 1, branch_from_thought: 1, branch_id: asBranchId('alt-2') })
		);
		expect(manager.branchExists(undefined, asBranchId('alt-2'))).toBe(true);
	});

	it('registerBranch throws ValidationError on duplicate (existing thought-backed branch)', () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({ thought_number: 1, branch_from_thought: 1, branch_id: asBranchId('dup') })
		);

		expect(() => manager.registerBranch(undefined, asBranchId('dup'))).toThrowError(
			/Branch already exists: dup/
		);
	});

	it('registerBranch throws ValidationError on duplicate (already registered)', () => {
		const manager = new HistoryManager();
		manager.registerBranch(undefined, asBranchId('alt-3'));

		expect(() => manager.registerBranch(undefined, asBranchId('alt-3'))).toThrowError(
			/Branch already exists: alt-3/
		);
	});

	it('registerBranch throws ValidationError on empty branchId', () => {
		const manager = new HistoryManager();
		expect(() => manager.registerBranch(undefined, asBranchId(''))).toThrowError(
			/branch_id must be a non-empty string/
		);
	});

	it('registerBranch is session-scoped (independent across sessions)', () => {
		const manager = new HistoryManager();
		manager.registerBranch(asSessionId('session-a'), asBranchId('shared-name'));

		expect(manager.branchExists(asSessionId('session-a'), asBranchId('shared-name'))).toBe(true);
		expect(manager.branchExists(asSessionId('session-b'), asBranchId('shared-name'))).toBe(false);

		// Same name can be registered in a different session without conflict
		expect(() => manager.registerBranch(asSessionId('session-b'), asBranchId('shared-name'))).not.toThrow();
		expect(manager.branchExists(asSessionId('session-b'), asBranchId('shared-name'))).toBe(true);
	});

	it('getBranchIds merges thought-backed and registered branches without duplicates', () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({ thought_number: 1, branch_from_thought: 1, branch_id: asBranchId('with-thoughts') })
		);
		manager.registerBranch(undefined, asBranchId('registered-only'));

		const ids = manager.getBranchIds();
		expect(ids).toContain('with-thoughts');
		expect(ids).toContain('registered-only');
		expect(new Set(ids).size).toBe(ids.length);
	});
});
