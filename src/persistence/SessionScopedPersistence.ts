import type {
	PersistenceBackend,
	SessionScopedPersistenceBackend,
	SessionScopedPersistenceOperation,
} from '../contracts/PersistenceBackend.js';
import { supportsSessionScopedPersistence } from '../contracts/PersistenceBackend.js';
import { PersistenceCapabilityError } from './PersistenceErrors.js';

/** Require the complete scoped capability without falling back to legacy global operations. */
export function requireSessionScopedPersistence(
	backend: PersistenceBackend,
	operation: SessionScopedPersistenceOperation
): SessionScopedPersistenceBackend {
	if (!supportsSessionScopedPersistence(backend)) {
		throw new PersistenceCapabilityError(operation);
	}
	return backend;
}
