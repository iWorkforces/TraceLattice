/**
 * Core-local admission and exclusive lifecycle coordination.
 *
 * @module SessionLifecycleCoordinator
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { SessionId } from '../contracts/ids.js';
import { SessionLifecycleClosedError } from './SessionErrors.js';

/** Global lifecycle phases owned by the coordinator. */
export type GlobalLifecyclePhase =
	'open' | 'resetting' | 'reset_failed' | 'shutting_down' | 'stopped' | 'shutdown_failed';

/** Per-session lifecycle phases owned by the coordinator. */
export type SessionLifecyclePhase =
	'open' | 'resetting' | 'reset_failed' | 'evicting' | 'eviction_failed';

/** Options for retrying a failed session eviction. */
export interface SessionEvictionOptions {
	readonly retryFailed: boolean;
}

type SessionState = {
	phase: SessionLifecyclePhase;
	activeOperations: number;
};

type LifecycleContext =
	| { readonly kind: 'operation'; readonly sessionId: SessionId }
	| { readonly kind: 'session_exclusive'; readonly sessionId: SessionId }
	| { readonly kind: 'global_exclusive' };

type SessionExclusive = {
	readonly active: 'resetting' | 'evicting';
	readonly failed: 'reset_failed' | 'eviction_failed';
};

const RESET_EXCLUSIVE: SessionExclusive = { active: 'resetting', failed: 'reset_failed' };
const EVICTION_EXCLUSIVE: SessionExclusive = { active: 'evicting', failed: 'eviction_failed' };

/**
 * Linearizes operation admission before external session locking and owns lifecycle exclusives.
 *
 * @example
 * ```ts
 * const lifecycle = new SessionLifecycleCoordinator();
 * await lifecycle.runOperation(sessionId, () => sessionLock.withLock(sessionId, operation));
 * ```
 */
export class SessionLifecycleCoordinator {
	private readonly _sessions = new Map<SessionId, SessionState>();
	private readonly _context = new AsyncLocalStorage<LifecycleContext>();
	private readonly _sessionIdleWaiters = new Map<SessionId, Set<() => void>>();
	private readonly _globalIdleWaiters = new Set<() => void>();
	private _globalPhase: GlobalLifecyclePhase = 'open';
	private _activeOperations = 0;
	private _maintenanceOwners = 0;
	private _shutdownPromise: Promise<void> | null = null;

	/** @returns The current global lifecycle phase. */
	public get globalPhase(): GlobalLifecyclePhase {
		return this._globalPhase;
	}

	/** @returns Whether any session lifecycle exclusive is active. */
	public get hasMaintenance(): boolean {
		return this._maintenanceOwners > 0;
	}

	/** @returns The current phase for a session, defaulting to `open`. */
	public phaseFor(sessionId: SessionId): SessionLifecyclePhase {
		return this._sessions.get(sessionId)?.phase ?? 'open';
	}

	/** @returns Whether a session is open and has no admitted operation. */
	public isIdle(sessionId: SessionId): boolean {
		const state = this._sessions.get(sessionId);
		return state === undefined || (state.phase === 'open' && state.activeOperations === 0);
	}

