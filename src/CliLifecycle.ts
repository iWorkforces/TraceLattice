import { CliShutdownTimeoutError } from './errors.js';

export const CLI_SHUTDOWN_DEADLINE_MS = 30_000;

export interface CliOwnedResource {
	stop(): void | Promise<void>;
}

export interface CliShutdownBoundary {
	reportFailure(error: unknown): void;
	exit(code: 0 | 1): void;
}

export interface CliLifecycleOptions {
	readonly deadlineMs?: number;
	readonly clock?: CliLifecycleClock;
}

export interface CliLifecycleClock {
	setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout): void;
}

const SYSTEM_CLOCK: CliLifecycleClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
};

function appendFailure(failures: unknown[], failure: unknown): void {
	if (failure instanceof AggregateError) {
		for (const nestedFailure of failure.errors) appendFailure(failures, nestedFailure);
		return;
	}
	failures.push(failure);
}

export class CliLifecycle {
	private readonly _server: CliOwnedResource;
	private readonly _deadlineMs: number;
	private readonly _clock: CliLifecycleClock;
	private _transport: CliOwnedResource | null = null;
	private _shutdownPromise: Promise<void> | null = null;

	constructor(server: CliOwnedResource, options: CliLifecycleOptions = {}) {
		this._server = server;
		this._deadlineMs = options.deadlineMs ?? CLI_SHUTDOWN_DEADLINE_MS;
		this._clock = options.clock ?? SYSTEM_CLOCK;
	}

	attachTransport(transport: CliOwnedResource): void {
		if (this._transport) throw new TypeError('CLI transport owner is already attached');
		this._transport = transport;
	}

	shutdown(): Promise<void> {
		if (this._shutdownPromise) return this._shutdownPromise;
		const completion = Promise.withResolvers<void>();
		this._shutdownPromise = completion.promise;
		this._startShutdown(completion);
		return this._shutdownPromise;
	}

	async rollbackStartup(startupFailure: unknown): Promise<never> {
		const rollbackFailure = await this.shutdown().then(
			() => null,
			(error: unknown) => error
		);
		if (rollbackFailure === null) throw startupFailure;
		const failures = [startupFailure];
		appendFailure(failures, rollbackFailure);
		throw new AggregateError(failures, 'CLI startup failed and rollback did not complete cleanly');
	}

	private _startShutdown(completion: PromiseWithResolvers<void>): void {
		const deadline = Promise.withResolvers<never>();
		const timeout = this._clock.setTimeout(() => {
			deadline.reject(new CliShutdownTimeoutError(this._deadlineMs));
		}, this._deadlineMs);
		void Promise.race([this._stopOwnedResources(), deadline.promise]).then(
			() => {
				this._clock.clearTimeout(timeout);
				completion.resolve();
			},
			(error: unknown) => {
				this._clock.clearTimeout(timeout);
				completion.reject(error);
			}
		);
	}

	private async _stopOwnedResources(): Promise<void> {
		const failures: unknown[] = [];
		const resources = this._transport ? [this._transport, this._server] : [this._server];
		for (const resource of resources) {
			try {
				await resource.stop();
			} catch (error) {
				appendFailure(failures, error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, 'CLI shutdown did not complete cleanly');
		}
	}
}

export function createCliShutdownHandler(
	lifecycle: CliLifecycle,
	boundary: CliShutdownBoundary
): () => Promise<void> {
	let handlerPromise: Promise<void> | null = null;
	return (): Promise<void> => {
		if (handlerPromise) return handlerPromise;
		handlerPromise = lifecycle.shutdown().then(
			() => boundary.exit(0),
			(error: unknown) => {
				boundary.reportFailure(error);
				boundary.exit(1);
			}
		);
		return handlerPromise;
	};
}
