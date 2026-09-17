import type { SessionId } from '../contracts/ids.js';
import type { PersistenceWorkFailure } from '../contracts/persistence-work.js';
import { ERROR_CODES, SequentialThinkingError } from '../errors.js';

/** Error raised when an explicit persistence drain has terminal write failures. */
export class PersistenceDrainError extends SequentialThinkingError {
	/** Failures captured when the drain generation settled. */
	public readonly failures: readonly PersistenceWorkFailure[];

	constructor(failures: readonly PersistenceWorkFailure[]) {
		super(
			`Persistence drain failed with ${failures.length} terminal ${failures.length === 1 ? 'failure' : 'failures'}`,
			ERROR_CODES.PERSISTENCE_DRAIN
		);
		this.name = 'PersistenceDrainError';
		this.failures = Object.freeze([...failures]);
	}
}

/** Error raised when persistence work is submitted while a lifecycle owner holds the session. */
export class PersistenceSessionAdmissionClosedError extends SequentialThinkingError {
	/** Session whose persistence admission is closed. */
	public readonly sessionId: SessionId;

	constructor(sessionId: SessionId) {
		super(
			`Persistence admission for session '${sessionId}' is closed by a lifecycle barrier`,
			ERROR_CODES.PERSISTENCE_SESSION_ADMISSION_CLOSED
		);
		this.name = 'PersistenceSessionAdmissionClosedError';
		this.sessionId = sessionId;
	}
}

/** Error raised when an owning async call chain tries to reacquire its session barrier. */
export class PersistenceSessionBarrierReentrancyError extends SequentialThinkingError {
	/** Session already owned by the current async call chain. */
	public readonly sessionId: SessionId;

	constructor(sessionId: SessionId) {
		super(
			`Persistence lifecycle barrier for session '${sessionId}' is not reentrant`,
			ERROR_CODES.PERSISTENCE_SESSION_BARRIER_REENTRANCY
		);
		this.name = 'PersistenceSessionBarrierReentrancyError';
		this.sessionId = sessionId;
	}
}
