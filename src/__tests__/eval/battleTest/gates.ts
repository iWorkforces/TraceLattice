import type {
	ApprovedOverride,
	CaseScore,
	Category,
	CategoryResult,
	CriticalFailureKind,
	GateStatus,
} from './types.js';

export const CATEGORY_GATES: Readonly<Record<Category, number>> = {
	'adversarial-prompts': 5,
	'long-horizon-tasks': 5,
	'branching-revision-merge-backtrack': 5,
	'hypothesis-and-verification': 5,
	'tool-recommendation-quality': 5,
	'skill-recommendation-quality': 5,
	'state-isolation-and-reset': 0,
	'malformed-and-edge-inputs': 0,
	'reasoning-hints-and-confidence': 5,
	'final-answer-consistency': 5,
	'regression-anchors-and-calibration': 5,
};

export function gateStatusForDrop(drop: number, threshold: number): GateStatus {
	if (drop <= 0) {
		return 'pass';
	}

	if (threshold <= 0) {
		return 'blocked';
	}

	if (drop <= 2) {
		return 'record';
	}

	if (drop <= threshold) {
		return 'review';
	}

	return 'blocked';
}

export function hasCriticalFailures(
	caseScores: readonly CaseScore[]
): readonly CriticalFailureKind[] {
	const criticalFailures: CriticalFailureKind[] = [];

	for (const caseScore of caseScores) {
		const criticalFailure = caseScore.criticalFailure;

		if (criticalFailure !== undefined && !criticalFailures.includes(criticalFailure)) {
			criticalFailures.push(criticalFailure);
		}
	}

	return criticalFailures;
}

export function isOverrideActive(override: ApprovedOverride, now: Date): boolean {
	if (new Date(override.approvedAt) > now) {
		return false;
	}

	if (override.expiresAt === undefined) {
		return true;
	}

	return new Date(override.expiresAt) >= now;
}

export function isApproved(
	category: Category,
	overrides: readonly ApprovedOverride[],
	now: Date = new Date()
): boolean {
	return overrides.some(
		(override) => override.category === category && isOverrideActive(override, now)
	);
}

export function evaluateGate(
	result: CategoryResult,
	overrides: readonly ApprovedOverride[],
	now: Date = new Date()
): CategoryResult {
	const criticalFailures = mergedCriticalFailures(result);

	if (criticalFailures.length > 0) {
		return { ...result, status: 'blocked', criticalFailures };
	}

	const status = gateStatusForDrop(result.drop, result.gate);

	if (status === 'blocked' && isApproved(result.category, overrides, now)) {
		return { ...result, status: 'review', criticalFailures };
	}

	return { ...result, status, criticalFailures };
}

export function evaluateBattleTest(
	results: readonly CategoryResult[],
	overrides: readonly ApprovedOverride[],
	now: Date = new Date()
): { readonly overallStatus: 'pass' | 'blocked'; readonly blockedCategories: readonly Category[] } {
	const blockedCategories = results
		.map((result) => evaluateGate(result, overrides, now))
		.filter((result) => result.status === 'blocked')
		.map((result) => result.category);

	return {
		overallStatus: blockedCategories.length > 0 ? 'blocked' : 'pass',
		blockedCategories,
	};
}

function mergedCriticalFailures(result: CategoryResult): readonly CriticalFailureKind[] {
	const criticalFailures: CriticalFailureKind[] = [];

	for (const criticalFailure of [
		...result.criticalFailures,
		...hasCriticalFailures(result.cases),
	]) {
		if (!criticalFailures.includes(criticalFailure)) {
			criticalFailures.push(criticalFailure);
		}
	}

	return criticalFailures;
}
