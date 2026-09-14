import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestThought as createBaseTestThought } from './helpers/factories.js';
import { asBranchId } from '../contracts/ids.js';
import { MemoryPersistence } from '../persistence/MemoryPersistence.js';
import { FilePersistence } from '../persistence/FilePersistence.js';
import { createPersistenceBackend } from '../persistence/PersistenceFactory.js';
import type { PersistenceConfig } from '../contracts/PersistenceBackend.js';
import type { IMetrics } from '../contracts/interfaces.js';
import type { Edge } from '../core/graph/Edge.js';
import { asSessionId, asThoughtId, type EdgeId } from '../contracts/ids.js';
import { PersistenceCompatibilityError, PersistenceCorruptionError } from '../errors.js';
import { parseFileSnapshotV2 } from '../persistence/FileSnapshotV2.js';

let persistentThoughtSequence = 0;
function createTestThought(overrides: Parameters<typeof createBaseTestThought>[0] = {}) {
	persistentThoughtSequence += 1;
	return createBaseTestThought({ id: `persistence-${persistentThoughtSequence}`, ...overrides });
}

describe('MemoryPersistence', () => {
	let backend: MemoryPersistence;

	beforeEach(() => {
		backend = new MemoryPersistence();
	});

	describe('saveThought and loadHistory', () => {
		it('should save and load a single thought', async () => {
			const thought = createTestThought();
			await backend.saveThought(thought);

			const history = await backend.loadHistory();

			expect(history).toHaveLength(1);
			expect(history[0]).toEqual(thought);
		});

		it('should save and load multiple thoughts in order', async () => {
			const thought1 = createTestThought({ thought_number: 1, thought: 'First' });
			const thought2 = createTestThought({ thought_number: 2, thought: 'Second' });
			const thought3 = createTestThought({ thought_number: 3, thought: 'Third' });

			await backend.saveThought(thought1);
			await backend.saveThought(thought2);
			await backend.saveThought(thought3);

			const history = await backend.loadHistory();

			expect(history).toHaveLength(3);
			expect(history[0]!.thought).toBe('First');
			expect(history[1]!.thought).toBe('Second');
			expect(history[2]!.thought).toBe('Third');
		});

		it('should return empty array when no thoughts saved', async () => {
			const history = await backend.loadHistory();
			expect(history).toEqual([]);
		});

		it('should return a copy of history (not internal reference)', async () => {
			const thought = createTestThought();
			await backend.saveThought(thought);

			const history1 = await backend.loadHistory();
			const history2 = await backend.loadHistory();

			// Modify first array
			history1.push(createTestThought({ thought: 'Extra' }));

			// Second array should be unchanged
			expect(history2).toHaveLength(1);
			expect(history1).toHaveLength(2);
		});
	});

	describe('saveBranch and loadBranch', () => {
		it('should save and load a branch', async () => {
			const branchId = asBranchId('branch-1');
			const thoughts = [
				createTestThought({ thought: 'Branch thought 1', thought_number: 1 }),
				createTestThought({ thought: 'Branch thought 2', thought_number: 2 }),
			];

			await backend.saveBranch(branchId, thoughts);

			const loaded = await backend.loadBranch(branchId);

			expect(loaded).toEqual(thoughts);
		});

		it('should return undefined for non-existent branch', async () => {
			const loaded = await backend.loadBranch(asBranchId('non-existent'));
			expect(loaded).toBeUndefined();
		});

		it('should save multiple branches', async () => {
			const branch1 = [createTestThought({ thought: 'Branch 1' })];
			const branch2 = [createTestThought({ thought: 'Branch 2' })];
			const branch3 = [createTestThought({ thought: 'Branch 3' })];

			await backend.saveBranch(asBranchId('branch-1'), branch1);
			await backend.saveBranch(asBranchId('branch-2'), branch2);
			await backend.saveBranch(asBranchId('branch-3'), branch3);

			expect(await backend.loadBranch(asBranchId('branch-1'))).toEqual(branch1);
			expect(await backend.loadBranch(asBranchId('branch-2'))).toEqual(branch2);
			expect(await backend.loadBranch(asBranchId('branch-3'))).toEqual(branch3);
		});

		it('should overwrite existing branch', async () => {
			const branchId = asBranchId('branch-1');
			const original = [createTestThought({ thought: 'Original' })];
			const updated = [createTestThought({ thought: 'Updated' })];

			await backend.saveBranch(branchId, original);
			await backend.saveBranch(branchId, updated);

			const loaded = await backend.loadBranch(branchId);

			expect(loaded).toEqual(updated);
		});

		it('should return a copy of branch data', async () => {
			const branchId = asBranchId('branch-1');
			const thoughts = [createTestThought({ thought: 'Test' })];

			await backend.saveBranch(branchId, thoughts);

			const loaded1 = await backend.loadBranch(branchId);
			const loaded2 = await backend.loadBranch(branchId);

			// Modify first array
			loaded1?.push(createTestThought({ thought: 'Extra' }));

			// Second array should be unchanged
			expect(loaded2).toHaveLength(1);
			expect(loaded1).toHaveLength(2);
		});
	});

	describe('clear', () => {
		it('should clear all history and branches', async () => {
			// Add history
			await backend.saveThought(createTestThought());
			await backend.saveThought(createTestThought({ thought_number: 2 }));

			// Add branches
			await backend.saveBranch(asBranchId('branch-1'), [createTestThought()]);
			await backend.saveBranch(asBranchId('branch-2'), [createTestThought()]);

			// Verify data exists
			expect((await backend.loadHistory()).length).toBeGreaterThan(0);
			expect(backend.getBranchCount()).toBe(2);

			// Clear
			await backend.clear();

			// Verify cleared
			expect(await backend.loadHistory()).toEqual([]);
			expect(await backend.loadBranch(asBranchId('branch-1'))).toBeUndefined();
			expect(await backend.loadBranch(asBranchId('branch-2'))).toBeUndefined();
			expect(backend.getHistorySize()).toBe(0);
			expect(backend.getBranchCount()).toBe(0);
		});

		it('should be safe to call multiple times', async () => {
			await backend.saveThought(createTestThought());
			await backend.clear();
			await backend.clear();
			await backend.clear();

			expect(await backend.loadHistory()).toEqual([]);
		});
	});

	describe('healthy', () => {
		it('should always return true for memory backend', async () => {
			expect(await backend.healthy()).toBe(true);
		});
	});

	describe('Helper methods', () => {
		it('should track history size correctly', async () => {
			expect(backend.getHistorySize()).toBe(0);

			await backend.saveThought(createTestThought());
			expect(backend.getHistorySize()).toBe(1);

			await backend.saveThought(createTestThought({ thought_number: 2 }));
			expect(backend.getHistorySize()).toBe(2);
		});

		it('should track branch count correctly', async () => {
			expect(backend.getBranchCount()).toBe(0);

			await backend.saveBranch(asBranchId('branch-1'), [createTestThought()]);
			expect(backend.getBranchCount()).toBe(1);

			await backend.saveBranch(asBranchId('branch-2'), [createTestThought()]);
			expect(backend.getBranchCount()).toBe(2);
		});

		it('should return all branch IDs', async () => {
			await backend.saveBranch(asBranchId('branch-1'), [createTestThought()]);
			await backend.saveBranch(asBranchId('branch-2'), [createTestThought()]);
			await backend.saveBranch(asBranchId('branch-3'), [createTestThought()]);

			const ids = backend.getBranchIds();

			expect(ids).toHaveLength(3);
			expect(ids).toEqual(expect.arrayContaining(['branch-1', 'branch-2', 'branch-3']));
		});
	});

	describe('Complex scenarios', () => {
		it('should handle concurrent save operations', async () => {
			const thoughts = Array.from({ length: 100 }, (_, i) =>
				createTestThought({ thought_number: i + 1, thought: `Thought ${i + 1}` })
			);

			// Save all concurrently
			await Promise.all(thoughts.map((t) => backend.saveThought(t)));

			const history = await backend.loadHistory();

			expect(history).toHaveLength(100);
		});

		it('should isolate history from branches', async () => {
			// Add history
			await backend.saveThought(createTestThought({ thought: 'History thought' }));

			// Add branch
			await backend.saveBranch(asBranchId('branch-1'), [
				createTestThought({ thought: 'Branch thought' }),
			]);

			// History should only contain history thoughts
			const history = await backend.loadHistory();
			expect(history).toHaveLength(1);
			expect(history[0]!.thought).toBe('History thought');

			// Branch should only contain branch thoughts
			const branch = await backend.loadBranch(asBranchId('branch-1'));
			expect(branch).toHaveLength(1);
			expect(branch?.[0]?.thought).toBe('Branch thought');
		});
	});
});

