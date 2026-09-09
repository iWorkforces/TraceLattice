import type {
	BaselineCaseScore,
	CaseDrop,
	CaseScore,
	Category,
	CategoryResult,
	CriticalFailureKind,
} from './types.js';

export type CategoryResultInput = {
	readonly category: Category;
	readonly cases: readonly CaseScore[];
	readonly baselineAverage: number;
	readonly baselineCases?: readonly BaselineCaseScore[];
	readonly gate: number;
	readonly notes?: readonly string[];
};

export function categoryAverage(scores: readonly number[]): number | null {
	if (scores.length === 0) {
		return null;
	}

	return scores.reduce((total, score) => total + score, 0) / scores.length;
}

export function computeRegressionDrop(baseline: number, current: number): number {
	return roundToTenths(baseline - current);
}

export function computeCaseDrops(
	baselineCases: readonly BaselineCaseScore[],
	currentCases: readonly CaseScore[]
): readonly CaseDrop[] {
	const currentByCaseId = new Map(
		currentCases.map((currentCase) => [currentCase.caseId, currentCase])
	);
	const drops: CaseDrop[] = [];

	for (const baselineCase of baselineCases) {
		const currentCase = currentByCaseId.get(baselineCase.caseId);

		if (currentCase === undefined) {
			continue;
		}

		const drop = computeRegressionDrop(baselineCase.score, currentCase.score);

		if (drop <= 0) {
			continue;
		}

		drops.push({
			caseId: baselineCase.caseId,
			category: currentCase.category,
			baselineScore: baselineCase.score,
			currentScore: currentCase.score,
			drop,
		});
	}

	return drops.toSorted(
		(left, right) => right.drop - left.drop || left.caseId.localeCompare(right.caseId)
	);
}

export function computeDominantFailedDimensions(cases: readonly CaseScore[]): readonly string[] {
	const failureCounts = new Map<string, number>();

	for (const categoryCase of cases) {
		if (categoryCase.dimensions === undefined) {
			continue;
		}

		for (const [dimension, score] of Object.entries(categoryCase.dimensions)) {
			if (score >= 100) {
				continue;
			}

			failureCounts.set(dimension, (failureCounts.get(dimension) ?? 0) + 1);
		}
	}

	return Array.from(failureCounts.entries())
		.toSorted(
			([leftDimension, leftCount], [rightDimension, rightCount]) =>
				rightCount - leftCount || leftDimension.localeCompare(rightDimension)
		)
		.map(([dimension]) => dimension);
}

export function computeCategoryResult(input: CategoryResultInput): CategoryResult {
	const currentAverage =
		categoryAverage(input.cases.map((categoryCase) => categoryCase.score)) ?? 0;
	const dominantFailedDimensions = computeDominantFailedDimensions(input.cases);
	const result = {
		category: input.category,
		cases: input.cases,
		baselineAverage: input.baselineAverage,
		currentAverage,
		drop: computeRegressionDrop(input.baselineAverage, currentAverage),
		gate: input.gate,
		status: 'pass',
		criticalFailures: collectCriticalFailures(input.cases),
		...(dominantFailedDimensions.length === 0 ? {} : { dominantFailedDimensions }),
		largestDrops: computeCaseDrops(input.baselineCases ?? [], input.cases),
		...(input.notes === undefined ? {} : { notes: input.notes }),
	} satisfies CategoryResult;

	return result;
}

function roundToTenths(value: number): number {
	return Math.round(value * 10) / 10;
}

function collectCriticalFailures(cases: readonly CaseScore[]): readonly CriticalFailureKind[] {
	return cases.flatMap((categoryCase) =>
		categoryCase.criticalFailure === undefined ? [] : [categoryCase.criticalFailure]
	);
}
