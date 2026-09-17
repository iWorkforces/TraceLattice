import type { ServerResponse } from 'node:http';

type ResponseWriter = (response: ServerResponse) => void;
type WorkFailureHandler = (error: unknown) => void;

export type LifecycleReportingFailure = {
	readonly lifecycleError: unknown;
	readonly reportingError: unknown;
};

/** Maximum number of reporting failures retained for diagnostics. */
export const LIFECYCLE_REPORTING_FAILURE_CAPACITY = 32;

export class LifecycleFailureReporter {
	private readonly _reportingFailures: LifecycleReportingFailure[] = [];
	private _reportingFailureCount = 0;
	private _droppedReportingFailureCount = 0;

	constructor(private readonly _onFailure: WorkFailureHandler) {}

	get reportingFailures(): readonly LifecycleReportingFailure[] {
		return [...this._reportingFailures];
	}

	get reportingFailureCount(): number {
		return this._reportingFailureCount;
	}

	get droppedReportingFailureCount(): number {
		return this._droppedReportingFailureCount;
	}

	report(error: unknown): void {
		try {
			this._onFailure(error);
		} catch (reportingError) {
			this._reportingFailureCount++;
			if (this._reportingFailures.length === LIFECYCLE_REPORTING_FAILURE_CAPACITY) {
				this._reportingFailures.shift();
				this._droppedReportingFailureCount++;
			}
			this._reportingFailures.push({ lifecycleError: error, reportingError });
		}
	}
}

export class ResponseFinalizer {
	private _isFinalized = false;

	constructor(
		private readonly _response: ServerResponse,
		private readonly _failureReporter: LifecycleFailureReporter
	) {
		this._response.once('close', () => {
			this._isFinalized = true;
		});
	}

	finalize(writer: ResponseWriter): boolean {
		if (this._isFinalized || this._response.destroyed || this._response.writableEnded) {
			this._isFinalized = true;
			return false;
		}

		this._isFinalized = true;
		try {
			writer(this._response);
		} catch (error) {
			this._failureReporter.report(error);
			this._response.destroy();
		}
		return true;
	}
}

export class AcceptedWorkTracker {
	private readonly _work = new Set<Promise<void>>();

	constructor(private readonly _failureReporter: LifecycleFailureReporter) {}

	get size(): number {
		return this._work.size;
	}

	track(work: Promise<void>): void {
		const observed = work.catch((error: unknown) => {
			this._failureReporter.report(error);
		});
		this._work.add(observed);
		void observed.then(() => {
			this._work.delete(observed);
		});
	}

	async join(): Promise<void> {
		while (this._work.size > 0) {
			await Promise.all(this._work);
		}
	}
}
