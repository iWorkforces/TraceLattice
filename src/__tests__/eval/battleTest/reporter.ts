import type {
	BattleTestReport,
	CaseDrop,
	Category,
	CategoryResult,
	CriticalFailureKind,
} from './types.js';

export function formatCategoryReport(result: CategoryResult): string {
	const initialDiagnosis = result.notes?.[0] ?? 'None';
	const requiredAction = result.notes?.[1] ?? 'None';

	return [
		`Category: ${formatCategoryName(result.category)}`,
		`Baseline average: ${formatDecimal(result.baselineAverage)}`,
		`Current average: ${formatDecimal(result.currentAverage)}`,
		`Drop: ${formatDecimal(result.drop)}`,
		`Gate: ${formatDecimal(result.gate)}`,
		`Status: ${result.status}`,
		'',
		'Largest case drops:',
		...formatLargestDrops(result.largestDrops),
		'',
		'Dominant failed dimensions:',
		...formatDominantFailedDimensions(result.dominantFailedDimensions ?? []),
		'',
		'Critical failures:',
		...formatCriticalFailures(result.criticalFailures),
		'',
		'Initial diagnosis:',
		initialDiagnosis,
		'',
		'Required action:',
		requiredAction,
	].join('\n');
}

export function formatBattleTestReport(report: BattleTestReport): string {
	const summary = [
		`Overall status: ${report.overallStatus}`,
		`Run ID: ${report.runId}`,
		`Run timestamp: ${report.runTimestamp}`,
		`Blocked categories: ${formatList(report.blockedCategories)}`,
		`Critical failures: ${formatList(report.criticalFailures)}`,
	].join('\n');

	return [summary, ...report.categories.map(formatCategoryReport)].join('\n\n---\n\n');
}

export function toJsonLine(result: CategoryResult): string {
	return JSON.stringify(result);
}

export function toSummaryJsonLine(report: BattleTestReport): string {
	return JSON.stringify({
		runId: report.runId,
		runTimestamp: report.runTimestamp,
		overallStatus: report.overallStatus,
		blockedCategories: report.blockedCategories,
		criticalFailures: report.criticalFailures,
		largestDrops: report.largestDrops,
		approvedOverrides: report.approvedOverrides,
	});
}

function formatCategoryName(category: Category): string {
	const words = category.replaceAll('-', ' ');
	return `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}

function formatDecimal(value: number): string {
	return value.toFixed(1);
}

function formatLargestDrops(drops: readonly CaseDrop[]): readonly string[] {
	return drops.length === 0
		? ['- None']
		: drops.map(
				(drop) =>
					`- ${drop.caseId}: ${formatScore(drop.baselineScore)} -> ${formatScore(drop.currentScore)}, drop ${formatScore(drop.drop)}`
			);
}

function formatCriticalFailures(failures: readonly CriticalFailureKind[]): readonly string[] {
	return failures.length === 0 ? ['- None'] : failures.map((failure) => `- ${failure}`);
}

function formatDominantFailedDimensions(dimensions: readonly string[]): readonly string[] {
	return dimensions.length === 0 ? ['- None'] : dimensions.map((dimension) => `- ${dimension}`);
}

function formatList(values: readonly string[]): string {
	return values.length === 0 ? 'None' : values.join(', ');
}

function formatScore(value: number): string {
	return Number.isInteger(value) ? String(value) : formatDecimal(value);
}
