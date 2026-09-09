import { describe, expect, it } from 'vitest';

import {
	CATEGORY_GATES,
	evaluateBattleTest,
	evaluateGate,
	gateStatusForDrop,
	hasCriticalFailures,
	isApproved,
	isOverrideActive,
} from './gates.js';
import { CATEGORY_NAMES, CRITICAL_FAILURE_KINDS } from './types.js';

import type { ApprovedOverride, CaseScore, Category, CategoryResult } from './types.js';

const NOW = new Date('2026-06-26T12:00:00.000Z');

function createCaseScore(overrides: Partial<CaseScore> = {}): CaseScore {
	return {
		caseId: 'case-1',
		category: 'adversarial-prompts',
		score: 95,
		deterministic: true,
		...overrides,
	};
}

function createCategoryResult(overrides: Partial<CategoryResult> = {}): CategoryResult {
	return {
		category: 'adversarial-prompts',
		cases: [],
		baselineAverage: 100,
		currentAverage: 100,
		drop: 0,
		gate: CATEGORY_GATES['adversarial-prompts'],
		status: 'pass',
		criticalFailures: [],
		largestDrops: [],
		...overrides,
	};
}

function createOverride(overrides: Partial<ApprovedOverride> = {}): ApprovedOverride {
	return {
		category: 'adversarial-prompts',
		approvedAt: '2026-06-26T00:00:00.000Z',
		reason: 'Known upstream model shift under review.',
		owner: 'eval-owner',
		expiresAt: '2026-06-27T00:00:00.000Z',
		...overrides,
	};
}

describe('CATEGORY_GATES', () => {
	it('covers every category with standard and strict thresholds', () => {
		// Given
		const expectedCategories = [...CATEGORY_NAMES].sort();
		const actualCategories = Object.keys(CATEGORY_GATES).sort();
		const strictCategories: readonly Category[] = [
			'state-isolation-and-reset',
			'malformed-and-edge-inputs',
		];

		// When
		const standardCategories = CATEGORY_NAMES.filter(
			(category) => !strictCategories.includes(category)
		);

		// Then
		expect(actualCategories).toEqual(expectedCategories);
		expect(standardCategories.map((category) => CATEGORY_GATES[category])).toEqual(
			Array.from({ length: standardCategories.length }, () => 5)
		);
		expect(CATEGORY_GATES['state-isolation-and-reset']).toBe(0);
		expect(CATEGORY_GATES['malformed-and-edge-inputs']).toBe(0);
	});
});

describe('gateStatusForDrop', () => {
	it.each([
		{ drop: -1, threshold: 5, expected: 'pass' },
		{ drop: 0, threshold: 5, expected: 'pass' },
		{ drop: 0.01, threshold: 5, expected: 'record' },
		{ drop: 2, threshold: 5, expected: 'record' },
		{ drop: 2.01, threshold: 5, expected: 'review' },
		{ drop: 5, threshold: 5, expected: 'review' },
		{ drop: 5.01, threshold: 5, expected: 'blocked' },
	] as const)('returns $expected when drop is $drop and threshold is $threshold', (testCase) => {
		// Given / When
		const status = gateStatusForDrop(testCase.drop, testCase.threshold);

		// Then
		expect(status).toBe(testCase.expected);
	});

	it.each([
		{ drop: 0, expected: 'pass' },
		{ drop: 0.01, expected: 'blocked' },
	] as const)('uses zero as a strict threshold for drop $drop', (testCase) => {
		// Given / When
		const status = gateStatusForDrop(testCase.drop, 0);

		// Then
		expect(status).toBe(testCase.expected);
	});
});

describe('hasCriticalFailures', () => {
	it('deduplicates all critical failure kinds in first-seen order', () => {
		// Given
		const caseScores = [
			...CRITICAL_FAILURE_KINDS.map((criticalFailure, index) =>
				createCaseScore({
					caseId: `critical-${index}`,
					criticalFailure,
				})
			),
			createCaseScore({ caseId: 'duplicate', criticalFailure: 'cross-session-leakage' }),
		];

		// When
		const criticalFailures = hasCriticalFailures(caseScores);

		// Then
		expect(criticalFailures).toEqual(CRITICAL_FAILURE_KINDS);
	});
});

describe('override approval', () => {
	it('treats an override as active only before it expires', () => {
		// Given
		const activeOverride = createOverride();
		const expiredOverride = createOverride({ expiresAt: '2026-06-26T11:59:59.999Z' });

		// When / Then
		expect(isOverrideActive(activeOverride, NOW)).toBe(true);
		expect(isOverrideActive(expiredOverride, NOW)).toBe(false);
	});

	it('approves only a matching category with an active override', () => {
		// Given
		const overrides = [createOverride(), createOverride({ category: 'long-horizon-tasks' })];

		// When / Then
		expect(isApproved('adversarial-prompts', overrides, NOW)).toBe(true);
		expect(isApproved('state-isolation-and-reset', overrides, NOW)).toBe(false);
	});
});

describe('evaluateGate', () => {
	it('sets standard gate statuses and copies the category result', () => {
		// Given
		const result = createCategoryResult({ drop: 3 });

		// When
		const evaluated = evaluateGate(result, [], NOW);

		// Then
		expect(evaluated).not.toBe(result);
		expect(evaluated.status).toBe('review');
		expect(result.status).toBe('pass');
	});

	it('downgrades an overridden standard block to review but not pass', () => {
		// Given
		const result = createCategoryResult({ drop: 6 });

		// When
		const evaluated = evaluateGate(result, [createOverride()], NOW);

		// Then
		expect(evaluated.status).toBe('review');
	});

	it('keeps an expired override blocked', () => {
		// Given
		const result = createCategoryResult({ drop: 6 });
		const expiredOverride = createOverride({ expiresAt: '2026-06-26T11:59:59.999Z' });

		// When
		const evaluated = evaluateGate(result, [expiredOverride], NOW);

		// Then
		expect(evaluated.status).toBe('blocked');
	});

	it('blocks critical failures even when an override is active', () => {
		// Given
		const result = createCategoryResult({
			drop: 6,
			cases: [createCaseScore({ criticalFailure: 'tool-leaks-secrets' })],
		});

		// When
		const evaluated = evaluateGate(result, [createOverride()], NOW);

		// Then
		expect(evaluated.status).toBe('blocked');
		expect(evaluated.criticalFailures).toEqual(['tool-leaks-secrets']);
	});
});

describe('evaluateBattleTest', () => {
	it('passes when no evaluated category is blocked', () => {
		// Given
		const results = [
			createCategoryResult(),
			createCategoryResult({ category: 'long-horizon-tasks' }),
		];

		// When
		const reportGate = evaluateBattleTest(results, [], NOW);

		// Then
		expect(reportGate).toEqual({ overallStatus: 'pass', blockedCategories: [] });
	});

	it('reports blocked categories after applying overrides', () => {
		// Given
		const blockedResult = createCategoryResult({
			category: 'state-isolation-and-reset',
			drop: 0.01,
			gate: CATEGORY_GATES['state-isolation-and-reset'],
		});
		const overriddenResult = createCategoryResult({ drop: 6 });

		// When
		const reportGate = evaluateBattleTest(
			[blockedResult, overriddenResult],
			[createOverride()],
			NOW
		);

		// Then
		expect(reportGate).toEqual({
			overallStatus: 'blocked',
			blockedCategories: ['state-isolation-and-reset'],
		});
	});
});
