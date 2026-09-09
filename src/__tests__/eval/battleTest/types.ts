export const CATEGORY_NAMES = [
	'adversarial-prompts',
	'long-horizon-tasks',
	'branching-revision-merge-backtrack',
	'hypothesis-and-verification',
	'tool-recommendation-quality',
	'skill-recommendation-quality',
	'state-isolation-and-reset',
	'malformed-and-edge-inputs',
	'reasoning-hints-and-confidence',
	'final-answer-consistency',
	'regression-anchors-and-calibration',
] as const;

export type Category = (typeof CATEGORY_NAMES)[number];

export const CRITICAL_FAILURE_KINDS = [
	'cross-session-leakage',
	'reset-state-not-clearing',
	'malformed-input-crash',
	'final-answer-contradicts-trace',
	'tool-leaks-secrets',
	'metadata-inconsistency',
] as const;

export type CriticalFailureKind = (typeof CRITICAL_FAILURE_KINDS)[number];

export type GateStatus = 'pass' | 'record' | 'review' | 'blocked';

export type CaseScore = {
	readonly caseId: string;
	readonly category: Category;
	readonly score: number;
	readonly deterministic: boolean;
	readonly dimensions?: Readonly<Record<string, number>>;
	readonly notes?: readonly string[];
	readonly criticalFailure?: CriticalFailureKind;
};

export type CaseDrop = {
	readonly caseId: string;
	readonly category: Category;
	readonly baselineScore: number;
	readonly currentScore: number;
	readonly drop: number;
};

export type CategoryResult = {
	readonly category: Category;
	readonly cases: readonly CaseScore[];
	readonly baselineAverage: number;
	readonly currentAverage: number;
	readonly drop: number;
	readonly gate: number;
	readonly status: GateStatus;
	readonly criticalFailures: readonly CriticalFailureKind[];
	readonly dominantFailedDimensions?: readonly string[];
	readonly largestDrops: readonly CaseDrop[];
	readonly notes?: readonly string[];
};

export type BaselineCaseScore = {
	readonly caseId: string;
	readonly category: Category;
	readonly score: number;
};

export type BaselineRecord = {
	readonly version: string;
	readonly approvedAt: string;
	readonly categoryAverages: Readonly<Record<Category, number>>;
	readonly caseScores?: readonly BaselineCaseScore[];
	readonly metadata?: {
		readonly commit?: string;
		readonly branch?: string;
		readonly approvedBy?: string;
		readonly notes?: readonly string[];
	};
};

export type ApprovedOverride = {
	readonly category: Category;
	readonly approvedAt: string;
	readonly reason: string;
	readonly owner: string;
	readonly expiresAt?: string;
	readonly caseIds?: readonly string[];
};

export type BattleTestReport = {
	readonly runId: string;
	readonly runTimestamp: string;
	readonly overallStatus: 'pass' | 'blocked';
	readonly baseline: BaselineRecord;
	readonly categories: readonly CategoryResult[];
	readonly criticalFailures: readonly CriticalFailureKind[];
	readonly largestDrops: readonly CaseDrop[];
	readonly blockedCategories: readonly Category[];
	readonly approvedOverrides: readonly ApprovedOverride[];
};