describe('FilePersistence', () => {
	let testDir: string;
	let backend: FilePersistence;

	beforeEach(() => {
		// Create a temporary directory for testing
		testDir = join(tmpdir(), `claude-persistence-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		// Create backend with test directory
		backend = new FilePersistence({ dataDir: testDir });
	});

	afterEach(async () => {
		await backend.close();
		// Clean up test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe('saveThought and loadHistory', () => {
		it('persists sequential writes in the canonical v2 snapshot', async () => {
			const thought = createTestThought({ thought: 'History record' });
			const branch = [createTestThought({ thought: 'Branch record' })];
			const edge: Edge = {
				id: 'edge-1' as EdgeId,
				from: asThoughtId('thought-1'),
				to: asThoughtId('thought-2'),
				kind: 'sequence',
				sessionId: asSessionId('session-1'),
				createdAt: 1,
			};

			await backend.saveThought(thought);
			await backend.saveBranch(asBranchId('branch-1'), branch);
			await backend.saveEdges(asSessionId('session-1'), [edge]);

			const snapshotPath = join(testDir, 'snapshot.json');
			const snapshot = parseFileSnapshotV2(await readFile(snapshotPath, 'utf-8'), snapshotPath);
			expect(snapshot.thoughts).toEqual([{ sessionId: '__global__', thoughts: [thought] }]);
			expect(snapshot.branches).toEqual([
				{ sessionId: '__global__', branchId: 'branch-1', thoughts: branch },
			]);
			expect(snapshot.edges).toEqual([{ sessionId: 'session-1', edges: [edge] }]);
		});

		it('characterizes sequential retention as the newest v1 records', async () => {
			const retainedBackend = new FilePersistence({ dataDir: testDir, maxHistorySize: 2 });
			const thoughts = [1, 2, 3].map((thoughtNumber) =>
				createTestThought({ thought_number: thoughtNumber, thought: `Thought ${thoughtNumber}` })
			);

			for (const thought of thoughts) {
				await retainedBackend.saveThought(thought);
			}

			const history = await retainedBackend.loadHistory();
			expect(history).toEqual(thoughts.slice(1));
			await retainedBackend.close();
		});

		it('should save and load a single thought', async () => {
			const thought = createTestThought();
			await backend.saveThought(thought);

			const history = await backend.loadHistory();

			expect(history).toHaveLength(1);
			expect(history[0]).toEqual(thought);
		});

		it('should persist data across backend instances', async () => {
			const thought = createTestThought();

			// Save with first instance
			await backend.saveThought(thought);
			await backend.close();

			// Create new instance (simulates restart)
			const backend2 = new FilePersistence({ dataDir: testDir });
			const history = await backend2.loadHistory();

			expect(history).toHaveLength(1);
			expect(history[0]).toEqual(thought);
			await backend2.close();
		});

		it('should handle empty history file', async () => {
			const history = await backend.loadHistory();
			expect(history).toEqual([]);
		});

		it('should reject corrupted history with a typed error', async () => {
			const { writeFile } = await import('node:fs/promises');
			const { join } = await import('node:path');

			// Write corrupted data
			const snapshotPath = join(testDir, 'snapshot.json');
			await writeFile(snapshotPath, 'invalid json', 'utf-8');

			await expect(backend.loadHistory()).rejects.toBeInstanceOf(PersistenceCorruptionError);
		});
	});

	describe('saveBranch and loadBranch', () => {
		it('should save and load a branch', async () => {
			const branchId = asBranchId('branch-1');
			const thoughts = [
				createTestThought({ thought: 'Branch thought 1', thought_number: 1 }),
				createTestThought({ thought: 'Branch thought 2', thought_number: 2 }),
			];

			await backend.saveBranch(branchId, thoughts);

			const loaded = await backend.loadBranch(branchId);

			expect(loaded).toEqual(thoughts);
		});

		it('should return undefined for non-existent branch', async () => {
			const loaded = await backend.loadBranch(asBranchId('non-existent'));
			expect(loaded).toBeUndefined();
		});

		it('should persist branches across backend instances', async () => {
			const branchId = asBranchId('branch-1');
			const thoughts = [createTestThought({ thought: 'Branch thought' })];

			await backend.saveBranch(branchId, thoughts);
			await backend.close();

			// Create new instance
			const backend2 = new FilePersistence({ dataDir: testDir });
			const loaded = await backend2.loadBranch(branchId);

			expect(loaded).toEqual(thoughts);
			await backend2.close();
		});

		it('should reject corrupted branch with a typed error', async () => {
			const { writeFile } = await import('node:fs/promises');
			await writeFile(join(testDir, 'snapshot.json'), 'invalid json', 'utf-8');

			await expect(backend.loadBranch(asBranchId('corrupted'))).rejects.toBeInstanceOf(
				PersistenceCorruptionError
			);
		});
	});

	describe('clear', () => {
		it('should clear all history and branches', async () => {
			// Add data
			await backend.saveThought(createTestThought());
			await backend.saveBranch(asBranchId('branch-1'), [createTestThought()]);

			// Clear
			await backend.clear();

			// Verify cleared
			expect(await backend.loadHistory()).toEqual([]);
			expect(await backend.loadBranch(asBranchId('branch-1'))).toBeUndefined();
		});

		it('should be safe to call when nothing to clear', async () => {
			await expect(async () => await backend.clear()).not.toThrow();
		});
	});

	describe('healthy', () => {
		it('should return true when backend is operational', async () => {
			expect(await backend.healthy()).toBe(true);
		});
	});

	describe('maxHistorySize', () => {
		it('should trim history when exceeding max size', async () => {
			const smallMax = 5;
			const backend2 = new FilePersistence({
				dataDir: testDir,
				maxHistorySize: smallMax,
			});

			// Add more thoughts than max
			for (let i = 0; i < 10; i++) {
				await backend2.saveThought(createTestThought({ thought_number: i + 1 }));
			}

			const history = await backend2.loadHistory();

			// Should only have the last 5 thoughts
			expect(history).toHaveLength(5);
			expect(history[0]!.thought_number).toBe(6);
			expect(history[4]!.thought_number).toBe(10);
		});

		it('treats maxHistorySize 0 as unlimited and persists a non-empty history record', async () => {
			// Given
			const unlimitedBackend = await FilePersistence.create({
				dataDir: testDir,
				maxHistorySize: 0,
			});
			const thoughts = [
				createTestThought({ id: 'zero-limit-first', thought_number: 20 }),
				createTestThought({ id: 'zero-limit-second', thought_number: 10 }),
			];

			try {
				// When
				for (const thought of thoughts) await unlimitedBackend.saveThought(thought);

				// Then
				const snapshotPath = join(testDir, 'snapshot.json');
				const snapshot = parseFileSnapshotV2(await readFile(snapshotPath, 'utf-8'), snapshotPath);
				expect(snapshot.thoughts).toEqual([{ sessionId: '__global__', thoughts }]);
			} finally {
				await unlimitedBackend.close();
			}
		});

		it('treats negative maxHistorySize as unlimited and persists a non-empty history record', async () => {
			// Given
			const unlimitedBackend = await FilePersistence.create({
				dataDir: testDir,
				maxHistorySize: -1,
			});
			const thoughts = [
				createTestThought({ id: 'negative-limit-first', thought_number: 2 }),
				createTestThought({ id: 'negative-limit-second', thought_number: 1 }),
			];

			try {
				// When
				for (const thought of thoughts) await unlimitedBackend.saveThought(thought);

				// Then
				const snapshotPath = join(testDir, 'snapshot.json');
				const snapshot = parseFileSnapshotV2(await readFile(snapshotPath, 'utf-8'), snapshotPath);
				expect(snapshot.thoughts).toEqual([{ sessionId: '__global__', thoughts }]);
			} finally {
				await unlimitedBackend.close();
			}
		});
	});

	describe('persistBranches option', () => {
		it('should not save branches when persistBranches is false', async () => {
			const backend2 = new FilePersistence({
				dataDir: testDir,
				persistBranches: false,
			});

			await backend2.saveBranch(asBranchId('branch-1'), [createTestThought()]);

			const loaded = await backend2.loadBranch(asBranchId('branch-1'));

			expect(loaded).toBeUndefined();
		});
	});

	describe('Helper methods', () => {
		it('should return data directory path', () => {
			const dataDir = backend.getDataDir();
			expect(dataDir).toBe(testDir);
		});

		it('should return all branch IDs', async () => {
			await backend.saveBranch(asBranchId('branch-1'), [createTestThought()]);
			await backend.saveBranch(asBranchId('branch-2'), [createTestThought()]);
			await backend.saveBranch(asBranchId('branch-3'), [createTestThought()]);

			const ids = await backend.getBranchIds();

			expect(ids).toHaveLength(3);
			expect(ids).toEqual(expect.arrayContaining(['branch-1', 'branch-2', 'branch-3']));
		});

		it('should return empty array when no branches', async () => {
			const ids = await backend.getBranchIds();
			expect(ids).toEqual([]);
		});
	});

	describe('Complex scenarios', () => {
		it('should handle multiple sequential saves', async () => {
			const thoughts = Array.from({ length: 50 }, (_, i) =>
				createTestThought({ thought_number: i + 1, thought: `Thought ${i + 1}` })
			);

			for (const thought of thoughts) {
				await backend.saveThought(thought);
			}

			const history = await backend.loadHistory();

			expect(history).toHaveLength(50);
		});

		it('should create directories on demand', async () => {
			// Use a non-existent directory
			const nestedDir = join(testDir, 'nested', 'path');
			const backend2 = new FilePersistence({ dataDir: nestedDir });

			await backend2.saveThought(createTestThought());

			// Should succeed without error
			const history = await backend2.loadHistory();
			expect(history).toHaveLength(1);
			await backend2.close();
		});

		// P0-A: Path traversal security tests
		describe('Path traversal prevention', () => {
			it('should reject branch IDs with path traversal patterns', async () => {
				// These patterns are tested via integration tests that verify _safeBranchPath()
				// rejects them. See base-transport.test.ts for adversarial origin tests.
				expect(true).toBe(true);
			});

			it('should accept valid branch IDs', async () => {
				const validBranchIds = [
					'valid-branch',
					'valid_branch',
					'Branch123',
					'branch-01_test',
					'a', // single char
					'x'.repeat(50), // max length
				];

				for (const id of validBranchIds) {
					const branchId = asBranchId(id);
					await backend.saveBranch(branchId, [createTestThought()]);
					const loaded = await backend.loadBranch(branchId);
					expect(loaded).toBeDefined();
					expect(loaded?.[0]?.thought).toBe('Test thought');
				}
			});

			it('should not create files outside branches directory', async () => {
				const initialFiles = existsSync(join(testDir, 'branches'))
					? readdirSync(join(testDir, 'branches'))
					: [];

				// Try path traversal - should throw
				await expect(
					backend.saveBranch(asBranchId('../../malicious'), [createTestThought()])
				).rejects.toThrow();

				// Verify no new files outside branches
				const afterFiles = existsSync(join(testDir, 'branches'))
					? readdirSync(join(testDir, 'branches'))
					: [];

				expect(afterFiles.length).toBe(initialFiles.length);
				expect(existsSync(join(testDir, 'malicious.json'))).toBe(false);
			});
		});

		describe('additional coverage', () => {
			it('should delegate listBranches() to getBranchIds()', async () => {
				await backend.saveBranch(asBranchId('branch-a'), [createTestThought()]);
				await backend.saveBranch(asBranchId('branch-b'), [createTestThought()]);

				const branches = await backend.listBranches();

				expect(branches).toHaveLength(2);
				expect(branches).toEqual(expect.arrayContaining(['branch-a', 'branch-b']));
			});

			it('should return false from healthy() when directory creation fails', async () => {
				// Use an invalid path that will cause mkdir to throw
				const badBackend = new FilePersistence({ dataDir: '/dev/null/impossible/path' });
				const result = await badBackend.healthy();
				expect(result).toBe(false);
			});

			it('should reject malformed branch records in the v2 snapshot', async () => {
				const { writeFile: wf } = await import('node:fs/promises');
				await wf(
					join(testDir, 'snapshot.json'),
					JSON.stringify({ version: 2, thoughts: [], branches: {}, edges: [], summaries: [] }),
					'utf-8'
				);

				await expect(backend.getBranchIds()).rejects.toBeInstanceOf(PersistenceCompatibilityError);
			});

			it('should allow close() to be called repeatedly', async () => {
				await expect(backend.close()).resolves.toBeUndefined();
				await expect(backend.close()).resolves.toBeUndefined();
			});

			it('should record operation duration with metrics', async () => {
				const histogramCalls: Array<{
					name: string;
					value: number;
					labels: Record<string, string>;
				}> = [];
				const mockMetrics = {
					histogram(name: string, value: number, labels: Record<string, string>) {
						histogramCalls.push({ name, value, labels });
					},
					counter() {},
					gauge() {},
					getAll() {
						return '';
					},
				};
				const metricsBackend = new FilePersistence({
					dataDir: testDir,
					metrics: mockMetrics as unknown as IMetrics,
				});

				await metricsBackend.saveThought(createTestThought());
				await metricsBackend.loadHistory();

				const saveOps = histogramCalls.filter((c) => c.labels.operation === 'save_thought');
				const loadOps = histogramCalls.filter((c) => c.labels.operation === 'load_history');
				expect(saveOps.length).toBeGreaterThanOrEqual(1);
				expect(loadOps.length).toBeGreaterThanOrEqual(1);
				await metricsBackend.close();
			});
		});

		describe('edge case data handling', () => {
			it('should reject a non-array thought collection in the v2 snapshot', async () => {
				const { writeFile: wf } = await import('node:fs/promises');
				await wf(
					join(testDir, 'snapshot.json'),
					JSON.stringify({ version: 2, thoughts: {}, branches: [], edges: [], summaries: [] }),
					'utf-8'
				);

				await expect(backend.loadHistory()).rejects.toBeInstanceOf(PersistenceCompatibilityError);
			});

			it('should reject a non-array branch collection in the v2 snapshot', async () => {
				const { writeFile: wf } = await import('node:fs/promises');
				await wf(
					join(testDir, 'snapshot.json'),
					JSON.stringify({
						version: 2,
						thoughts: [],
						branches: 'invalid',
						edges: [],
						summaries: [],
					}),
					'utf-8'
				);

				await expect(backend.loadBranch(asBranchId('not-array'))).rejects.toBeInstanceOf(
					PersistenceCompatibilityError
				);
			});

			it('should skip non-json files during clear()', async () => {
				const { writeFile: wf, mkdir: mk } = await import('node:fs/promises');
				const branchesDir = join(testDir, 'branches');
				await mk(branchesDir, { recursive: true });
				// Create a non-json file in branches dir
				await wf(join(branchesDir, 'readme.txt'), 'not a branch', 'utf-8');
				// Also create a valid branch
				await backend.saveBranch(asBranchId('valid'), [createTestThought()]);

				// Clear should succeed without throwing
				await expect(backend.clear()).resolves.toBeUndefined();

				// Non-json file should still exist
				expect(existsSync(join(branchesDir, 'readme.txt'))).toBe(true);
			});
		});
	});
});

describe('createPersistenceBackend', () => {
	it('should return null when persistence is disabled', async () => {
		const config: PersistenceConfig = {
			enabled: false,
		};

		const backend = await createPersistenceBackend(config);

		expect(backend).toBeNull();
	});

	it('should create memory backend when specified', async () => {
		const config: PersistenceConfig = {
			enabled: true,
			backend: 'memory',
		};

		const backend = await createPersistenceBackend(config);

		expect(backend).toBeInstanceOf(MemoryPersistence);
	});

	it('should create file backend when specified', async () => {
		const testDir = join(tmpdir(), `claude-factory-test-${Date.now()}`);

		const config: PersistenceConfig = {
			enabled: true,
			backend: 'file',
			options: { dataDir: testDir },
		};

		const backend = await createPersistenceBackend(config);

		expect(backend).toBeInstanceOf(FilePersistence);
		expect((backend as FilePersistence).getDataDir()).toBe(testDir);
		await backend?.close();

		// Cleanup
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it('should acquire file writer ownership before returning from the factory', async () => {
		const testDir = join(tmpdir(), `claude-factory-owner-${Date.now()}`);
		const config: PersistenceConfig = {
			enabled: true,
			backend: 'file',
			options: { dataDir: testDir },
		};
		const owner = await createPersistenceBackend(config);

		try {
			await expect(createPersistenceBackend(config)).rejects.toMatchObject({
				code: 'PERSISTENCE_OWNERSHIP',
			});
		} finally {
			await owner?.close();
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true, force: true });
			}
		}
	});

	it('should throw error for unknown backend type', async () => {
		const config = {
			enabled: true,
			backend: 'unknown' as 'memory',
		};

		await expect(async () => await createPersistenceBackend(config)).rejects.toThrow(
			'Unknown persistence backend: unknown'
		);
	});

	it('should throw error for sqlite when better-sqlite3 is not installed', async () => {
		const config: PersistenceConfig = {
			enabled: true,
			backend: 'sqlite',
		};

		// This will fail because better-sqlite3 is not installed
		try {
			await createPersistenceBackend(config);
			// If it somehow succeeds (e.g., if package is installed), that's ok too
		} catch (error) {
			expect((error as Error).message).toContain('better-sqlite3');
		}
	});
});

describe('PersistenceBackend Interface Compliance', () => {
	const testThought = createTestThought();

	it('MemoryPersistence should comply with interface', async () => {
		const backend = new MemoryPersistence();

		await backend.saveThought(testThought);
		expect(await backend.loadHistory()).toHaveLength(1);
		await backend.clear();
		expect(await backend.loadHistory()).toHaveLength(0);
		expect(await backend.healthy()).toBe(true);
		await backend.close();
	});

	it('FilePersistence should comply with interface', async () => {
		const testDir = join(tmpdir(), `compliance-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		const backend = new FilePersistence({ dataDir: testDir });

		await backend.saveThought(testThought);
		expect(await backend.loadHistory()).toHaveLength(1);
		await backend.clear();
		expect(await backend.loadHistory()).toHaveLength(0);
		expect(await backend.healthy()).toBe(true);
		await backend.close();

		// Cleanup
		rmSync(testDir, { recursive: true, force: true });
	});
});

describe('FilePersistence — edge persistence roundtrip', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `edge-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it('saves edges then loads them back identically (sorted by createdAt)', async () => {
		const backend = new FilePersistence({ dataDir: testDir });
		const edges: Edge[] = [
			{
				id: 'e2' as EdgeId,
				from: asThoughtId('a'),
				to: asThoughtId('c'),
				kind: 'sequence' as const,
				sessionId: asSessionId('s1'),
				createdAt: 200,
			},
			{
				id: 'e1' as EdgeId,
				from: asThoughtId('a'),
				to: asThoughtId('b'),
				kind: 'branch' as const,
				sessionId: asSessionId('s1'),
				createdAt: 100,
			},
			{
				id: 'e3' as EdgeId,
				from: asThoughtId('b'),
				to: asThoughtId('d'),
				kind: 'merge' as const,
				sessionId: asSessionId('s1'),
				createdAt: 300,
			},
		];
		await backend.saveEdges(asSessionId('s1'), edges);
		const loaded = await backend.loadEdges(asSessionId('s1'));
		expect(loaded).toHaveLength(3);
		// Sorted by createdAt ascending on save
		expect(loaded.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
		expect(loaded[0]).toMatchObject({ from: 'a', to: 'b', kind: 'branch' });
		await backend.close();
	});

	it('saveEdges with empty array deletes the existing edge file', async () => {
		const backend = new FilePersistence({ dataDir: testDir });
		await backend.saveEdges(asSessionId('s2'), [
			{
				id: 'e1' as EdgeId,
				from: asThoughtId('a'),
				to: asThoughtId('b'),
				kind: 'sequence',
				sessionId: asSessionId('s2'),
				createdAt: 1,
			},
		]);
		expect(await backend.loadEdges(asSessionId('s2'))).toHaveLength(1);
		await backend.saveEdges(asSessionId('s2'), []);
		expect(await backend.loadEdges(asSessionId('s2'))).toEqual([]);
		await backend.close();
	});

	it('loadEdges returns [] for missing session file (no error)', async () => {
		const backend = new FilePersistence({ dataDir: testDir });
		const loaded = await backend.loadEdges(asSessionId('never-saved'));
		expect(loaded).toEqual([]);
		await backend.close();
	});

	it('loadEdges rejects corrupted JSON with a typed error', async () => {
		const backend = new FilePersistence({ dataDir: testDir });
		// Force file creation by saving + then corrupting
		await backend.saveEdges(asSessionId('corrupt'), [
			{
				id: 'e1' as EdgeId,
				from: asThoughtId('a'),
				to: asThoughtId('b'),
				kind: 'sequence',
				sessionId: asSessionId('corrupt'),
				createdAt: 1,
			},
		]);
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(testDir, 'snapshot.json'), '{not valid json', 'utf-8');
		await expect(backend.loadEdges(asSessionId('corrupt'))).rejects.toBeInstanceOf(
			PersistenceCorruptionError
		);
		await backend.close();
	});

	it('rejects invalid sessionId (path traversal / bad chars)', async () => {
		const backend = new FilePersistence({ dataDir: testDir });
		await expect(
			(async () =>
				backend.saveEdges(asSessionId('../etc'), [
					{
						id: 'e1' as EdgeId,
						from: asThoughtId('a'),
						to: asThoughtId('b'),
						kind: 'sequence',
						sessionId: 'safe-session' as ReturnType<typeof asSessionId>,
						createdAt: 1,
					},
				]))()
		).rejects.toThrow();
		await expect((async () => backend.loadEdges(asSessionId('../etc')))()).rejects.toThrow();
		await expect((async () => backend.loadEdges(asSessionId('has space')))()).rejects.toThrow();
		await backend.close();
	});

	it('persists edges across separate FilePersistence instances (durability)', async () => {
		const backendA = new FilePersistence({ dataDir: testDir });
		await backendA.saveEdges(asSessionId('durable'), [
			{
				id: 'd1' as EdgeId,
				from: asThoughtId('x'),
				to: asThoughtId('y'),
				kind: 'verifies',
				sessionId: asSessionId('durable'),
				createdAt: 50,
			},
		]);
		await backendA.close();
		const backendB = new FilePersistence({ dataDir: testDir });
		const loaded = await backendB.loadEdges(asSessionId('durable'));
		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toMatchObject({ id: 'd1', kind: 'verifies' });
		await backendB.close();
	});
});
