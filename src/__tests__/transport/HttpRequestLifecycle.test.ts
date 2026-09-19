import { describe, expect, it, vi } from 'vitest';
import {
	AcceptedWorkTracker,
	LIFECYCLE_REPORTING_FAILURE_CAPACITY,
	LifecycleFailureReporter,
	PreDispatchTracker,
} from '../../transport/HttpRequestLifecycle.js';

describe('AcceptedWorkTracker', () => {
	it('refuses canceled pre-dispatch work without leaving a reservation', async () => {
		const preDispatch = new PreDispatchTracker();
		const acceptedWork = new AcceptedWorkTracker(new LifecycleFailureReporter(() => undefined));
		const lease = preDispatch.acquire();
		if (!lease) throw new TypeError('Pre-dispatch lease was not acquired');
		lease.cancel('shutdown');
		const start = vi.fn(() => Promise.resolve());

		expect(() => acceptedWork.transfer(lease, start)).toThrowError(DOMException);
		expect(start).not.toHaveBeenCalled();
		await expect(acceptedWork.join()).resolves.toBeUndefined();

		lease.release();
		await preDispatch.join();
	});
});

describe('LifecycleFailureReporter', () => {
	it('retains only the newest reporting failures after capacity is exceeded', () => {
		const reportingError = new Error('logger failure');
		const reporter = new LifecycleFailureReporter(() => {
			throw reportingError;
		});
		const lifecycleErrors = Array.from(
			{ length: 10_000 },
			(_, index) => new Error(`lifecycle failure ${index}`)
		);

		for (const lifecycleError of lifecycleErrors) {
			expect(() => reporter.report(lifecycleError)).not.toThrow();
		}

		const failures = reporter.reportingFailures;
		expect(failures).toHaveLength(LIFECYCLE_REPORTING_FAILURE_CAPACITY);
		expect(failures.map((failure) => failure.lifecycleError)).toEqual(
			lifecycleErrors.slice(-LIFECYCLE_REPORTING_FAILURE_CAPACITY)
		);
		expect(failures.map((failure) => failure.reportingError)).toEqual(
			Array(LIFECYCLE_REPORTING_FAILURE_CAPACITY).fill(reportingError)
		);
		expect(reporter.reportingFailureCount).toBe(10_000);
		expect(reporter.droppedReportingFailureCount).toBe(
			10_000 - LIFECYCLE_REPORTING_FAILURE_CAPACITY
		);
		expect(reporter.reportingFailures).not.toBe(failures);
	});
});
