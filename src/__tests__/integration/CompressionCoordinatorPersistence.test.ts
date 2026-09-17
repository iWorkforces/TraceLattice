import { afterEach, describe, expect, it } from 'vitest';
import { asBranchId } from '../../contracts/ids.js';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { ServerConfig } from '../../ServerConfig.js';
import {
	createTestSessionId,
	createTestThought,
	createTestThoughtId,
} from '../helpers/factories.js';

describe('compression coordinator persistence', () => {
	let server: ToolAwareSequentialThinkingServer | undefined;

	afterEach(async () => {
		if (server !== undefined) await server.dispose();
		server = undefined;
	});

	it('persists the complete session summary snapshot only after a coordinator drain', async () => {
		// Given
		const sessionId = createTestSessionId('compression-coordinator-persistence');
		const firstRootId = createTestThoughtId('compression-coordinator-first-root');
		const secondRootId = createTestThoughtId('compression-coordinator-second-root');
		server = await createServer({
			config: new ServerConfig({
				persistence: { enabled: true, backend: 'memory' },
				persistenceBufferSize: 1000,
				persistenceFlushInterval: 60_000,
				features: { compression: true, dagEdges: true, toolInterleave: false },
			}),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const container = server.getContainer();
		const persistence = container.resolve('Persistence');
		expect(persistence).toBeInstanceOf(MemoryPersistence);
		if (!(persistence instanceof MemoryPersistence)) {
			throw new TypeError('Expected container-owned MemoryPersistence');
		}
		const compressionService = container.resolve('compressionService');
		const summaryStore = container.resolve('summaryStore');
		server.history.addThought(
			createTestThought({ id: firstRootId, session_id: sessionId, thought: 'first summary' })
		);
		server.history.addThought(
			createTestThought({
				id: secondRootId,
				session_id: sessionId,
				thought: 'second summary',
				thought_number: 2,
			})
		);

		// When
		const first = compressionService.compressBranch(
			sessionId,
			asBranchId('compression-coordinator-first-branch'),
			firstRootId
		);
		const second = compressionService.compressBranch(
			sessionId,
			asBranchId('compression-coordinator-second-branch'),
			secondRootId
		);
		const beforeDrain = await persistence.loadSummaries(sessionId);
		await server.history.drainSession(sessionId);
		const afterDrain = await persistence.loadSummaries(sessionId);

		// Then
		expect(beforeDrain).toEqual([]);
		expect(summaryStore.forSession(sessionId)).toHaveLength(2);
		expect(afterDrain.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort());
	});
});