	/** Admits an asynchronous operation synchronously and releases it in `finally`. */
	public runOperation<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
		const admissionError = this._admissionError(sessionId);
		if (admissionError !== undefined) return Promise.reject(admissionError);
		this._admit(sessionId);
		return this._context.run({ kind: 'operation', sessionId }, async () => {
			try {
				return await operation();
			} finally {
				this._release(sessionId);
			}
		});
	}

	/** Guards direct synchronous mutation, reusing a valid owning lifecycle context. */
	public runMutation<T>(sessionId: SessionId, mutation: () => T): T {
		if (this._contextOwnsSession(sessionId)) return mutation();
		const admissionError = this._admissionError(sessionId);
		if (admissionError !== undefined) throw admissionError;
		this._admit(sessionId);
		try {
			return this._context.run({ kind: 'operation', sessionId }, mutation);
		} finally {
			this._release(sessionId);
		}
	}

	/** Closes one session for reset and permits retry only from `reset_failed`. */
	public withSessionReset<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
		return this._startSessionExclusive(sessionId, RESET_EXCLUSIVE, operation, true);
	}

	/** Closes one session for eviction, optionally retrying `eviction_failed`. */
	public withSessionEviction<T>(
		sessionId: SessionId,
		operation: () => Promise<T>,
		options: SessionEvictionOptions = { retryFailed: false }
	): Promise<T> {
		return this._startSessionExclusive(
			sessionId,
			EVICTION_EXCLUSIVE,
			operation,
			options.retryFailed
		);
	}

	/** Closes global admission for a reset and permits retry from `reset_failed`. */
	public withGlobalReset<T>(operation: () => Promise<T>): Promise<T> {
		const context = this._context.getStore();
		if (context !== undefined) return Promise.reject(this._globalUpgradeError('global reset'));
		if (this._globalPhase !== 'open' && this._globalPhase !== 'reset_failed') {
			return Promise.reject(new SessionLifecycleClosedError(undefined, this._globalPhase));
		}
		this._globalPhase = 'resetting';
		return this._runGlobalReset(operation);
	}

	/** Closes admission once and returns the same shutdown settlement to every caller. */
	public shutdown(operation: () => Promise<void>): Promise<void> {
		if (this._shutdownPromise !== null) return this._shutdownPromise;
		const context = this._context.getStore();
		if (context !== undefined) return Promise.reject(this._globalUpgradeError('shutdown'));
		if (this._globalPhase !== 'open' && this._globalPhase !== 'reset_failed') {
			return Promise.reject(new SessionLifecycleClosedError(undefined, this._globalPhase));
		}
		this._globalPhase = 'shutting_down';
		const settlement = this._runShutdown(operation);
		this._shutdownPromise = settlement;
		return settlement;
	}

	/**
	 * Atomically claims and removes a complete already-idle candidate set.
	 *
	 * @returns `false` without invoking cleanup when any candidate is not idle.
	 */
	public tryEvictIdleSessions(
		sessionIds: readonly SessionId[],
		operation: (sessionIds: readonly SessionId[]) => void
	): boolean {
		if (this._globalPhase !== 'open' || sessionIds.some((sessionId) => !this.isIdle(sessionId))) {
			return false;
		}
		const uniqueIds = [...new Set(sessionIds)];
		for (const sessionId of uniqueIds) this._state(sessionId).phase = 'evicting';
		this._maintenanceOwners += 1;
		try {
			operation(uniqueIds);
			for (const sessionId of uniqueIds) this._sessions.delete(sessionId);
			return true;
		} catch (error) {
			for (const sessionId of uniqueIds) this._state(sessionId).phase = 'eviction_failed';
			throw error;
		} finally {
			this._maintenanceOwners -= 1;
			this._notifyGlobalIdle();
		}
	}

	private _startSessionExclusive<T>(
		sessionId: SessionId,
		exclusive: SessionExclusive,
		operation: () => Promise<T>,
		allowFailedRetry: boolean
	): Promise<T> {
		const context = this._context.getStore();
		if (
			context?.kind === 'session_exclusive' &&
			context.sessionId === sessionId &&
			this.phaseFor(sessionId) === exclusive.active
		) {
			return operation();
		}
		if (context?.kind === 'operation') {
			return Promise.reject(
				this._upgradeError(exclusive.active === 'resetting' ? 'reset' : 'eviction', sessionId)
			);
		}
		if (context !== undefined && !this._contextOwnsSession(sessionId)) {
			return Promise.reject(
				this._globalUpgradeError(
					`session ${exclusive.active === 'resetting' ? 'reset' : 'eviction'}`
				)
			);
		}
		const state = this._state(sessionId);
		const retrying = state.phase === exclusive.failed && allowFailedRetry;
		if (this._globalPhase !== 'open') {
			return Promise.reject(new SessionLifecycleClosedError(sessionId, this._globalPhase));
		}
		if (state.phase !== 'open' && !retrying) {
			return Promise.reject(new SessionLifecycleClosedError(sessionId, state.phase));
		}
		state.phase = exclusive.active;
		this._maintenanceOwners += 1;
		return this._runSessionExclusive(sessionId, exclusive, operation);
	}

	private async _runSessionExclusive<T>(
		sessionId: SessionId,
		exclusive: SessionExclusive,
		operation: () => Promise<T>
	): Promise<T> {
		try {
			await this._waitSessionIdle(sessionId);
			const result = await this._context.run({ kind: 'session_exclusive', sessionId }, operation);
			this._sessions.delete(sessionId);
			return result;
		} catch (error) {
			this._state(sessionId).phase = exclusive.failed;
			throw error;
		} finally {
			this._maintenanceOwners -= 1;
			this._notifyGlobalIdle();
		}
	}

	private async _runGlobalReset<T>(operation: () => Promise<T>): Promise<T> {
		try {
			await this._waitGlobalIdle();
			const result = await this._context.run({ kind: 'global_exclusive' }, operation);
			this._sessions.clear();
			this._globalPhase = 'open';
			return result;
		} catch (error) {
			this._globalPhase = 'reset_failed';
			throw error;
		}
	}

	private async _runShutdown(operation: () => Promise<void>): Promise<void> {
		try {
			await this._waitGlobalIdle();
			await this._context.run({ kind: 'global_exclusive' }, operation);
			this._globalPhase = 'stopped';
		} catch (error) {
			this._globalPhase = 'shutdown_failed';
			throw error;
		}
	}

	private _state(sessionId: SessionId): SessionState {
		const state = this._sessions.get(sessionId) ?? { phase: 'open', activeOperations: 0 };
		this._sessions.set(sessionId, state);
		return state;
	}

	private _admissionError(sessionId: SessionId): SessionLifecycleClosedError | undefined {
		if (this._globalPhase !== 'open') {
			return new SessionLifecycleClosedError(sessionId, this._globalPhase);
		}
		const phase = this.phaseFor(sessionId);
		return phase === 'open' ? undefined : new SessionLifecycleClosedError(sessionId, phase);
	}

	private _admit(sessionId: SessionId): void {
		this._state(sessionId).activeOperations += 1;
		this._activeOperations += 1;
	}

	private _release(sessionId: SessionId): void {
		const state = this._state(sessionId);
		state.activeOperations -= 1;
		this._activeOperations -= 1;
		if (state.activeOperations === 0) {
			const waiters = this._sessionIdleWaiters.get(sessionId);
			this._sessionIdleWaiters.delete(sessionId);
			for (const resolve of waiters ?? []) resolve();
		}
		this._notifyGlobalIdle();
	}

	private _waitSessionIdle(sessionId: SessionId): Promise<void> {
		if (this._state(sessionId).activeOperations === 0) return Promise.resolve();
		const result = Promise.withResolvers<void>();
		const waiters = this._sessionIdleWaiters.get(sessionId) ?? new Set<() => void>();
		waiters.add(result.resolve);
		this._sessionIdleWaiters.set(sessionId, waiters);
		return result.promise;
	}

	private _waitGlobalIdle(): Promise<void> {
		if (this._activeOperations === 0 && this._maintenanceOwners === 0) return Promise.resolve();
		const result = Promise.withResolvers<void>();
		this._globalIdleWaiters.add(result.resolve);
		return result.promise;
	}

	private _notifyGlobalIdle(): void {
		if (this._activeOperations !== 0 || this._maintenanceOwners !== 0) return;
		for (const resolve of this._globalIdleWaiters) resolve();
		this._globalIdleWaiters.clear();
	}

	private _contextOwnsSession(sessionId: SessionId): boolean {
		const context = this._context.getStore();
		return context?.kind === 'global_exclusive' || context?.sessionId === sessionId;
	}

	private _upgradeError(mode: string, sessionId: SessionId): TypeError {
		return new TypeError(
			`Cannot upgrade an admitted operation for session '${sessionId}' to ${mode}`
		);
	}

	private _globalUpgradeError(mode: string): TypeError {
		return new TypeError(`Cannot upgrade an active lifecycle context to ${mode}`);
	}
}
