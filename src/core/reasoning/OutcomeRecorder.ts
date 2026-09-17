/**
 * Records verification outcomes for confidence calibration.
 *
 * No-op implementation when feature flag is disabled.
 * Stores outcomes per-session in memory for later calibration use.
 *
 * @module core/reasoning/OutcomeRecorder
 */

import type { IOutcomeRecorder, VerificationOutcome } from '../../contracts/interfaces.js';
import { asSessionId, type SessionId } from '../../contracts/ids.js';

/**
 * Configuration for OutcomeRecorder.
 */
export interface OutcomeRecorderConfig {
	/** Whether outcome recording is enabled. */
	enabled: boolean;
}

/**
 * Records verification outcomes for confidence calibration.
 *
 * When disabled (default), all methods are no-ops and return empty arrays.
 * When enabled, outcomes are stored in memory per-session.
 *
 * @example
 * ```typescript
 * const recorder = new OutcomeRecorder({ enabled: true });
 * recorder.recordVerification({
 *   thoughtId: 't1',
 *   thoughtNumber: 1,
 *   sessionId: 'session-a',
 *   predicted: 0.8,
 *   actual: 1,
 *   type: 'verification',
 * });
 * const outcomes = recorder.getOutcomes('session-a');
 * ```
 */
export class OutcomeRecorder implements IOutcomeRecorder {
	private readonly _outcomes: Map<SessionId, VerificationOutcome[]> = new Map();
	private readonly _enabled: boolean;

	/**
	 * Whether outcome recording is currently enabled.
	 */
	public get enabled(): boolean {
		return this._enabled;
	}

	/**
	 * Create a new OutcomeRecorder.
	 *
	 * @param config - Recorder configuration
	 */
	constructor(config: OutcomeRecorderConfig) {
		this._enabled = config.enabled;
	}

	/**
	 * Record a verification outcome.
	 *
	 * No-op when outcome recording is disabled.
	 *
	 * @param outcome - The outcome data (recordedAt is auto-set)
	 */
	recordVerification(outcome: Omit<VerificationOutcome, 'recordedAt'>): void {
		if (!this._enabled) return;

		const full: VerificationOutcome = {
			...outcome,
			recordedAt: Date.now(),
		};

		const sessionId = asSessionId(outcome.sessionId);
		const sessionOutcomes = this._outcomes.get(sessionId) ?? [];
		sessionOutcomes.push(full);
		this._outcomes.set(sessionId, sessionOutcomes);
	}

	/**
	 * Get all recorded outcomes for a session.
	 *
	 * @param sessionId - The session id to query
	 * @returns Array of outcomes (empty when disabled or no data)
	 */
	getOutcomes(sessionId: string): VerificationOutcome[] {
		if (!this._enabled) return [];
		return this._outcomes.get(asSessionId(sessionId)) ?? [];
	}

	/**
	 * Get outcomes across all sessions.
	 *
	 * @returns Flat array of all outcomes (empty when disabled)
	 */
	getAllOutcomes(): VerificationOutcome[] {
		if (!this._enabled) return [];
		const all: VerificationOutcome[] = [];
		for (const outcomes of this._outcomes.values()) {
			all.push(...outcomes);
		}
		return all;
	}

	/**
	 * Clear outcomes for a specific session.
	 *
	 * @param sessionId - The session id to clear
	 */
	clearOutcomes(sessionId: string): void {
		this._outcomes.delete(asSessionId(sessionId));
	}

	clearAllOutcomes(): void {
		this._outcomes.clear();
	}
}
