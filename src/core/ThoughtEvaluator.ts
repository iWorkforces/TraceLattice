/**
 * Quality signal computation for sequential thinking.
 *
 * Thin facade that composes the extracted evaluator submodules
 * ({@link SignalComputer}, {@link Aggregator}, {@link PatternDetector})
 * to preserve the original {@link ThoughtEvaluator} public API.
 *
 * @module core/ThoughtEvaluator
 */

import type {
	CalibrationMetrics,
	CalibrationResult,
	ICalibrator,
} from '../contracts/calibrator.js';
import { GLOBAL_SESSION_ID, type SessionId } from '../contracts/ids.js';
import type { ThoughtType } from '../contracts/reasoning-types.js';
import type { ConfidenceSignals, PatternSignal, ReasoningStats } from './reasoning.js';
import type { ThoughtData } from './thought.js';
import { Aggregator } from './evaluator/Aggregator.js';
import { PatternDetector } from './evaluator/PatternDetector.js';
import { SignalComputer } from './evaluator/SignalComputer.js';

/** Explicit thought and canonical session used for response calibration. */
export interface ConfidenceSignalContext {
	readonly currentThought: ThoughtData;
	readonly sessionId: SessionId;
}

/**
 * No-op calibrator used when calibration is disabled or no calibrator is injected.
 *
 * @remarks
 * Returns the raw confidence unchanged, exposes `enabled = false`, and reports
 * empty metrics. Keeps the {@link ThoughtEvaluator} constructor zero-arg compatible.
 */
class NoOpCalibrator implements ICalibrator {
	public readonly enabled = false;

	public calibrate(
		rawConfidence: number,
		_type: ThoughtType,
		_sessionId: SessionId
	): CalibrationResult {
		const raw = Math.min(1, Math.max(0, rawConfidence));
		return { raw, calibrated: raw, temperature: 1.0, priorWeight: 0 };
	}

	public metrics(_sessionId?: SessionId): CalibrationMetrics {
		return {
			brierScore: null,
			ece: null,
			sampleCount: 0,
			perTypeBrier: {
				regular: null,
				hypothesis: null,
				verification: null,
				critique: null,
				synthesis: null,
				meta: null,
				tool_call: null,
				tool_observation: null,
				assumption: null,
				decomposition: null,
				backtrack: null,
			},
		};
	}

	public refit(_sessionId?: SessionId): void {
		// no-op
	}

	public clearSession(_sessionId: SessionId): void {}

	public clearAll(): void {}
}

/**
 * Stateless service that computes quality signals and reasoning analytics
 * from thought history and branch data.
 *
 * @remarks
 * All methods are pure computations — no side effects, no I/O, no internal state.
 * Designed to be registered as transient in the DI container.
 *
 * @example
 * ```typescript
 * const evaluator = new ThoughtEvaluator();
 * const signals = evaluator.computeConfidenceSignals(history, branches);
 * const stats = evaluator.computeReasoningStats(history, branches);
 * const patterns = evaluator.computePatternSignals(history, branches);
 * ```
 */
export class ThoughtEvaluator {
	private readonly _signalComputer: SignalComputer;
	private readonly _aggregator: Aggregator;
	private readonly _patternDetector: PatternDetector;
	private readonly _calibrator: ICalibrator;

	constructor(calibrator?: ICalibrator) {
		this._signalComputer = new SignalComputer();
		this._aggregator = new Aggregator();
		this._patternDetector = new PatternDetector();
		this._calibrator = calibrator ?? new NoOpCalibrator();
	}

	/** Compute confidence signals from history context. Pure computation. */
	public computeConfidenceSignals(
		history: ThoughtData[],
		branches: Record<string, ThoughtData[]>,
		context?: ConfidenceSignalContext
	): ConfidenceSignals {
		const { history: h, branches: b } = filterRetracted(history, branches);
		const signals = this._signalComputer.computeConfidenceSignals(h, b);
		if (!this._calibrator.enabled) return signals;

		const thought = context?.currentThought ?? h[h.length - 1];
		if (thought?.confidence === undefined) return signals;
		const sessionId = context?.sessionId ?? thought.session_id ?? GLOBAL_SESSION_ID;

		const result = this._calibrator.calibrate(
			thought.confidence,
			thought.thought_type ?? 'regular',
			sessionId
		);
		return {
			...signals,
			calibrated_confidence: result.calibrated,
			calibration_metrics: this._calibrator.metrics(sessionId),
		};
	}

	/** Compute aggregated reasoning analytics. Pure computation. */
	public computeReasoningStats(
		history: ThoughtData[],
		branches: Record<string, ThoughtData[]>
	): ReasoningStats {
		const { history: h, branches: b } = filterRetracted(history, branches);
		return this._aggregator.computeReasoningStats(h, b);
	}

	/** Detect reasoning patterns (anti-patterns and positive signals). Pure computation. */
	public computePatternSignals(
		history: ThoughtData[],
		branches: Record<string, ThoughtData[]>
	): PatternSignal[] {
		const { history: h, branches: b } = filterRetracted(history, branches);
		return this._patternDetector.computePatternSignals(h, b);
	}
}

/**
 * Filters out logically retracted thoughts from history and branches.
 * Retracted thoughts remain in storage (event-sourcing) but are excluded
 * from quality signal calculations.
 */
function filterRetracted(
	history: ThoughtData[],
	branches: Record<string, ThoughtData[]>
): { history: ThoughtData[]; branches: Record<string, ThoughtData[]> } {
	const h = history.filter((t) => !t.retracted);
	const b: Record<string, ThoughtData[]> = {};
	for (const [id, list] of Object.entries(branches)) {
		b[id] = list.filter((t) => !t.retracted);
	}
	return { history: h, branches: b };
}
