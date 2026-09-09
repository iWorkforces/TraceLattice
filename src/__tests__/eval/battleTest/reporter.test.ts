import { describe, expect, it } from 'vitest';

import {
	formatBattleTestReport,
	formatCategoryReport,
	toJsonLine,
	toSummaryJsonLine,
} from './reporter.js';
import type { BattleTestReport, CategoryResult } from './types.js';

const toolRecommendationResult: CategoryResult = {
	category: 'tool-recommendation-quality',
	cases: [],
	baselineAverage: 89.2,
	currentAverage: 83.2,
	drop: 6.0,
	gate: 5.0,
	status: 'blocked',
	criticalFailures: [],
	dominantFailedDimensions: ['parameter specificity', 'tool ranking'],
	largestDrops: [
		{
			caseId: 'TOOL-07',
			category: 'tool-recommendation-quality',
			baselineScore: 93,
			currentScore: 76,
			drop: 17,
		},
		{
			caseId: 'TOOL-10',
			category: 'tool-recommendation-quality',
			baselineScore: 88,
			currentScore: 74,
			drop: 14,
		},
		{
			caseId: 'TOOL-03',
			category: 'tool-recommendation-quality',
			baselineScore: 90,
			currentScore: 80,
			drop: 10,
		},
	],
	notes: [
		'The version still selects roughly correct tool families, but parameter specificity regressed across several cases.',
		'Investigate recommendation generation and add targeted regression checks for suggested input quality.',
	],
};

const passingSkillResult: CategoryResult = {
	category: 'skill-recommendation-quality',
	cases: [],
	baselineAverage: 87.5,
	currentAverage: 86.8,
	drop: 0.7,
	gate: 5.0,
	status: 'pass',
	criticalFailures: ['metadata-inconsistency'],
	largestDrops: [],
	notes: ['No meaningful regression.', 'No action required.'],
};

const battleReport: BattleTestReport = {
	runId: 'run-001',
	runTimestamp: '2026-06-26T00:00:00.000Z',
	overallStatus: 'blocked',
	baseline: {
		version: '1.4.3',
		approvedAt: '2026-06-20T00:00:00.000Z',
		categoryAverages: {
			'adversarial-prompts': 90,
			'long-horizon-tasks': 90,
			'branching-revision-merge-backtrack': 90,
			'hypothesis-and-verification': 90,
			'tool-recommendation-quality': 89.2,
			'skill-recommendation-quality': 87.5,
			'state-isolation-and-reset': 90,
			'malformed-and-edge-inputs': 90,
			'reasoning-hints-and-confidence': 90,
			'final-answer-consistency': 90,
			'regression-anchors-and-calibration': 90,
		},
	},
	categories: [toolRecommendationResult, passingSkillResult],
	criticalFailures: ['metadata-inconsistency'],
	largestDrops: toolRecommendationResult.largestDrops,
	blockedCategories: ['tool-recommendation-quality'],
	approvedOverrides: [],
};

describe('formatCategoryReport', () => {
	it('matches the category regression drop report style when a category is blocked', () => {
		// Given: a blocked tool recommendation quality category matching the report fixture.

		// When: the category report is formatted.
		const report = formatCategoryReport(toolRecommendationResult);

		// Then: the important lines match the documented report output exactly.
		expect(report).toContain('Category: Tool recommendation quality');
		expect(report).toContain('Baseline average: 89.2');
		expect(report).toContain('Current average: 83.2');
		expect(report).toContain('Drop: 6.0');
		expect(report).toContain('Gate: 5.0');
		expect(report).toContain('Status: blocked');
		expect(report).toContain('- TOOL-07: 93 -> 76, drop 17');
		expect(report).toContain('- TOOL-10: 88 -> 74, drop 14');
		expect(report).toContain('- TOOL-03: 90 -> 80, drop 10');
		expect(report).toContain('Dominant failed dimensions:\n- parameter specificity\n- tool ranking');
		expect(report).toContain('Critical failures:\n- None');
		expect(report.indexOf('Largest case drops:')).toBeLessThan(
			report.indexOf('Dominant failed dimensions:')
		);
		expect(report.indexOf('Dominant failed dimensions:')).toBeLessThan(
			report.indexOf('Critical failures:')
		);
		expect(report).toContain(
			'Initial diagnosis:\nThe version still selects roughly correct tool families, but parameter specificity regressed across several cases.'
		);
		expect(report).toContain(
			'Required action:\nInvestigate recommendation generation and add targeted regression checks for suggested input quality.'
		);
	});

	it('formats empty drops and critical failures without calculating replacement values', () => {
		// Given: a category with no case drops and one critical failure supplied by the caller.

		// When: the category report is formatted.
		const report = formatCategoryReport(passingSkillResult);

		// Then: supplied values are rendered directly.
		expect(report).toContain('Largest case drops:\n- None');
		expect(report).toContain('Dominant failed dimensions:\n- None');
		expect(report).toContain('Critical failures:\n- metadata-inconsistency');
		expect(report).toContain('Drop: 0.7');
		expect(report).toContain('Status: pass');
	});
});

describe('formatBattleTestReport', () => {
	it('formats one section per category with an overall summary', () => {
		// Given: a battle-test report with two category results.

		// When: the full report is formatted.
		const report = formatBattleTestReport(battleReport);

		// Then: each category section and the summary are present.
		expect(report).toContain('Overall status: blocked');
		expect(report).toContain('Blocked categories: tool-recommendation-quality');
		expect(report).toContain('Category: Tool recommendation quality');
		expect(report).toContain('Category: Skill recommendation quality');
	});
});

describe('JSON line reporters', () => {
	it('serializes a category result as one parseable JSON line', () => {
		// Given: a blocked category result.

		// When: the JSON line is produced and parsed.
		const parsed = JSON.parse(toJsonLine(toolRecommendationResult));

		// Then: category status fields are available to line-oriented consumers.
		expect(parsed).toMatchObject({ category: 'tool-recommendation-quality', status: 'blocked' });
	});

	it('serializes a summary report as one parseable JSON line', () => {
		// Given: an overall blocked battle-test report.

		// When: the summary JSON line is produced and parsed.
		const parsed = JSON.parse(toSummaryJsonLine(battleReport));

		// Then: overall status fields are available to line-oriented consumers.
		expect(parsed).toMatchObject({
			overallStatus: 'blocked',
			blockedCategories: ['tool-recommendation-quality'],
		});
	});
});
