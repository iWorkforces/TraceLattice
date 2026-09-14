import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import { supportsSessionScopedPersistence } from '../contracts/PersistenceBackend.js';
import { GLOBAL_SESSION_ID, asBranchId, asSessionId } from '../contracts/ids.js';
import { FilePersistence } from '../persistence/FilePersistence.js';
import { nodeFileWriterOperations } from '../persistence/FileWriter.js';
import { MemoryPersistence } from '../persistence/MemoryPersistence.js';
import { importLegacyFileV1 } from '../persistence/FileLegacyImport.js';
import { parseFileSnapshotV2 } from '../persistence/FileSnapshotV2.js';
import { parseThoughtData } from '../persistence/PersistenceCodec.js';
import { requireSessionScopedPersistence } from '../persistence/SessionScopedPersistence.js';
import { createTestThought } from './helpers/factories.js';

const SNAPSHOT_SOURCE_PATH = '/data/snapshot.json';
const EMPTY_FILE_V2_SNAPSHOT = {
	version: 2,
	thoughts: [],
	branches: [],
	edges: [],
	summaries: [],
} as const;
const MINIMAL_PERSISTED_THOUGHT = {
	thought: 'Persisted minimal thought',
	thought_number: 1,
	total_thoughts: 1,
} as const;

function persistedThought(id: string, sessionId: string) {
	return {
		...MINIMAL_PERSISTED_THOUGHT,
		id,
		session_id: sessionId,
	};
}

const legacyBackend: PersistenceBackend = {
	saveThought: async () => {},
	loadHistory: async () => [],
	saveBranch: async () => {},
	loadBranch: async () => undefined,
	listBranches: async () => [],
	healthy: async () => true,
	clear: async () => {},
	close: async () => {},
	saveEdges: async () => {},
	loadEdges: async () => [],
	listEdgeSessions: async () => [],
	saveSummaries: async () => {},
	loadSummaries: async () => [],
};

