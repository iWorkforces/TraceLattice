/**
 * In-memory implementation of {@link ISuspensionStore}.
 *
 * Stores suspension records in process memory with optional background
 * sweeping of expired entries. Suitable for single-process deployments;
 * cluster setups should provide a shared backend.
 *
 * @module core/tools/InMemorySuspensionStore
 */

import type { ISuspensionStore, SuspensionRecord } from '../../contracts/suspension.js';
import {
	generateSuspensionToken,
	asSessionId,
	type SessionId,
	type SuspensionToken,
} from '../../contracts/ids.js';
import type { Logger } from '../../logger/StructuredLogger.js';
import { SuspensionExpiredError, SuspensionNotFoundError } from '../../errors.js';

/**
 * Configuration for {@link InMemorySuspensionStore}.
 */
export interface InMemorySuspensionStoreConfig {
	/** Default TTL applied to records that omit `ttlMs`. Defaults to 60_000ms. */
	ttlMs?: number;
	/** Sweep interval for the background expiry timer. Defaults to 60_000ms. */
	sweepIntervalMs?: number;
	/** Optional logger; reserved for future diagnostic output. */
	/** Optional logger for diagnostic output. */
	logger?: Logger;
}

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * In-memory suspension store with TTL expiry and background sweep.
 *
 * @example
 * ```typescript
 * const store = new InMemorySuspensionStore({ ttlMs: 30_000 });
 * store.start();
 * const rec = store.suspend({
 *   sessionId: 's1',
 *   toolCallThoughtNumber: 3,
 *   toolName: 'search',
 *   toolArguments: { q: 'foo' },
 *   expiresAt: 0,
 * });
 * const resumed = store.resume(rec.token);
 * store.stop();
 * ```
 */
export class InMemorySuspensionStore implements ISuspensionStore {
	private readonly _byToken: Map<SuspensionToken, SuspensionRecord> = new Map();
	private readonly _bySession: Map<SessionId, Set<SuspensionToken>> = new Map();
	private readonly _admissionTails: Map<SuspensionToken, Promise<void>> = new Map();
	private readonly _ttlMs: number;
	private readonly _sweepIntervalMs: number;
	private _timer: ReturnType<typeof setInterval> | null = null;

	constructor(config: InMemorySuspensionStoreConfig = {}) {
		this._ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
		this._sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
	}

	suspend(
		record: Omit<SuspensionRecord, 'token' | 'createdAt'> & { ttlMs?: number }
	): SuspensionRecord {
		const token = generateSuspensionToken();
		const createdAt = Date.now();
		const ttlMs = record.ttlMs ?? this._ttlMs;
		const expiresAt = createdAt + ttlMs;

		const full: SuspensionRecord = {
			token,
			sessionId: record.sessionId,
			toolCallThoughtNumber: record.toolCallThoughtNumber,
			toolName: record.toolName,
			toolArguments: record.toolArguments,
			createdAt,
			expiresAt,
		};

		this._byToken.set(token, full);
		let bucket = this._bySession.get(full.sessionId);
		if (!bucket) {
			bucket = new Set();
			this._bySession.set(full.sessionId, bucket);
		}
		bucket.add(token);

		return full;
	}

	resume(token: string): SuspensionRecord | null {
		const rec = this._byToken.get(token as SuspensionToken);
		if (!rec) return null;
		if (rec.expiresAt <= Date.now()) {
			this._delete(token as SuspensionToken, rec.sessionId);
			return null;
		}
		this._delete(token as SuspensionToken, rec.sessionId);
		return rec;
	}

	async compareAndAdmit(
		token: SuspensionToken,
		expectedSessionId: SessionId,
		admit: (record: SuspensionRecord) => void
	): Promise<SuspensionRecord> {
		const previous = this._admissionTails.get(token) ?? Promise.resolve();
		const release = Promise.withResolvers<void>();
		const tail = previous.then(
			() => release.promise,
			() => release.promise
		);
		this._admissionTails.set(token, tail);

		try {
			await previous.then(
				() => undefined,
				() => undefined
			);
			const record = this._byToken.get(token);
			if (record === undefined) {
				throw new SuspensionNotFoundError('Suspension token not found: ' + token);
			}
			const now = Date.now();
			if (record.expiresAt <= now) {
				this._delete(token, record.sessionId);
				throw new SuspensionExpiredError('Suspension token expired: ' + token);
			}
			if (record.sessionId !== expectedSessionId) {
				throw new SuspensionNotFoundError('Suspension token not found: ' + token);
			}

			admit(record);
			this._delete(token, record.sessionId);
			return record;
		} finally {
			release.resolve();
			if (this._admissionTails.get(token) === tail) {
				this._admissionTails.delete(token);
			}
		}
	}

	peek(token: string): SuspensionRecord | null {
		return this._byToken.get(token as SuspensionToken) ?? null;
	}

	expireOlderThan(now: number): number {
		let removed = 0;
		for (const [token, rec] of this._byToken) {
			if (rec.expiresAt <= now) {
				this._delete(token, rec.sessionId);
				removed++;
			}
		}
		return removed;
	}

	clearSession(sessionId: string): void {
		const bucket = this._bySession.get(asSessionId(sessionId));
		if (!bucket) return;
		for (const token of bucket) {
			this._byToken.delete(token);
		}
		this._bySession.delete(asSessionId(sessionId));
	}

	clearAll(): void {
		this._byToken.clear();
		this._bySession.clear();
	}

	size(sessionId?: string): number {
		if (sessionId === undefined) return this._byToken.size;
		return this._bySession.get(asSessionId(sessionId))?.size ?? 0;
	}

	start(): void {
		if (this._timer !== null) return;
		this._timer = setInterval(() => {
			this.expireOlderThan(Date.now());
		}, this._sweepIntervalMs);
		this._timer.unref?.();
	}

	stop(): void {
		if (this._timer === null) return;
		clearInterval(this._timer);
		this._timer = null;
	}

	private _delete(token: SuspensionToken, sessionId: SessionId): void {
		this._byToken.delete(token);
		const bucket = this._bySession.get(sessionId);
		if (bucket) {
			bucket.delete(token);
			if (bucket.size === 0) this._bySession.delete(sessionId);
		}
	}
}
