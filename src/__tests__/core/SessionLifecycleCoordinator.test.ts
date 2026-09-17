import { describe, expect, it, vi } from 'vitest';

import { asSessionId } from '../../contracts/ids.js';
import { SessionLifecycleCoordinator } from '../../core/SessionLifecycleCoordinator.js';
import { SessionLifecycleClosedError } from '../../core/SessionErrors.js';

interface Deferred {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

function deferred(): Deferred {
	const result = Promise.withResolvers<void>();
	return { promise: result.promise, resolve: result.resolve };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('SessionLifecycleCoordinator admission', () => {
	it('counts a pre-close operation until completion and rejects post-close work before callback', async () => {
		// Given
		const sessionId = asSessionId('admission-session');
		const coordinator = new SessionLifecycleCoordinator();
		const operationGate = deferred();
		const resetStarted = deferred();
		const operation = coordinator.runOperation(sessionId, async () => operationGate.promise);
		const rejectedCallback = vi.fn(async () => undefined);

		// When
		const reset = coordinator.withSessionReset(sessionId, async () => {
			resetStarted.resolve();
		});
		const rejected = coordinator.runOperation(sessionId, rejectedCallback);
		await flushMicrotasks();

		// Then
		expect(coordinator.phaseFor(sessionId)).toBe('resetting');
		expect(coordinator.isIdle(sessionId)).toBe(false);
		await expect(rejected).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		expect(rejectedCallback).not.toHaveBeenCalled();
		let resetEntered = false;
		void resetStarted.promise.then(() => {
			resetEntered = true;
		});
		await flushMicrotasks();
		expect(resetEntered).toBe(false);

		operationGate.resolve();
		await operation;
		await reset;
		expect(coordinator.phaseFor(sessionId)).toBe('open');
		expect(coordinator.isIdle(sessionId)).toBe(true);
	});

	it('reuses a same-session lifecycle context for nested synchronous mutation', async () => {
		// Given
		const sessionId = asSessionId('nested-mutation');
		const coordinator = new SessionLifecycleCoordinator();
		const events: string[] = [];

		// When
		await coordinator.runOperation(sessionId, async () => {
			coordinator.runMutation(sessionId, () => events.push('nested'));
		});

		// Then
		expect(events).toEqual(['nested']);
		expect(coordinator.isIdle(sessionId)).toBe(true);
	});

	it('rejects an ordinary-operation to exclusive upgrade without deadlocking', async () => {
		// Given
		const sessionId = asSessionId('upgrade-session');
		const coordinator = new SessionLifecycleCoordinator();
		const exclusiveCallback = vi.fn(async () => undefined);

		// When
		const result = coordinator.runOperation(sessionId, async () =>
			coordinator.withSessionReset(sessionId, exclusiveCallback)
		);

		// Then
		await expect(result).rejects.toThrow(
			"Cannot upgrade an admitted operation for session 'upgrade-session' to reset"
		);
		expect(exclusiveCallback).not.toHaveBeenCalled();
		expect(coordinator.phaseFor(sessionId)).toBe('open');
	});
});

describe('SessionLifecycleCoordinator exclusives', () => {
	it('retains reset failure state and permits one explicit reset retry', async () => {
		// Given
		const sessionId = asSessionId('reset-retry');
		const coordinator = new SessionLifecycleCoordinator();
		const failure = new Error('reset failed');

		// When
		await expect(
			coordinator.withSessionReset(sessionId, async () => Promise.reject(failure))
		).rejects.toBe(failure);
		const retry = coordinator.withSessionReset(sessionId, async () => 'reset');

		// Then
		expect(coordinator.phaseFor(sessionId)).toBe('resetting');
		await expect(retry).resolves.toBe('reset');
		expect(coordinator.phaseFor(sessionId)).toBe('open');
	});

	it('reuses the owning same-session reset exclusive for reset internals', async () => {
		// Given
		const sessionId = asSessionId('reset-internals');
		const coordinator = new SessionLifecycleCoordinator();
		const events: string[] = [];

		// When
		await coordinator.withSessionReset(sessionId, async () => {
			events.push('outer');
			await coordinator.withSessionReset(sessionId, async () => {
				events.push('inner');
			});
		});

		// Then
		expect(events).toEqual(['outer', 'inner']);
		expect(coordinator.phaseFor(sessionId)).toBe('open');
	});

	it('rejects a different-session exclusive before invoking its callback', async () => {
		// Given
		const sessionA = asSessionId('exclusive-session-a');
		const sessionB = asSessionId('exclusive-session-b');
		const coordinator = new SessionLifecycleCoordinator();
		const nestedCallback = vi.fn(async () => undefined);
		let nested: Promise<void> | undefined;

		// When
		await coordinator.withSessionReset(sessionA, async () => {
			nested = coordinator.withSessionEviction(sessionB, nestedCallback);
		});

		// Then
		await expect(nested).rejects.toBeInstanceOf(TypeError);
		expect(nestedCallback).not.toHaveBeenCalled();
		expect(coordinator.phaseFor(sessionA)).toBe('open');
		expect(coordinator.phaseFor(sessionB)).toBe('open');
	});

	it('retains eviction failure and requires retryFailed for the later retry', async () => {
		// Given
		const sessionId = asSessionId('eviction-retry');
		const coordinator = new SessionLifecycleCoordinator();
		const failure = new Error('eviction failed');

		// When
		await expect(
			coordinator.withSessionEviction(sessionId, async () => Promise.reject(failure))
		).rejects.toBe(failure);
		const implicitRetry = coordinator.withSessionEviction(sessionId, async () => undefined);

		// Then
		await expect(implicitRetry).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		await expect(
			coordinator.withSessionEviction(sessionId, async () => 'evicted', { retryFailed: true })
		).resolves.toBe('evicted');
		expect(coordinator.phaseFor(sessionId)).toBe('open');
	});

	it('gives a session exclusive one owner while it waits for admitted work', async () => {
		// Given
		const sessionId = asSessionId('single-owner');
		const coordinator = new SessionLifecycleCoordinator();
		const operationGate = deferred();
		const operation = coordinator.runOperation(sessionId, async () => operationGate.promise);
		const first = coordinator.withSessionReset(sessionId, async () => undefined);

		// When
		const second = coordinator.withSessionReset(sessionId, async () => undefined);

		// Then
		await expect(second).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		operationGate.resolve();
		await Promise.all([operation, first]);
	});

	it('global reset closes admission, waits for all pre-close work, and has one owner', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const sessionA = asSessionId('global-a');
		const gate = deferred();
		const operation = coordinator.runOperation(sessionA, async () => gate.promise);
		const resetCallback = vi.fn(async () => 'reset');

		// When
		const reset = coordinator.withGlobalReset(resetCallback);
		const competing = coordinator.withGlobalReset(async () => undefined);
		await flushMicrotasks();

		// Then
		expect(coordinator.globalPhase).toBe('resetting');
		expect(resetCallback).not.toHaveBeenCalled();
		await expect(competing).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		await expect(
			coordinator.runOperation(asSessionId('global-b'), async () => undefined)
		).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		gate.resolve();
		await operation;
		await expect(reset).resolves.toBe('reset');
		expect(coordinator.globalPhase).toBe('open');
	});

	it('rejects a session-exclusive to global-exclusive upgrade without self-waiting', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const sessionId = asSessionId('exclusive-upgrade');
		let upgrade: Promise<void> | undefined;

		// When
		await coordinator.withSessionReset(sessionId, async () => {
			upgrade = coordinator.withGlobalReset(async () => undefined);
		});

		// Then
		await expect(upgrade).rejects.toThrow(
			'Cannot upgrade an active lifecycle context to global reset'
		);
		expect(coordinator.globalPhase).toBe('open');
	});
});

