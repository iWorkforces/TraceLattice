/**
 * Joinable coordinator for attributable persistence work.
 *
 * @module PersistenceBuffer
 */

import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { IEdgeStore } from '../contracts/interfaces.js';
import type { BranchId, SessionId } from '../contracts/ids.js';
import type { PersistenceWorkToken } from '../contracts/persistence-work.js';
import { PersistenceDrainError } from '../errors.js';
import { NullLogger } from '../logger/NullLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';
import { assertNever } from '../utils.js';
import type { Summary } from './compression/Summary.js';
import type { Edge } from './graph/Edge.js';
import { PersistenceWorkQueue, type PersistenceSelectionMode } from './PersistenceWorkQueue.js';
import { PersistenceWriter, type PersistenceDelay } from './PersistenceWriter.js';
import type { ThoughtData } from './thought.js';

/** Minimal compatibility view for legacy callers that own a `writeBuffer`. */
export interface BufferedSession {
	writeBuffer: ThoughtData[];
}

/** Event emitter contract for persistence error events. */
export interface PersistenceEventEmitter {
	emit(event: 'persistenceError', payload: { operation: string; error: Error }): boolean;
}

/** Configuration options for {@link PersistenceBuffer}. */
export interface PersistenceBufferConfig<S extends BufferedSession> {
	readonly persistence: PersistenceBackend;
	readonly bufferSize: number;
	readonly flushInterval: number;
	readonly maxRetries: number;
	readonly defaultSessionId: SessionId;
	/** Compatibility-only session source retained until producer wiring is migrated. */
	readonly getSessions: () => Map<SessionId, S>;
	/** Compatibility-only default session retained until producer wiring is migrated. */
	readonly getDefaultSession: () => S;
	/** Compatibility-only edge source retained until producers register snapshots. */
	readonly edgeStore?: IEdgeStore;
	/** Optional emitter for `persistenceError` events. */
	readonly eventEmitter?: PersistenceEventEmitter | null;
	readonly logger?: Logger;
	/** Optional retry scheduler for deterministic coordination and testing. */
	readonly delay?: PersistenceDelay;
}

type ActiveDrain = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (reason: unknown) => void;
	readonly selectedTokens: Set<PersistenceWorkToken>;
	mode: PersistenceSelectionMode;
	backgroundObserved: boolean;
};

type DrainTermination =
	{ readonly kind: 'result' } | { readonly kind: 'fault'; readonly fault: unknown };

type DrainSettlement =
	{ readonly kind: 'resolved' } | { readonly kind: 'rejected'; readonly reason: unknown };

/**
 * Coordinates one globally joinable persistence generation at a time.
 *
 * Accepted work is owned by a queue independent of live session state. Explicit
 * callers can join and upgrade a background generation without starting another writer.
 */
export class PersistenceBuffer<S extends BufferedSession> {
	private readonly _bufferSize: number;
	private readonly _flushInterval: number;
	private readonly _defaultSessionId: SessionId;
	private readonly _queue = new PersistenceWorkQueue();
	private readonly _writer: PersistenceWriter;
	private _eventEmitter: PersistenceEventEmitter | null;
	private readonly _logger: Logger;

	private _flushTimer: ReturnType<typeof setInterval> | null = null;
	private _activeDrain: ActiveDrain | null = null;

	/**
	 * Creates a persistence-drain coordinator.
	 *
	 * @param config - Persistence dependencies, trigger thresholds, and retry policy.
	 */
	public constructor(config: PersistenceBufferConfig<S>) {
		this._bufferSize = config.bufferSize;
		this._flushInterval = config.flushInterval;
		this._defaultSessionId = config.defaultSessionId;
		this._eventEmitter = config.eventEmitter ?? null;
		this._logger = config.logger ?? new NullLogger();
		this._writer = new PersistenceWriter({
			persistence: config.persistence,
			maxRetries: config.maxRetries,
			delay: config.delay,
		});
	}

	/** @returns The underlying flush timer for lifecycle introspection. */
	public get timer(): ReturnType<typeof setInterval> | null {
		return this._flushTimer;
	}

	/** @returns Whether a global drain generation is active. */
	public get isFlushing(): boolean {
		return this._activeDrain !== null;
	}

	/** @returns Number of accepted thought writes not yet acknowledged successful. */
	public get pendingThoughtCount(): number {
		return this._queue.pendingThoughtCount;
	}

	/**
	 * Sets or clears the persistence error event emitter.
	 *
	 * @param emitter - Replacement emitter, or `null` to disable events.
	 */
	public setEventEmitter(emitter: PersistenceEventEmitter | null): void {
		this._eventEmitter = emitter;
	}

	/**
	 * Accepts a thought with authoritative session attribution.
	 *
	 * The legacy session overload derives attribution from `thought.session_id` and
	 * falls back to the configured default session without using the live write buffer.
	 *
	 * @param sessionId - Session that owns the accepted thought.
	 * @param thought - Thought to persist.
	 */
	public bufferThought(sessionId: SessionId, thought: ThoughtData): void;
	public bufferThought(session: BufferedSession, thought: ThoughtData): void;
	public bufferThought(source: SessionId | BufferedSession, thought: ThoughtData): void {
		if (this._queue.pendingThoughtCount >= this._bufferSize && this.isFlushing) {
			this._logger.info('Write buffer full and flush in progress, applying backpressure', {
				bufferSize: this._queue.pendingThoughtCount,
				maxSize: this._bufferSize,
			});
		}

		const sessionId =
			typeof source === 'string' ? source : (thought.session_id ?? this._defaultSessionId);
		this._queue.enqueueThought(sessionId, thought);
		if (this._queue.pendingThoughtCount >= this._bufferSize) this._triggerBackgroundDrain();
	}

