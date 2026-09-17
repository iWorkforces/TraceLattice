import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CLI_SHUTDOWN_DEADLINE_MS,
	CliLifecycle,
	createCliShutdownHandler,
	type CliOwnedResource,
} from '../CliLifecycle.js';
import { CliShutdownTimeoutError } from '../errors.js';

class LifecycleFixtureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LifecycleFixtureError';
	}
}

function deferred(): PromiseWithResolvers<void> {
	return Promise.withResolvers<void>();
}

afterEach(() => {
	vi.useRealTimers();
});

describe('CliLifecycle', () => {
	it('uses one 30,000 ms production shutdown deadline', () => {
		// Given / When / Then
		expect(CLI_SHUTDOWN_DEADLINE_MS).toBe(30_000);
	});

	it('returns one exact shutdown promise to first and repeated signal handlers', async () => {
		// Given
		const transportGate = deferred();
		const transport = { stop: vi.fn(() => transportGate.promise) } satisfies CliOwnedResource;
		const server = { stop: vi.fn(async () => undefined) } satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server);
		lifecycle.attachTransport(transport);

		// When
		const first = lifecycle.shutdown();
		const repeated = lifecycle.shutdown();

		// Then
		expect(repeated).toBe(first);
		expect(transport.stop).toHaveBeenCalledOnce();
		expect(server.stop).not.toHaveBeenCalled();
		transportGate.resolve();
		await first;
		expect(server.stop).toHaveBeenCalledOnce();
	});

	it('attempts transport then server cleanup and flattens all failures deterministically', async () => {
		// Given
		const calls: string[] = [];
		const transportFirst = new LifecycleFixtureError('transport first');
		const transportSecond = new LifecycleFixtureError('transport second');
		const serverFailure = new LifecycleFixtureError('server failure');
		const transport = {
			stop: vi.fn(async () => {
				calls.push('transport');
				throw new AggregateError(
					[transportFirst, new AggregateError([transportSecond], 'nested')],
					'transport'
				);
			}),
		} satisfies CliOwnedResource;
		const server = {
			stop: vi.fn(async () => {
				calls.push('server');
				throw serverFailure;
			}),
		} satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server);
		lifecycle.attachTransport(transport);

		// When
		const outcome = await lifecycle.shutdown().then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);

		// Then
		expect(calls).toEqual(['transport', 'server']);
		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected' || !(outcome.error instanceof AggregateError)) {
			throw new LifecycleFixtureError('Expected aggregate shutdown failure');
		}
		expect(outcome.error.errors).toEqual([transportFirst, transportSecond, serverFailure]);
	});

	it('rejects with a typed deadline and never later reports success', async () => {
		// Given
		vi.useFakeTimers();
		const transportGate = deferred();
		const transport = { stop: vi.fn(() => transportGate.promise) } satisfies CliOwnedResource;
		const server = { stop: vi.fn(async () => undefined) } satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server, { deadlineMs: 25 });
		lifecycle.attachTransport(transport);
		const exit = vi.fn<(code: 0 | 1) => void>();
		const reportFailure = vi.fn<(error: unknown) => void>();
		const handler = createCliShutdownHandler(lifecycle, { exit, reportFailure });

		// When
		const firstSignal = handler();
		const repeatedSignal = handler();
		await vi.advanceTimersByTimeAsync(25);

		// Then
		expect(repeatedSignal).toBe(firstSignal);
		await firstSignal;
		expect(reportFailure).toHaveBeenCalledOnce();
		expect(reportFailure.mock.calls[0]?.[0]).toBeInstanceOf(CliShutdownTimeoutError);
		expect(exit).toHaveBeenCalledWith(1);
		transportGate.resolve();
		await vi.runAllTimersAsync();
		expect(server.stop).toHaveBeenCalledOnce();
		expect(exit).not.toHaveBeenCalledWith(0);
	});

	it('rolls back partially acquired resources and aggregates rollback failures', async () => {
		// Given
		const startupFailure = new LifecycleFixtureError('startup failed');
		const transportFailure = new LifecycleFixtureError('transport rollback failed');
		const serverFailure = new LifecycleFixtureError('server rollback failed');
		const transport = {
			stop: vi.fn(async () => {
				throw transportFailure;
			}),
		} satisfies CliOwnedResource;
		const server = {
			stop: vi.fn(async () => {
				throw serverFailure;
			}),
		} satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server);
		lifecycle.attachTransport(transport);

		// When
		const outcome = await lifecycle.rollbackStartup(startupFailure).then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);

		// Then
		expect(transport.stop).toHaveBeenCalledOnce();
		expect(server.stop).toHaveBeenCalledOnce();
		if (outcome.kind !== 'rejected' || !(outcome.error instanceof AggregateError)) {
			throw new LifecycleFixtureError('Expected aggregate startup rollback failure');
		}
		expect(outcome.error.errors).toEqual([startupFailure, transportFailure, serverFailure]);
	});

	it('uses the same coordinator for stdio transport close and server cleanup', async () => {
		// Given
		const calls: string[] = [];
		const stdio = {
			stop: vi.fn(async () => {
				calls.push('stdio');
			}),
		} satisfies CliOwnedResource;
		const server = {
			stop: vi.fn(async () => {
				calls.push('server');
			}),
		} satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server);
		lifecycle.attachTransport(stdio);

		// When
		await lifecycle.shutdown();

		// Then
		expect(calls).toEqual(['stdio', 'server']);
	});

});
