import type { SessionId } from '../contracts/ids.js';
import { ERROR_CODES, SequentialThinkingError } from '../errors.js';

/** Lifecycle phase that can close ordinary session admission. */
export type SessionLifecycleClosedPhase =
	| 'resetting'
	| 'reset_failed'
	| 'evicting'
	| 'eviction_failed'
	| 'shutting_down'
	| 'stopped'
	| 'shutdown_failed';

/** Error thrown when an operation arrives after lifecycle admission has closed. */
export class SessionLifecycleClosedError extends SequentialThinkingError {
	/** Session whose admission is closed, or `undefined` for a global exclusive request. */
	public readonly sessionId: SessionId | undefined;
	/** Lifecycle phase that rejected admission. */
	public readonly phase: SessionLifecycleClosedPhase;

	public constructor(sessionId: SessionId | undefined, phase: SessionLifecycleClosedPhase) {
		const scope = sessionId === undefined ? 'Global' : `Session '${sessionId}'`;
		super(
			`${scope} lifecycle admission is closed in phase '${phase}'`,
			ERROR_CODES.SESSION_LIFECYCLE_CLOSED
		);
		this.name = 'SessionLifecycleClosedError';
		this.sessionId = sessionId;
		this.phase = phase;
	}
}

/** Error thrown when a per-session async lock cannot be acquired in time. */
export class LockTimeoutError extends SequentialThinkingError {
	public readonly sessionId: SessionId;
	public readonly timeoutMs: number;

	constructor(sessionId: SessionId, timeoutMs: number) {
		super(`Lock timeout for session '${sessionId}' after ${timeoutMs}ms`, ERROR_CODES.LOCK_TIMEOUT);
		this.name = 'LockTimeoutError';
		this.sessionId = sessionId;
		this.timeoutMs = timeoutMs;
	}
}

/** Error thrown when a session is accessed by a non-owner. */
export class SessionAccessDeniedError extends SequentialThinkingError {
	public readonly sessionId: SessionId;
	public readonly expectedOwner: string;
	public readonly actualOwner: string | undefined;

	constructor(sessionId: SessionId, expectedOwner: string, actualOwner?: string) {
		super(
			`Access denied to session '${sessionId}': owned by '${expectedOwner}', accessed by '${actualOwner ?? 'anonymous'}'`,
			ERROR_CODES.SESSION_ACCESS_DENIED
		);
		this.name = 'SessionAccessDeniedError';
		this.sessionId = sessionId;
		this.expectedOwner = expectedOwner;
		this.actualOwner = actualOwner;
	}
}

/** Scope requested through the legacy synchronous clear API. */
export type AsyncResetScope = 'session' | 'all';

/** Condition that makes the legacy synchronous clear API unsafe. */
export type AsyncResetReason = 'persistent' | 'active';

/** Error raised when state requires the awaitable reset API. */
export class AsyncResetRequiredError extends SequentialThinkingError {
	public readonly scope: AsyncResetScope;
	public readonly sessionId: SessionId | undefined;
	public readonly reason: AsyncResetReason;

	constructor(
		scope: AsyncResetScope,
		sessionId?: SessionId,
		reason: AsyncResetReason = 'persistent'
	) {
		const target = scope === 'session' ? `session '${sessionId}'` : 'all sessions';
		super(
			`Synchronous clear cannot reset ${reason} ${target}; use the awaitable ${scope === 'session' ? 'resetSession()' : 'resetAll()'} API`,
			ERROR_CODES.ASYNC_RESET_REQUIRED
		);
		this.name = 'AsyncResetRequiredError';
		this.scope = scope;
		this.sessionId = sessionId;
		this.reason = reason;
	}
}
