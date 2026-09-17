import type { SessionId } from '../contracts/ids.js';
import { ERROR_CODES, SequentialThinkingError } from '../errors.js';

/** Error thrown when attempting to process a session that is not active. */
export class SessionNotActiveError extends SequentialThinkingError {
	constructor(sessionId: SessionId) {
		super(`Session '${sessionId}' is not active`, ERROR_CODES.SESSION_NOT_ACTIVE);
		this.name = 'SessionNotActiveError';
	}
}

/** Error thrown when a requested session is not found in the pool. */
export class SessionNotFoundError extends SequentialThinkingError {
	constructor(sessionId: SessionId) {
		super(`Session not found: ${sessionId}`, ERROR_CODES.SESSION_NOT_FOUND);
		this.name = 'SessionNotFoundError';
	}
}