	/**
	 * Accepts the latest snapshot for one session-owned branch.
	 *
	 * @param sessionId - Session that owns the branch.
	 * @param branchId - Stable branch coordinate.
	 * @param thoughts - Branch snapshot copied by the queue.
	 */
	public bufferBranch(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): void {
		this._queue.replaceBranch(sessionId, branchId, thoughts);
	}

	/**
	 * Accepts the latest edge snapshot for one session.
	 *
	 * @param sessionId - Session that owns the edges.
	 * @param edges - Edge snapshot copied by the queue.
	 */
	public bufferEdges(sessionId: SessionId, edges: readonly Edge[]): void {
		this._queue.replaceEdges(sessionId, edges);
	}

	/**
	 * Accepts the latest summary snapshot for one session.
	 *
	 * @param sessionId - Session that owns the summaries.
	 * @param summaries - Summary snapshot copied by the queue.
	 */
	public bufferSummaries(sessionId: SessionId, summaries: readonly Summary[]): void {
		this._queue.replaceSummaries(sessionId, summaries);
	}

	/** Starts the periodic background-drain timer without keeping the process alive. */
	public startFlushTimer(): void {
		if (this._flushTimer !== null) return;
		this._flushTimer = setInterval(() => this._triggerBackgroundDrain(), this._flushInterval);
		if (typeof this._flushTimer === 'object' && 'unref' in this._flushTimer) {
			this._flushTimer.unref();
		}
	}

	/** Stops the periodic background-drain timer. */
	public stopFlushTimer(): void {
		if (this._flushTimer === null) return;
		clearInterval(this._flushTimer);
		this._flushTimer = null;
	}

	/**
	 * Starts or joins an explicit global drain generation.
	 *
	 * @returns The exact shared promise for the active generation.
	 */
	public drain(): Promise<void> {
		return this._joinOrStart('explicit').promise;
	}

	/** @returns The exact same promise as {@link drain} for the active generation. */
	public flush(): Promise<void> {
		return this.drain();
	}

	/**
	 * Joins the global explicit generation and projects its terminal failures to one session.
	 *
	 * @param sessionId - Session whose accepted writes form the barrier projection.
	 * @returns A promise that rejects only for that session's failures or an unknown fault.
	 */
	public drainSession(sessionId: SessionId): Promise<void> {
		const generation = this._joinOrStart('explicit');
		return generation.promise.catch((reason: unknown) => {
			if (!(reason instanceof PersistenceDrainError)) throw reason;
			const failures = reason.failures.filter((failure) => failure.sessionId === sessionId);
			if (failures.length > 0) throw new PersistenceDrainError(failures);
		});
	}

	private _joinOrStart(mode: PersistenceSelectionMode): ActiveDrain {
		const active = this._activeDrain;
		if (active !== null) {
			if (mode === 'explicit') active.mode = mode;
			return active;
		}

		let resolveGeneration = (): void => undefined;
		let rejectGeneration = (_reason: unknown): void => undefined;
		const promise = new Promise<void>((resolve, reject) => {
			resolveGeneration = resolve;
			rejectGeneration = reject;
		});
		const generation: ActiveDrain = {
			promise,
			resolve: resolveGeneration,
			reject: rejectGeneration,
			selectedTokens: new Set<PersistenceWorkToken>(),
			mode,
			backgroundObserved: false,
		};
		this._activeDrain = generation;
		void this._runDrain(generation).catch((fault: unknown) => {
			this._closeGeneration(generation, { kind: 'fault', fault });
		});
		return generation;
	}

	private _triggerBackgroundDrain(): void {
		const generation = this._joinOrStart('background');
		if (generation.backgroundObserved) return;
		generation.backgroundObserved = true;
		void generation.promise.catch(() => undefined);
	}

	private async _runDrain(generation: ActiveDrain): Promise<void> {
		while (true) {
			const work = this._queue.nextEligibleWork(generation.selectedTokens, generation.mode);
			if (work === undefined) {
				this._closeGeneration(generation, { kind: 'result' });
				return;
			}

			const result = await this._writer.write(work);
			if (result === true) this._queue.acknowledgeSuccess(work);
			else this._queue.acknowledgeFailure(work, result);
		}
	}

	private _closeGeneration(generation: ActiveDrain, termination: DrainTermination): void {
		if (this._activeDrain !== generation) return;
		let settlement: DrainSettlement;
		switch (termination.kind) {
			case 'result': {
				const result = this._queue.generationResult(generation.selectedTokens);
				settlement =
					result.failures.length === 0
						? { kind: 'resolved' }
						: { kind: 'rejected', reason: new PersistenceDrainError(result.failures) };
				break;
			}
			case 'fault':
				settlement = { kind: 'rejected', reason: termination.fault };
				break;
			default:
				return assertNever(termination);
		}

		this._activeDrain = null;
		switch (settlement.kind) {
			case 'resolved':
				generation.resolve();
				return;
			case 'rejected':
				generation.reject(settlement.reason);
				if (settlement.reason instanceof PersistenceDrainError) {
					this._observeFailure(generation, settlement.reason);
				}
				return;
			default:
				return assertNever(settlement);
		}
	}

	private _observeFailure(generation: ActiveDrain, error: PersistenceDrainError): void {
		this._logger.info('Persistence drain completed with failures', {
			failed: error.failures.length,
			selected: generation.selectedTokens.size,
		});
		this._eventEmitter?.emit('persistenceError', { operation: 'flushBuffer', error });
	}
}
