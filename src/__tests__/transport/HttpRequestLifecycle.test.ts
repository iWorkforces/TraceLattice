import { describe, expect, it } from 'vitest';
import {
	LIFECYCLE_REPORTING_FAILURE_CAPACITY,
	LifecycleFailureReporter,
} from '../../transport/HttpRequestLifecycle.js';

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
