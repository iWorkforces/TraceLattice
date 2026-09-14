import { describe, expect, it } from 'vitest';
import { asBranchId } from '../../contracts/ids.js';
import type { Summary } from '../../contracts/summary.js';
import { CompressionService } from '../../core/compression/CompressionService.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import {
	createTestSessionId,
	createTestThought,
	createTestThoughtId,
	MockHistoryManager,
} from '../helpers/factories.js';

describe('CompressionService summary creation notification', () => {
	it('notifies after the new summary is available in the store', () => {
		// Given
		const sessionId = createTestSessionId('summary-created-ordering');
		const rootThoughtId = createTestThoughtId('summary-created-root');
		const historyManager = new MockHistoryManager();
		const summaryStore = new InMemorySummaryStore();
		const observedSnapshots: Summary[][] = [];
		historyManager.addThought(
			createTestThought({ id: rootThoughtId, session_id: sessionId, thought: 'ordered summary' })
		);
		const service = new CompressionService({
			historyManager,
			edgeStore: new EdgeStore(),
			summaryStore,
			onSummaryCreated: (summary) => {
				observedSnapshots.push([...summaryStore.forSession(summary.sessionId)]);
			},
		});

		// When
		const summary = service.compressBranch(
			sessionId,
			asBranchId('summary-created-branch'),
			rootThoughtId
		);

		// Then
		expect(observedSnapshots).toEqual([[summary]]);
	});

	it('notifies exactly once when the same branch root is recompressed', () => {
		// Given
		const sessionId = createTestSessionId('summary-created-idempotency');
		const branchId = asBranchId('summary-created-idempotent-branch');
		const rootThoughtId = createTestThoughtId('summary-created-idempotent-root');
		const historyManager = new MockHistoryManager();
		const summaryStore = new InMemorySummaryStore();
		const notifications: Summary[] = [];
		historyManager.addThought(
			createTestThought({ id: rootThoughtId, session_id: sessionId, thought: 'stable summary' })
		);
		const service = new CompressionService({
			historyManager,
			edgeStore: new EdgeStore(),
			summaryStore,
			onSummaryCreated: (summary) => notifications.push(summary),
		});

		// When
		const first = service.compressBranch(sessionId, branchId, rootThoughtId);
		const second = service.compressBranch(sessionId, branchId, rootThoughtId);

		// Then
		expect(second).toBe(first);
		expect(notifications).toEqual([first]);
	});
});
