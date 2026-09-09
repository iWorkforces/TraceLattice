import type { assertNever } from '../../../utils.js';

import type { Category, CriticalFailureKind } from './types.js';

type ExpectTrue<T extends true> = T;

type ExhaustiveMatch<Actual, Handled> = [Actual] extends [Handled]
	? [Handled] extends [Actual]
		? true
		: false
	: false;

type CategorySwitchArms =
	| 'adversarial-prompts'
	| 'long-horizon-tasks'
	| 'branching-revision-merge-backtrack'
	| 'hypothesis-and-verification'
	| 'tool-recommendation-quality'
	| 'skill-recommendation-quality'
	| 'state-isolation-and-reset'
	| 'malformed-and-edge-inputs'
	| 'reasoning-hints-and-confidence'
	| 'final-answer-consistency'
	| 'regression-anchors-and-calibration';

type CriticalFailureSwitchArms =
	| 'cross-session-leakage'
	| 'reset-state-not-clearing'
	| 'malformed-input-crash'
	| 'final-answer-contradicts-trace'
	| 'tool-leaks-secrets'
	| 'metadata-inconsistency';

export type CategorySwitchIsExhaustive = ExpectTrue<ExhaustiveMatch<Category, CategorySwitchArms>>;

export type CriticalFailureSwitchIsExhaustive = ExpectTrue<
	ExhaustiveMatch<CriticalFailureKind, CriticalFailureSwitchArms>
>;

export declare const assertCategorySwitchDefault: typeof assertNever;

export declare const assertCriticalFailureSwitchDefault: typeof assertNever;
