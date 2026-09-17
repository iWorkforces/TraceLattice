import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { IEdgeStore } from '../contracts/interfaces.js';
import type { SessionId } from '../contracts/ids.js';
import type { ISummaryStore } from '../contracts/summary.js';
import type { Logger } from '../logger/StructuredLogger.js';
import { requireSessionScopedPersistence } from '../persistence/SessionScopedPersistence.js';
import { AsyncResetRequiredError } from './SessionErrors.js';

interface ResetBarrier {
	withSessionResetBarrier(sessionId: SessionId, operation: () => Promise<void>): Promise<void>;
	withGlobalResetBarrier(operation: () => Promise<void>): Promise<void>;
}

export interface SessionResetCoordinatorConfig<SessionState> {
	readonly persistence: PersistenceBackend | null;
	readonly barrier: ResetBarrier | null;
	readonly edgeStore?: IEdgeStore;
	readonly summaryStore?: ISummaryStore;
	readonly sessions: Map<SessionId, SessionState>;
	readonly createSessionState: (owner: string | undefined) => SessionState;
	readonly logger: Logger;
}

export class SessionResetCoordinator<SessionState> {
	private readonly _persistence: PersistenceBackend | null;
	private readonly _barrier: ResetBarrier | null;
	private readonly _edgeStore?: IEdgeStore;
	private readonly _summaryStore?: ISummaryStore;
	private readonly _sessions: Map<SessionId, SessionState>;
	private readonly _createSessionState: (owner: string | undefined) => SessionState;
	private readonly _logger: Logger;

	constructor(config: SessionResetCoordinatorConfig<SessionState>) {
		this._persistence = config.persistence;
		this._barrier = config.barrier;
		this._edgeStore = config.edgeStore;
		this._summaryStore = config.summaryStore;
		this._sessions = config.sessions;
		this._createSessionState = config.createSessionState;
		this._logger = config.logger;
	}

	clearSession(sessionId: SessionId): void {
		if (this._persistence !== null) throw new AsyncResetRequiredError('session', sessionId);
		this._clearSessionStores(sessionId);
		this._sessions.delete(sessionId);
		this._logger.info('Session cleared', { sessionId });
	}

	clearAll(): void {
		if (this._persistence !== null) throw new AsyncResetRequiredError('all');
		this._clearAllLiveState();
	}

	async resetSession(
		sessionId: SessionId,
		preservedOwner: string | undefined,
		clearAuxiliaryState?: () => void
	): Promise<void> {
		if (this._persistence === null) {
			this._replaceLiveSession(sessionId, preservedOwner);
			clearAuxiliaryState?.();
			return;
		}
		const scopedPersistence = requireSessionScopedPersistence(this._persistence, 'clearSession');
		if (this._barrier === null) throw new AsyncResetRequiredError('session', sessionId);
		await this._barrier.withSessionResetBarrier(sessionId, async () => {
			await scopedPersistence.clearSession(sessionId);
			this._replaceLiveSession(sessionId, preservedOwner);
			clearAuxiliaryState?.();
		});
	}

	async resetAll(clearAuxiliaryState?: () => void): Promise<void> {
		const persistence = this._persistence;
		if (persistence === null) {
			this._clearAllLiveState();
			clearAuxiliaryState?.();
			return;
		}
		if (this._barrier === null) throw new AsyncResetRequiredError('all');
		await this._barrier.withGlobalResetBarrier(async () => {
			await persistence.clear();
			this._clearAllLiveState();
			clearAuxiliaryState?.();
		});
	}

	private _replaceLiveSession(sessionId: SessionId, owner: string | undefined): void {
		this._clearSessionStores(sessionId);
		this._sessions.set(sessionId, this._createSessionState(owner));
		this._logger.info('Session reset', { sessionId });
	}

	private _clearSessionStores(sessionId: SessionId): void {
		this._edgeStore?.clearSession(sessionId);
		this._summaryStore?.clearSession(sessionId);
	}

	private _clearAllLiveState(): void {
		this._edgeStore?.clearAll();
		this._summaryStore?.clearAll();
		this._sessions.clear();
		this._logger.info('History cleared (all sessions)');
	}
}
