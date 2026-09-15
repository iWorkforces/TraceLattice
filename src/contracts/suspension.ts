/**
 * Suspension store contract for tool interleave.
 *
 * Manages pending tool_call thoughts that are awaiting tool execution
 * results. Each suspension is identified by a unique token, has a TTL,
 * and can be resumed (consumed) or peeked (non-destructive lookup).
 *
 * @module contracts/suspension
 */

import type { SessionId, SuspensionToken } from './ids.js';

/**
 * A single pending tool-call suspension record.
 *
 * Created when a `tool_call` thought is processed and the system is
 * waiting for the corresponding tool result to be supplied via a
 * follow-up `tool_result` thought.
 */
export interface SuspensionRecord {
	/** Opaque token used to resume this suspension. */
	readonly token: SuspensionToken;
	/** Session that owns this suspension. */
	readonly sessionId: SessionId;
	/** Thought number of the originating `tool_call` thought. */
	readonly toolCallThoughtNumber: number;
	/** Name of the tool to invoke. */
	readonly toolName: string;
	/** Arguments supplied to the tool. */
	readonly toolArguments: Record<string, unknown>;
	/** Wall-clock millisecond timestamp when the record was created. */
	readonly createdAt: number;
	/** Wall-clock millisecond timestamp after which the record is expired. */
	readonly expiresAt: number;
}

/**
 * Store of pending tool-call suspensions with TTL expiry.
 *
 * Implementations are expected to expire records lazily on access and
 * (optionally) eagerly via a background sweeper started by `start()`.
 *
 * @example
 * ```typescript
 * const store: ISuspensionStore = new InMemorySuspensionStore();
 * store.start();
 * const rec = store.suspend({
 *   sessionId: 's1',
 *   toolCallThoughtNumber: 3,
 *   toolName: 'search',
 *   toolArguments: { q: 'foo' },
 *   expiresAt: Date.now() + 60_000,
 * });
 * const resumed = store.resume(rec.token);
 * store.stop();
 * ```
 */
export interface ISuspensionStore {
	/**
	 * Create and store a new suspension record.
	 *
	 * The implementation generates a unique `token` and `createdAt`
	 * timestamp. If `ttlMs` is supplied, `expiresAt` is computed as
	 * `Date.now() + ttlMs` and overrides any caller-supplied
	 * `expiresAt` value.
	 *
	 * @param record - Record fields excluding `token` and `createdAt`,
	 * with optional `ttlMs` to derive `expiresAt`.
	 * @returns The fully-populated stored record.
	 *
	 * @example
	 * ```typescript
	 * const rec = store.suspend({
	 *   sessionId: 's1',
	 *   toolCallThoughtNumber: 2,
	 *   toolName: 'search',
	 *   toolArguments: {},
	 *   ttlMs: 30_000,
	 *   expiresAt: 0,
	 * });
	 * ```
	 */
	suspend(
		record: Omit<SuspensionRecord, 'token' | 'createdAt'> & { ttlMs?: number }
	): SuspensionRecord;

	/**
	 * Consume a suspension by token.
	 *
	 * Returns `null` for both unknown tokens and expired records;
	 * expired records are removed as a side-effect. The caller
	 * (typically `ThoughtProcessor`) is expected to distinguish the
	 * two cases (e.g. via a prior `peek()`) and throw
	 * `SuspensionNotFoundError` or `SuspensionExpiredError`
	 * accordingly.
	 *
	 * @param token - Token returned from {@link suspend}.
	 * @returns The record on success, `null` if missing or expired.
	 *
	 * @example
	 * ```typescript
	 * const rec = store.resume(token);
	 * if (!rec) throw new SuspensionNotFoundError(token);
	 * ```
	 */
	resume(token: string): SuspensionRecord | null;

	/**
	 * Atomically validate and admit one suspended continuation.
	 *
	 * Operations sharing a token are serialized. The record must exist, remain
	 * unexpired, and belong to `expectedSessionId`. Session mismatches are
	 * reported as not found without consuming the record. `admit` runs
	 * synchronously inside the token critical section; the record is consumed
	 * only after the callback returns successfully.
	 *
	 * @param token - Opaque continuation token returned from {@link suspend}.
	 * @param expectedSessionId - Canonical session presenting the continuation.
	 * @param admit - Synchronous history-admission callback.
	 * @returns The admitted and consumed suspension record.
	 * @throws {SuspensionNotFoundError} If the token is missing or belongs to another session.
	 * @throws {SuspensionExpiredError} If the token expires at or before admission.
	 *
	 * @example
	 * ```typescript
	 * const record = await store.compareAndAdmit(token, sessionId, (candidate) => {
	 *   history.addThought({ ...observation, _resumedFrom: candidate.toolCallThoughtNumber });
	 * });
	 * ```
	 */
	compareAndAdmit(
		token: SuspensionToken,
		expectedSessionId: SessionId,
		admit: (record: SuspensionRecord) => void
	): Promise<SuspensionRecord>;

	/**
	 * Non-destructive lookup of a suspension by token.
	 *
	 * Does not remove expired records. Returns `null` if the token is
	 * unknown.
	 *
	 * @param token - Token to inspect.
	 * @returns The record if present (even when expired), else `null`.
	 *
	 * @example
	 * ```typescript
	 * const rec = store.peek(token);
	 * if (rec && rec.expiresAt < Date.now()) {
	 *   throw new SuspensionExpiredError(token);
	 * }
	 * ```
	 */
	peek(token: string): SuspensionRecord | null;

	/**
	 * Remove all records whose `expiresAt` is at or before `now`.
	 *
	 * @param now - Wall-clock millisecond timestamp to compare against.
	 * @returns Number of records removed.
	 *
	 * @example
	 * ```typescript
	 * const removed = store.expireOlderThan(Date.now());
	 * ```
	 */
	expireOlderThan(now: number): number;

	/**
	 * Remove all records belonging to a session.
	 *
	 * @param sessionId - Session whose records should be cleared.
	 *
	 * @example
	 * ```typescript
	 * store.clearSession('session-a');
	 * ```
	 */
	clearSession(sessionId: SessionId): void;

	/**
	 * Discard records from every session namespace.
	 * Use only for a trusted process-wide reset; scoped callers must use `clearSession`.
	 */
	clearAll(): void;

	/**
	 * Count stored records.
	 *
	 * @param sessionId - Optional session filter; when omitted, returns
	 * the total count across all sessions.
	 * @returns Number of currently stored records (expired-but-not-yet-swept
	 * records are included).
	 *
	 * @example
	 * ```typescript
	 * const total = store.size();
	 * const perSession = store.size('session-a');
	 * ```
	 */
	size(sessionId?: string): number;

	/**
	 * Start the background sweeper, if any.
	 *
	 * Idempotent — repeated calls have no additional effect.
	 *
	 * @example
	 * ```typescript
	 * store.start();
	 * ```
	 */
	start(): void;

	/**
	 * Stop the background sweeper, if any.
	 *
	 * Idempotent — repeated calls have no additional effect.
	 *
	 * @example
	 * ```typescript
	 * store.stop();
	 * ```
	 */
	stop(): void;
}