describe('SessionLifecycleCoordinator shutdown and atomic idle eviction', () => {
	it('memoizes one successful shutdown settlement', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const operation = vi.fn(async () => undefined);

		// When
		const first = coordinator.shutdown(operation);
		const second = coordinator.shutdown(operation);

		// Then
		expect(first).toBe(second);
		await expect(first).resolves.toBeUndefined();
		expect(operation).toHaveBeenCalledOnce();
		expect(coordinator.globalPhase).toBe('stopped');
	});

	it('memoizes a failed shutdown and never retries its callback', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const failure = new Error('shutdown failed');
		const operation = vi.fn(async () => Promise.reject(failure));

		// When
		const first = coordinator.shutdown(operation);
		const second = coordinator.shutdown(async () => undefined);

		// Then
		expect(first).toBe(second);
		await expect(first).rejects.toBe(failure);
		expect(operation).toHaveBeenCalledOnce();
		expect(coordinator.globalPhase).toBe('shutdown_failed');
	});

	it('allows shutdown to own the coordinator after a failed global reset', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		await expect(
			coordinator.withGlobalReset(async () => Promise.reject(new Error('reset failed')))
		).rejects.toThrow('reset failed');

		// When
		const result = coordinator.shutdown(async () => undefined);

		// Then
		await expect(result).resolves.toBeUndefined();
		expect(coordinator.globalPhase).toBe('stopped');
	});

	it('prevalidates a complete idle set before one synchronous eviction callback', () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const idle = asSessionId('idle');
		const active = asSessionId('active');
		const gate = deferred();
		const activeOperation = coordinator.runOperation(active, async () => gate.promise);
		const cleanup = vi.fn((_sessionIds: readonly (typeof idle)[]) => undefined);

		// When
		const evicted = coordinator.tryEvictIdleSessions([idle, active], cleanup);

		// Then
		expect(evicted).toBe(false);
		expect(cleanup).not.toHaveBeenCalled();
		expect(coordinator.phaseFor(idle)).toBe('open');
		gate.resolve();
		return activeOperation;
	});

	it('leaves every selected session failed when atomic idle cleanup throws', () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const sessionA = asSessionId('idle-a');
		const sessionB = asSessionId('idle-b');
		const failure = new Error('cleanup failed');

		// When
		const cleanup = (): void => {
			throw failure;
		};

		// Then
		expect(() => coordinator.tryEvictIdleSessions([sessionA, sessionB], cleanup)).toThrow(failure);
		expect(coordinator.phaseFor(sessionA)).toBe('eviction_failed');
		expect(coordinator.phaseFor(sessionB)).toBe('eviction_failed');
	});
});
