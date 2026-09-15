/**
 * SessionManager — owns periodic session cleanup timer and TTL/LRU eviction logic.
 *
 * Extracted from HistoryManager. The session Map remains owned by HistoryManager
 * (passed by reference) so that public access patterns are preserved.
 *
 * @module SessionManager
 */

import type { Logger } from '../logger/StructuredLogger.js';
import { NullLogger } from '../logger/NullLogger.js';
import type { SessionId } from '../contracts/ids.js';

/** Minimal session contract — anything with a `lastAccessedAt` timestamp and optional owner. */
export interface SessionLike {
	lastAccessedAt: number;
	/** Owner identifier for per-owner LRU quota. Undefined for stdio/global sessions. */
	owner?: string;
	/** Startup-restored namespaces are protected from eviction until durable eviction exists. */
	provenance?: 'restored';
}

/** Configuration options for SessionManager. */
export interface SessionManagerConfig {
	/** Default session key that must never be evicted. */
	defaultSessionId: string;
	/** TTL for inactive sessions in milliseconds. */
	sessionTtlMs: number;
	/** Periodic cleanup interval in milliseconds. */
	cleanupIntervalMs: number;
	/** Returns the current MAX_SESSIONS limit (callable so tests can mutate). */
	getMaxSessions: () => number;
	/** Maximum sessions per owner (per-owner LRU bucket). @default 50 */
	maxSessionsPerOwner?: number;
	logger?: Logger;
}

/**
 * Manages session lifecycle: periodic stale-session cleanup and LRU eviction
 * when the session count exceeds the configured maximum.
 */
export class SessionManager<S extends SessionLike> {
	private readonly _defaultSessionId: string;
	private readonly _sessionTtlMs: number;
	private readonly _cleanupIntervalMs: number;
	private readonly _getMaxSessions: () => number;
	private readonly _maxSessionsPerOwner: number;
	private readonly _logger: Logger;
	private _cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: SessionManagerConfig) {
		this._defaultSessionId = config.defaultSessionId;
		this._sessionTtlMs = config.sessionTtlMs;
		this._cleanupIntervalMs = config.cleanupIntervalMs;
		this._getMaxSessions = config.getMaxSessions;
		this._maxSessionsPerOwner = config.maxSessionsPerOwner ?? 50;
		this._logger = config.logger ?? new NullLogger();
	}

	/** Returns the underlying cleanup timer (for test introspection). */
	public get timer(): ReturnType<typeof setInterval> | null {
		return this._cleanupTimer;
	}

	/**
	 * Starts the periodic session cleanup timer. No-op if already started.
	 * The timer is unref'd so it does not block process exit.
	 */
	public startCleanupTimer(sessions: Map<SessionId, S>): void {
		if (this._cleanupTimer !== null) return;
		this._cleanupTimer = setInterval(() => {
			this.cleanupStaleSessions(sessions);
		}, this._cleanupIntervalMs);
		if (
			this._cleanupTimer &&
			typeof this._cleanupTimer === 'object' &&
			'unref' in this._cleanupTimer
		) {
			this._cleanupTimer.unref();
		}
	}

	/** Stops the periodic session cleanup timer. */
	public stopCleanupTimer(): void {
		if (this._cleanupTimer !== null) {
			clearInterval(this._cleanupTimer);
			this._cleanupTimer = null;
		}
	}

	/**
	 * Evicts sessions that have been inactive longer than `sessionTtlMs`.
	 * The default session is never evicted.
	 */
	public cleanupStaleSessions(sessions: Map<SessionId, S>): void {
		const now = Date.now();
		for (const [key, session] of sessions) {
			if (key === this._defaultSessionId) continue;
			if (session.provenance === 'restored') continue;
			if (now - session.lastAccessedAt > this._sessionTtlMs) {
				sessions.delete(key);
				this._logger.info('Evicted stale session', { sessionId: key });
			}
		}
	}

	/**
	 * Evicts oldest sessions when the configured maximums are exceeded.
	 *
	 * Two-stage policy:
	 * 1. Per-owner LRU: each owner is capped at `maxSessionsPerOwner`. Sessions
	 *    without an owner (stdio path) are exempt from per-owner quota.
	 * 2. Global LRU cap: enforces overall `getMaxSessions()` limit.
	 *
	 * The default session is never evicted at either stage.
	 */
	public evictExcessSessions(sessions: Map<SessionId, S>): void {
		this._evictPerOwnerOverflow(sessions);
		this._evictGlobalOverflow(sessions);
	}

	/** Per-owner quota enforcement: oldest sessions per owner bucket are evicted. */
	private _evictPerOwnerOverflow(sessions: Map<SessionId, S>): void {
		const ownerCounts = new Map<string, number>();
		for (const [key, session] of sessions) {
			if (key === this._defaultSessionId) continue;
			if (session.provenance === 'restored') continue;
			if (session.owner === undefined) continue;
			ownerCounts.set(session.owner, (ownerCounts.get(session.owner) ?? 0) + 1);
		}

		const maxPerOwner = this._maxSessionsPerOwner;
		for (const [owner, count] of ownerCounts) {
			if (count <= maxPerOwner) continue;
			const ownerSessions: Array<[SessionId, S]> = [];
			for (const [key, session] of sessions) {
				if (key === this._defaultSessionId) continue;
				if (session.provenance === 'restored') continue;
				if (session.owner !== owner) continue;
				ownerSessions.push([key, session]);
			}
			ownerSessions.sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt);
			const toEvict = count - maxPerOwner;
			for (let i = 0; i < toEvict && i < ownerSessions.length; i++) {
				const [evictKey] = ownerSessions[i]!;
				sessions.delete(evictKey);
				this._logger.info('Evicted oldest session (per-owner LRU)', {
					sessionId: evictKey,
					owner,
				});
			}
		}
	}

	/** Global LRU cap enforcement: evicts oldest until under `getMaxSessions()`. */
	private _evictGlobalOverflow(sessions: Map<SessionId, S>): void {
		const max = this._getMaxSessions();
		let liveSessionCount = Array.from(sessions.values()).filter(
			(session) => session.provenance !== 'restored'
		).length;
		while (liveSessionCount > max) {
			let oldestKey: SessionId | null = null;
			let oldestTime = Infinity;
			for (const [key, session] of sessions) {
				if (key === this._defaultSessionId) continue;
				if (session.provenance === 'restored') continue;
				if (session.lastAccessedAt < oldestTime) {
					oldestTime = session.lastAccessedAt;
					oldestKey = key;
				}
			}
			if (oldestKey !== null) {
				sessions.delete(oldestKey);
				liveSessionCount--;
				this._logger.info('Evicted oldest session (global LRU)', { sessionId: oldestKey });
			} else {
				break;
			}
		}
	}
}