describe('session-scoped persistence capability', () => {
	it('keeps the legacy 13-method structural backend source-compatible and rejects named fallback', () => {
		expect(Object.keys(legacyBackend)).toHaveLength(13);
		expect(supportsSessionScopedPersistence(legacyBackend)).toBe(false);
		expect(() => requireSessionScopedPersistence(legacyBackend, 'clearSession')).toThrowError(
			expect.objectContaining({
				code: 'PERSISTENCE_CAPABILITY_UNSUPPORTED',
				operation: 'clearSession',
			})
		);
	});

	it('recognizes each built-in only when all seven scoped methods are present', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-guard-'));
		const file = await FilePersistence.create({ dataDir });
		try {
			expect(supportsSessionScopedPersistence(new MemoryPersistence())).toBe(true);
			expect(supportsSessionScopedPersistence(file)).toBe(true);
		} finally {
			await file.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});

describe('File v2 compatibility boundary', () => {
	it('preserves every supplied field in a fully populated persisted thought', () => {
		// Given
		const fullyPopulatedThought = {
			available_mcp_tools: ['Read'],
			available_skills: ['programming'],
			thought: 'Persisted full thought',
			id: 'thought-full',
			next_thought_needed: false,
			thought_number: 7,
			total_thoughts: 9,
			is_revision: true,
			revises_thought: 3,
			branch_from_thought: 2,
			branch_id: 'branch-current',
			needs_more_thoughts: true,
			current_step: {
				step_description: 'Inspect persisted state',
				recommended_tools: [
					{
						tool_name: 'Read',
						confidence: 0.91,
						rationale: 'Reads the persisted snapshot',
						priority: 4,
						suggested_inputs: {
							path: '/data/snapshot.json',
							limit: 25,
							strict: true,
							offset: null,
						},
						alternatives: ['Bash'],
					},
				],
				recommended_skills: [
					{
						skill_name: 'programming',
						confidence: 0.82,
						rationale: 'Applies TypeScript contracts',
						priority: 6,
						alternatives: ['debugging'],
						allowed_tools: ['Read', 'Bash'],
						user_invocable: true,
					},
				],
				expected_outcome: 'The snapshot contract is understood',
				next_step_conditions: ['Continue when fields are accounted for'],
			},
			previous_steps: [
				{
					step_description: 'Locate persisted state',
					recommended_tools: [
						{
							tool_name: 'Glob',
							confidence: 0.73,
							rationale: 'Locates snapshot files',
							priority: 8,
							suggested_inputs: { pattern: '**/snapshot.json' },
							alternatives: ['Read'],
						},
					],
					recommended_skills: [
						{
							skill_name: 'debugging',
							confidence: 0.64,
							rationale: 'Checks runtime evidence',
							priority: 10,
							alternatives: ['programming'],
							allowed_tools: ['Bash'],
							user_invocable: false,
						},
					],
					expected_outcome: 'The snapshot file is located',
					next_step_conditions: ['Inspect the located file'],
				},
			],
			remaining_steps: ['Validate compatibility'],
			thought_type: 'synthesis',
			quality_score: 0.88,
			confidence: 0.86,
			hypothesis_id: 'compatibility-hypothesis',
			verification_target: 5,
			synthesis_sources: [3, 5],
			merge_from_thoughts: [2, 4],
			merge_branch_ids: ['branch-alpha', 'branch-beta'],
			meta_observation: 'Compatibility fields remain stable',
			reasoning_depth: 'deep',
			session_id: 'session-full',
			reset_state: false,
			tool_name: 'Read',
			tool_arguments: { path: '/data/snapshot.json' },
			tool_result: { loaded: true },
			continuation_token: 'continuation-full',
			decomposition_children: ['child-a', 'child-b'],
			backtrack_target: 2,
			register_branch_id: 'branch-future',
		} as const;

		// When
		const parsed = parseThoughtData(fullyPopulatedThought, SNAPSHOT_SOURCE_PATH);

		// Then
		expect(parsed).toEqual(fullyPopulatedThought);
	});

	it('accepts a minimal persisted thought without synthesizing optional identity or step fields', () => {
		// Given
		const persistedThoughtPayload = MINIMAL_PERSISTED_THOUGHT;

		// When
		const parsed = parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH);

		// Then
		expect(parsed).toEqual({
			thought: 'Persisted minimal thought',
			thought_number: 1,
			total_thoughts: 1,
		});
	});

	it.each([
		['confidence', { tool_name: 'Read', rationale: 'Reads persisted data', priority: 3 }],
		['rationale', { tool_name: 'Read', confidence: 0.8, priority: 3 }],
		['priority', { tool_name: 'Read', confidence: 0.8, rationale: 'Reads persisted data' }],
	] as const)(
		'rejects a persisted tool recommendation missing its %s default',
		(_, recommendation) => {
			// Given
			const persistedThoughtPayload = {
				...MINIMAL_PERSISTED_THOUGHT,
				previous_steps: [
					{
						step_description: 'Inspect persisted data',
						recommended_tools: [recommendation],
						expected_outcome: 'Persisted data is inspected',
					},
				],
			};

			// When / Then
			expect(() => parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH)).toThrowError(
				expect.objectContaining({
					name: 'PersistenceCompatibilityError',
					code: 'PERSISTENCE_COMPATIBILITY',
					sourcePath: SNAPSHOT_SOURCE_PATH,
					detail: 'tool recommendation defaults are absent',
				})
			);
		}
	);

	it.each([
		[
			'confidence',
			{
				skill_name: 'programming',
				rationale: 'Applies TypeScript contracts',
				priority: 2,
			},
		],
		['rationale', { skill_name: 'programming', confidence: 0.7, priority: 2 }],
		[
			'priority',
			{
				skill_name: 'programming',
				confidence: 0.7,
				rationale: 'Applies TypeScript contracts',
			},
		],
	] as const)(
		'rejects a persisted skill recommendation missing its %s default',
		(_, recommendation) => {
			// Given
			const persistedThoughtPayload = {
				...MINIMAL_PERSISTED_THOUGHT,
				current_step: {
					step_description: 'Apply compatibility guidance',
					recommended_tools: [],
					recommended_skills: [recommendation],
					expected_outcome: 'Compatibility guidance is applied',
				},
			};

			// When / Then
			expect(() => parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH)).toThrowError(
				expect.objectContaining({
					name: 'PersistenceCompatibilityError',
					code: 'PERSISTENCE_COMPATIBILITY',
					sourcePath: SNAPSHOT_SOURCE_PATH,
					detail: 'skill recommendation defaults are absent',
				})
			);
		}
	);

	it.each([
		[
			'current',
			'step_description',
			{
				current_step: {
					recommended_tools: [],
					expected_outcome: 'Current step completes',
				},
			},
			'document does not match File v2',
		],
		[
			'current',
			'expected_outcome',
			{
				current_step: {
					step_description: 'Run current step',
					recommended_tools: [],
				},
			},
			'document does not match File v2',
		],
		[
			'previous',
			'step_description',
			{
				previous_steps: [
					{
						recommended_tools: [],
						expected_outcome: 'Previous step completed',
					},
				],
			},
			'document does not match File v2',
		],
		[
			'previous',
			'expected_outcome',
			{
				previous_steps: [
					{
						step_description: 'Run previous step',
						recommended_tools: [],
					},
				],
			},
			'step recommendation defaults are absent',
		],
	] as const)('rejects a persisted %s step missing %s', (_, __, stepFields, detail) => {
		// Given
		const snapshot = {
			...EMPTY_FILE_V2_SNAPSHOT,
			thoughts: [
				{
					sessionId: 'session-step',
					thoughts: [
						{
							...persistedThought('thought-step', 'session-step'),
							...stepFields,
						},
					],
				},
			],
		};

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail,
			})
		);
	});

	it.each([
		[
			'omitted',
			{
				step_description: 'Step without skill recommendations',
				recommended_tools: [],
				expected_outcome: 'No skill recommendation field is added',
			},
			{
				step_description: 'Step without skill recommendations',
				recommended_tools: [],
				expected_outcome: 'No skill recommendation field is added',
			},
		],
		[
			'present',
			{
				step_description: 'Step with explicit skill recommendations',
				recommended_tools: [],
				recommended_skills: [],
				expected_outcome: 'The explicit empty skill recommendation field remains',
			},
			{
				step_description: 'Step with explicit skill recommendations',
				recommended_tools: [],
				recommended_skills: [],
				expected_outcome: 'The explicit empty skill recommendation field remains',
			},
		],
	] as const)(
		'preserves the %s recommended_skills representation',
		(_, currentStep, expectedStep) => {
			// Given
			const persistedThoughtPayload = {
				...MINIMAL_PERSISTED_THOUGHT,
				current_step: currentStep,
			};

			// When
			const parsed = parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH);

			// Then
			expect(parsed.current_step).toEqual(expectedStep);
		}
	);

	it.each([
		[
			'duplicate',
			[
				{ sessionId: 'session-a', thoughts: [persistedThought('thought-a1', 'session-a')] },
				{ sessionId: 'session-a', thoughts: [persistedThought('thought-a2', 'session-a')] },
			],
		],
		[
			'out-of-order',
			[
				{ sessionId: 'session-b', thoughts: [persistedThought('thought-b', 'session-b')] },
				{ sessionId: 'session-a', thoughts: [persistedThought('thought-a', 'session-a')] },
			],
		],
	] as const)('rejects %s persisted thought session records', (_, thoughtRecords) => {
		// Given
		const snapshot = { ...EMPTY_FILE_V2_SNAPSHOT, thoughts: thoughtRecords };

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: 'thought records are duplicate or out of order',
			})
		);
	});

	it('rejects duplicate edge identifiers within a persisted session record', () => {
		// Given
		const snapshot = {
			...EMPTY_FILE_V2_SNAPSHOT,
			edges: [
				{
					sessionId: 'session-edge',
					edges: [
						{
							id: 'edge-duplicate',
							from: 'thought-a',
							to: 'thought-b',
							kind: 'sequence',
							sessionId: 'session-edge',
							createdAt: 1,
						},
						{
							id: 'edge-duplicate',
							from: 'thought-b',
							to: 'thought-c',
							kind: 'sequence',
							sessionId: 'session-edge',
							createdAt: 2,
						},
					],
				},
			],
		};

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: "duplicate edge id 'edge-duplicate'",
			})
		);
	});

	it('rejects edges outside deterministic creation order', () => {
		// Given
		const snapshot = {
			...EMPTY_FILE_V2_SNAPSHOT,
			edges: [
				{
					sessionId: 'session-edge',
					edges: [
						{
							id: 'edge-later',
							from: 'thought-b',
							to: 'thought-c',
							kind: 'sequence',
							sessionId: 'session-edge',
							createdAt: 2,
						},
						{
							id: 'edge-earlier',
							from: 'thought-a',
							to: 'thought-b',
							kind: 'sequence',
							sessionId: 'session-edge',
							createdAt: 1,
						},
					],
				},
			],
		};

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: 'edge records are out of order',
			})
		);
	});

	it('rejects an explicitly present empty thought session record', () => {
		// Given
		const snapshot = {
			...EMPTY_FILE_V2_SNAPSHOT,
			thoughts: [{ sessionId: 'session-empty', thoughts: [] }],
		};

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: 'empty thought record',
			})
		);
	});

	it.each([
		[
			'duplicate',
			[
				{ sessionId: 'session-branch', branchId: 'branch-a', thoughts: [] },
				{ sessionId: 'session-branch', branchId: 'branch-a', thoughts: [] },
			],
		],
		[
			'out-of-order',
			[
				{ sessionId: 'session-branch', branchId: 'branch-b', thoughts: [] },
				{ sessionId: 'session-branch', branchId: 'branch-a', thoughts: [] },
			],
		],
	] as const)('rejects %s persisted branch records', (_, branchRecords) => {
		// Given
		const snapshot = { ...EMPTY_FILE_V2_SNAPSHOT, branches: branchRecords };

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: 'branch records are duplicate or out of order',
			})
		);
	});

	it.each([
		[
			'edge',
			{
				edges: [
					{
						sessionId: 'session-record',
						edges: [
							{
								id: 'edge-mismatch',
								from: 'thought-a',
								to: 'thought-b',
								kind: 'sequence',
								sessionId: 'session-payload',
								createdAt: 1,
							},
						],
					},
				],
			},
			'edge session does not match its record',
		],
		[
			'summary',
			{
				summaries: [
					{
						sessionId: 'session-record',
						summaries: [
							{
								id: 'summary-mismatch',
								sessionId: 'session-payload',
								rootThoughtId: 'thought-a',
								coveredIds: ['thought-a'],
								coveredRange: [1, 1],
								topics: ['compatibility'],
								aggregateConfidence: 0.75,
								createdAt: 1,
							},
						],
					},
				],
			},
			'summary session does not match its record',
		],
	] as const)('rejects a persisted %s payload from another session', (_, records, detail) => {
		// Given
		const snapshot = { ...EMPTY_FILE_V2_SNAPSHOT, ...records };

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail,
			})
		);
	});

	it('publishes only the canonical strict snapshot document', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-layout-'));
		const backend = await FilePersistence.create({ dataDir });
		try {
			await backend.saveThought(createTestThought({ id: 'global-1' }));
			const snapshot: unknown = JSON.parse(await readFile(join(dataDir, 'snapshot.json'), 'utf-8'));
			expect(snapshot).toMatchObject({ version: 2, branches: [], edges: [], summaries: [] });
			expect(await backend.loadHistoryForSession(GLOBAL_SESSION_ID)).toHaveLength(1);
		} finally {
			await backend.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('reopens history in admission order when thought numbers are non-monotonic', async () => {
		// Given
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-admission-order-'));
		const thoughts = [30, 10, 20].map((thoughtNumber) =>
			createTestThought({ id: `file-admitted-${thoughtNumber}`, thought_number: thoughtNumber })
		);

		try {
			const writer = await FilePersistence.create({ dataDir });
			try {
				for (const thought of thoughts) await writer.saveThought(thought);
			} finally {
				await writer.close();
			}

			// When
			const reader = await FilePersistence.create({ dataDir });
			try {
				const reopened = await reader.loadHistory();

				// Then
				expect(reopened.map(({ id }) => id)).toEqual([
					'file-admitted-30',
					'file-admitted-10',
					'file-admitted-20',
				]);
			} finally {
				await reader.close();
			}
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('distinguishes malformed JSON, well-formed drift, and legacy import-required storage', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task7-classify-'));
		try {
			for (const [name, bytes, code] of [
				['malformed', '{', 'PERSISTENCE_CORRUPTION'],
				['wrong-version', '{"version":1}', 'PERSISTENCE_COMPATIBILITY'],
			] as const) {
				const dataDir = join(root, name);
				await import('node:fs/promises').then(async ({ mkdir }) => await mkdir(dataDir));
				await writeFile(join(dataDir, 'snapshot.json'), bytes, 'utf-8');
				await expect(FilePersistence.create({ dataDir })).rejects.toMatchObject({ code });
			}
			const legacyDir = join(root, 'legacy');
			await import('node:fs/promises').then(async ({ mkdir }) => await mkdir(legacyDir));
			await writeFile(join(legacyDir, 'history.json'), '[]', 'utf-8');
			await expect(FilePersistence.create({ dataDir: legacyDir })).rejects.toMatchObject({
				code: 'PERSISTENCE_IMPORT_REQUIRED',
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('imports immutable legacy sources only to an absent destination and rejects ambiguous branches', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task7-import-'));
		const source = join(root, 'source');
		const destination = join(root, 'destination');
		const ambiguous = join(root, 'ambiguous');
		await mkdir(join(source, 'branches'), { recursive: true });
		await mkdir(join(ambiguous, 'branches'), { recursive: true });
		const sourceBytes = JSON.stringify([createTestThought({ id: 'legacy-global' })]);
		await writeFile(join(source, 'history.json'), sourceBytes, 'utf-8');
		await writeFile(join(ambiguous, 'branches', 'empty.json'), '[]', 'utf-8');
		try {
			await importLegacyFileV1(source, destination);
			expect(await readFile(join(source, 'history.json'), 'utf-8')).toBe(sourceBytes);
			const imported = await FilePersistence.create({ dataDir: destination });
			expect((await imported.loadHistory()).map(({ id }) => id)).toEqual(['legacy-global']);
			await imported.close();
			await expect(importLegacyFileV1(source, destination)).rejects.toMatchObject({
				code: 'PERSISTENCE_COMPATIBILITY',
			});
			await expect(importLegacyFileV1(ambiguous, join(root, 'rejected'))).rejects.toMatchObject({
				code: 'PERSISTENCE_LEGACY_AMBIGUITY',
			});
			await expect(access(join(root, 'rejected'))).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('imports accepted-empty-v1 as one canonical empty v2 snapshot without mutating its source', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task7-empty-v1-'));
		const source = join(root, 'source');
		const destination = join(root, 'destination');
		const sessionId = asSessionId('empty-session');
		const edgePath = join(source, 'edges', `${sessionId}.json`);
		const summaryPath = join(source, 'summaries', `${sessionId}.json`);
		await mkdir(join(source, 'edges'), { recursive: true });
		await mkdir(join(source, 'summaries'), { recursive: true });
		await writeFile(edgePath, '[]', 'utf-8');
		await writeFile(summaryPath, '[]', 'utf-8');
		const sourceBytes = await Promise.all([readFile(edgePath), readFile(summaryPath)]);
		const sourceHashes = sourceBytes.map((bytes) =>
			createHash('sha256').update(bytes).digest('hex')
		);

		try {
			await importLegacyFileV1(source, destination);

			const snapshotBytes = await readFile(join(destination, 'snapshot.json'), 'utf-8');
			expect(JSON.parse(snapshotBytes)).toEqual({
				version: 2,
				thoughts: [],
				branches: [],
				edges: [],
				summaries: [],
			});
			expect(snapshotBytes).toBe(
				`${JSON.stringify({ version: 2, thoughts: [], branches: [], edges: [], summaries: [] }, null, 2)}\n`
			);
			const sourceBytesAfter = await Promise.all([readFile(edgePath), readFile(summaryPath)]);
			expect(sourceBytesAfter).toEqual(sourceBytes);
			expect(
				sourceBytesAfter.map((bytes) => createHash('sha256').update(bytes).digest('hex'))
			).toEqual(sourceHashes);
			expect(
				(await readdir(root)).filter((entry) => entry.startsWith('.destination.import-'))
			).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('imports non-empty legacy edge and summary namespaces into a reloaded v2 session', async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task7-non-empty-v1-'));
		const source = join(root, 'source');
		const destination = join(root, 'destination');
		const sessionId = asSessionId('legacy-edge-summary-session');
		const edgePath = join(source, 'edges', `${sessionId}.json`);
		const summaryPath = join(source, 'summaries', `${sessionId}.json`);
		const legacyEdge = {
			id: 'legacy-edge-1',
			from: 'legacy-thought-1',
			to: 'legacy-thought-2',
			kind: 'verifies',
			sessionId,
			createdAt: 123,
			metadata: { source: 'legacy-v1' },
		};
		const legacySummary = {
			id: 'legacy-summary-1',
			sessionId,
			branchId: 'legacy-branch',
			rootThoughtId: 'legacy-thought-1',
			coveredIds: ['legacy-thought-1', 'legacy-thought-2'],
			coveredRange: [1, 2],
			topics: ['legacy', 'import'],
			aggregateConfidence: 0.75,
			createdAt: 456,
			meta: { source: 'legacy-v1' },
		};
		await mkdir(join(source, 'edges'), { recursive: true });
		await mkdir(join(source, 'summaries'), { recursive: true });
		await writeFile(edgePath, JSON.stringify([legacyEdge]), 'utf-8');
		await writeFile(summaryPath, JSON.stringify([legacySummary]), 'utf-8');
		const sourceBytes = await Promise.all([readFile(edgePath), readFile(summaryPath)]);

		try {
			// When
			await importLegacyFileV1(source, destination);
			const reloaded = await FilePersistence.create({ dataDir: destination });
			try {
				const [edges, summaries] = await Promise.all([
					reloaded.loadEdges(sessionId),
					reloaded.loadSummaries(sessionId),
				]);

				// Then
				expect(edges).toEqual([legacyEdge]);
				expect(summaries).toEqual([legacySummary]);
			} finally {
				await reloaded.close();
			}
			expect(await Promise.all([readFile(edgePath), readFile(summaryPath)])).toEqual(sourceBytes);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		['edge', { sessionId: 'empty-session', edges: [] }],
		['summary', { sessionId: 'empty-session', summaries: [] }],
	] as const)('rejects an explicitly present empty v2 %s record', async (_, emptyRecord) => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-empty-v2-record-'));
		const snapshot = {
			version: 2,
			thoughts: [],
			branches: [],
			edges: 'edges' in emptyRecord ? [emptyRecord] : [],
			summaries: 'summaries' in emptyRecord ? [emptyRecord] : [],
		};
		await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot), 'utf-8');

		try {
			await expect(FilePersistence.create({ dataDir })).rejects.toMatchObject({
				code: 'PERSISTENCE_COMPATIBILITY',
			});
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('produces deterministic snapshots from equivalent legacy layouts', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task7-deterministic-'));
		const branchIds = [asBranchId('alpha'), asBranchId('beta')];
		try {
			for (const [sourceName, orderedBranches] of [
				['source-a', branchIds],
				['source-b', [...branchIds].reverse()],
			] as const) {
				const source = join(root, sourceName);
				await mkdir(join(source, 'branches'), { recursive: true });
				for (const branchId of orderedBranches) {
					await writeFile(
						join(source, 'branches', `${branchId}.json`),
						JSON.stringify([createTestThought({ id: `${branchId}-thought`, branch_id: branchId })]),
						'utf-8'
					);
				}
				await importLegacyFileV1(source, join(root, `destination-${sourceName}`));
			}

			expect(await readFile(join(root, 'destination-source-a', 'snapshot.json'), 'utf-8')).toBe(
				await readFile(join(root, 'destination-source-b', 'snapshot.json'), 'utf-8')
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('preserves every namespace when scoped clear publication is interrupted', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-clear-failure-'));
		let failReplacement = false;
		const backend = await FilePersistence.create({
			dataDir,
			writerOperations: {
				...nodeFileWriterOperations,
				rename: async (source, destination) => {
					if (failReplacement) throw new Error('injected scoped clear replacement failure');
					await nodeFileWriterOperations.rename(source, destination);
				},
			},
		});
		const sessionA = asSessionId('session-A');
		const sessionB = asSessionId('session-B');
		try {
			await backend.saveThoughtForSession(
				sessionA,
				createTestThought({ id: 'A-thought', session_id: sessionA })
			);
			await backend.saveThoughtForSession(
				sessionB,
				createTestThought({ id: 'B-thought', session_id: sessionB })
			);
			const snapshotPath = join(dataDir, 'snapshot.json');
			const before = await readFile(snapshotPath, 'utf-8');

			failReplacement = true;
			await expect(backend.clearSession(sessionA)).rejects.toMatchObject({
				code: 'PERSISTENCE_PUBLICATION',
			});

			expect(await readFile(snapshotPath, 'utf-8')).toBe(before);
			expect(await backend.loadHistoryForSession(sessionA)).toHaveLength(1);
			expect(await backend.loadHistoryForSession(sessionB)).toHaveLength(1);
		} finally {
			failReplacement = false;
			await backend.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('keeps legacy history and branch operations explicitly global', async () => {
		const backend = new MemoryPersistence();
		const branchId = asBranchId('global-branch');
		await expect(
			backend.saveThought(createTestThought({ id: 'named', session_id: 'named' }))
		).rejects.toMatchObject({ code: 'PERSISTENCE_SCOPE_MISMATCH' });
		await backend.saveThought(createTestThought({ id: 'global' }));
		await backend.saveBranch(branchId, [
			createTestThought({ id: 'global-branch-thought', branch_id: branchId }),
		]);
		expect((await backend.loadHistory()).map(({ id }) => id)).toEqual(['global']);
		expect(await backend.listBranches()).toEqual([branchId]);
		expect(await backend.listSessions()).toEqual([GLOBAL_SESSION_ID]);
		expect(asSessionId('named')).not.toBe(GLOBAL_SESSION_ID);
	});
});
