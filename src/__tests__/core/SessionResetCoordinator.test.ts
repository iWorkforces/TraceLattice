import { describe, expect, it } from 'vitest';

import { asSessionId } from '../../contracts/ids.js';
import { SessionResetCoordinator } from '../../core/SessionResetCoordinator.js';
import { AsyncResetRequiredError } from '../../core/SessionErrors.js';
import { NullLogger } from '../../logger/NullLogger.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';

interface TestSessionState {
	readonly owner: string | undefined;
}

function createCoordinator(): SessionResetCoordinator<TestSessionState> {
	return new SessionResetCoordinator({
		persistence: new MemoryPersistence(),
		barrier: null,
		sessions: new Map(),
		createSessionState: (owner) => ({ owner }),
		logger: new NullLogger(),
	});
}

describe('SessionResetCoordinator', () => {
	it('rejects a persistent session reset when no durable barrier is configured', async () => {
		const coordinator = createCoordinator();

		const reset = coordinator.resetSession(asSessionId('session-a'), undefined);

		await expect(reset).rejects.toBeInstanceOf(AsyncResetRequiredError);
	});

	it('rejects a persistent global reset when no durable barrier is configured', async () => {
		const coordinator = createCoordinator();

		const reset = coordinator.resetAll();

		await expect(reset).rejects.toBeInstanceOf(AsyncResetRequiredError);
	});
});
