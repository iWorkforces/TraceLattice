import { describe, expect, it } from 'vitest';

import {
	categoryAverage,
	computeCaseDrops,
	computeCategoryResult,
	computeDominantFailedDimensions,
	computeRegressionDrop,
} from './calculator.js';

import type { BaselineCaseScore, CaseScore } from './types.js';

describe('categoryAverage', () => {
	it('returns null when scores are empty', () => {
		// Given
		const scores: readonly number[] = [];

		// When
		const average = categoryAverage(scores);

		// Then
		expect(average).toBeNull();
	});

	it('returns the average for a large category', () => {
		// Given
		const scores: readonly number[] = Array.from({ length: 100 }, (_, index) => index + 1);

		// When
		const average = categoryAverage(scores);

		// Then
		expect(average).toBe(50.5);
	});
});

describe('computeRegressionDrop', () => {
	it('returns zero when baseline and current scores match', () => {
		// Given / When
		const drop = computeRegressionDrop(90, 90);

		// Then
		expect(drop).toBe(0);
	});

	it('returns a positive drop greater than five when current is much lower', () => {
		// Given / When
		const drop = computeRegressionDrop(95, 88.8);

		// Then
		expect(drop).toBe(6.2);
		expect(drop).toBeGreaterThan(5);
	});

	it('returns a positive drop up to five when current is slightly lower', () => {
		// Given / When
		const drop = computeRegressionDrop(95, 90.1);

		// Then
		expect(drop).toBe(4.9);
		expect(drop).toBeLessThanOrEqual(5);
	});

	it('returns a negative drop when current improves', () => {
		// Given / When
		const drop = computeRegressionDrop(87.4, 90);

		// Then
		expect(drop).toBe(-2.6);
	});

	it('rounds drops to one decimal place', () => {
		// Given / When
		const drop = computeRegressionDrop(91.24, 90);

		// Then
		expect(drop).toBe(1.2);
	});
});

describe('computeCaseDrops', () => {
	it('ignores baseline cases missing from current cases', () => {
		// Given
		const baselineCases: readonly BaselineCaseScore[] = [
			{ caseId: 'case-a', category: 'adversarial-prompts', score: 92 },
			{ caseId: 'case-missing', category: 'adversarial-prompts', score: 80 },
		];
		const currentCases: readonly CaseScore[] = [
			{ caseId: 'case-a', category: 'adversarial-prompts', score: 90, deterministic: true },
		];

		// When
		const drops = computeCaseDrops(baselineCases, currentCases);

		// Then
		expect(drops).toEqual([
			{
				caseId: 'case-a',
				category: 'adversarial-prompts',
				baselineScore: 92,
				currentScore: 90,
				drop: 2,
			},
		]);
	});

	it('sorts case drops by descending drop and then case id', () => {
		// Given
		const baselineCases: readonly BaselineCaseScore[] = [
			{ caseId: 'case-c', category: 'long-horizon-tasks', score: 90 },
			{ caseId: 'case-a', category: 'long-horizon-tasks', score: 90 },
			{ caseId: 'case-b', category: 'long-horizon-tasks', score: 90 },
		];
		const currentCases: readonly CaseScore[] = [
			{ caseId: 'case-c', category: 'long-horizon-tasks', score: 84, deterministic: true },
			{ caseId: 'case-a', category: 'long-horizon-tasks', score: 85, deterministic: true },
			{ caseId: 'case-b', category: 'long-horizon-tasks', score: 85, deterministic: true },
		];

		// When
		const drops = computeCaseDrops(baselineCases, currentCases);

		// Then
		expect(drops.map((drop) => drop.caseId)).toEqual(['case-c', 'case-a', 'case-b']);
		expect(drops.map((drop) => drop.drop)).toEqual([6, 5, 5]);
	});

	it('excludes unchanged and improved cases from case drops', () => {
		// Given
		const baselineCases: readonly BaselineCaseScore[] = [
			{ caseId: 'case-drop', category: 'hypothesis-and-verification', score: 90 },
			{ caseId: 'case-unchanged', category: 'hypothesis-and-verification', score: 80 },
			{ caseId: 'case-improved', category: 'hypothesis-and-verification', score: 70 },
		];
		const currentCases: readonly CaseScore[] = [
			{ caseId: 'case-drop', category: 'hypothesis-and-verification', score: 85, deterministic: true },
			{
				caseId: 'case-unchanged',
				category: 'hypothesis-and-verification',
				score: 80,
				deterministic: true,
			},
			{
				caseId: 'case-improved',
				category: 'hypothesis-and-verification',
				score: 72,
				deterministic: true,
			},
		];

		// When
		const drops = computeCaseDrops(baselineCases, currentCases);

		// Then
		expect(drops).toEqual([
			{
				caseId: 'case-drop',
				category: 'hypothesis-and-verification',
				baselineScore: 90,
				currentScore: 85,
				drop: 5,
			},
		]);
	});
});

describe('computeDominantFailedDimensions', () => {
	it('returns an empty list when cases are empty or have no dimensions', () => {
		// Given
		const cases: readonly CaseScore[] = [
			{ caseId: 'case-a', category: 'final-answer-consistency', score: 90, deterministic: true },
			{ caseId: 'case-b', category: 'final-answer-consistency', score: 88, deterministic: true },
		];

		// When / Then
		expect(computeDominantFailedDimensions([])).toEqual([]);
		expect(computeDominantFailedDimensions(cases)).toEqual([]);
	});

	it('includes only dimensions below 100 sorted by failure frequency and dimension name', () => {
		// Given
		const cases: readonly CaseScore[] = [
			{
				caseId: 'case-a',
				category: 'final-answer-consistency',
				score: 80,
				deterministic: true,
				dimensions: { accuracy: 0, latency: 50, safety: 100 },
			},
			{
				caseId: 'case-b',
				category: 'final-answer-consistency',
				score: 82,
				deterministic: true,
				dimensions: { accuracy: 80, completeness: 100 },
			},
			{
				caseId: 'case-c',
				category: 'final-answer-consistency',
				score: 84,
				deterministic: true,
				dimensions: { reasoning: 0 },
			},
		];

		// When
		const dimensions = computeDominantFailedDimensions(cases);

		// Then
		expect(dimensions).toEqual(['accuracy', 'latency', 'reasoning']);
	});
});

describe('computeCategoryResult', () => {
	it('collects critical failures and computes the initial pass result', () => {
		// Given
		const cases: readonly CaseScore[] = [
			{
				caseId: 'case-safe',
				category: 'state-isolation-and-reset',
				score: 94,
				deterministic: true,
				dimensions: { isolation: 100 },
			},
			{
				caseId: 'case-critical',
				category: 'state-isolation-and-reset',
				score: 74,
				deterministic: true,
				dimensions: { ownership: 50, reset: 0 },
				criticalFailure: 'reset-state-not-clearing',
			},
		];
		const baselineCases: readonly BaselineCaseScore[] = [
			{ caseId: 'case-safe', category: 'state-isolation-and-reset', score: 96 },
			{ caseId: 'case-critical', category: 'state-isolation-and-reset', score: 90 },
		];

		// When
		const result = computeCategoryResult({
			category: 'state-isolation-and-reset',
			cases,
			baselineAverage: 90,
			baselineCases,
			gate: 85,
			notes: ['baseline imported'],
		});

		// Then
		expect(result).toEqual({
			category: 'state-isolation-and-reset',
			cases,
			baselineAverage: 90,
			currentAverage: 84,
			drop: 6,
			gate: 85,
			status: 'pass',
			criticalFailures: ['reset-state-not-clearing'],
			dominantFailedDimensions: ['ownership', 'reset'],
			largestDrops: [
				{
					caseId: 'case-critical',
					category: 'state-isolation-and-reset',
					baselineScore: 90,
					currentScore: 74,
					drop: 16,
				},
				{
					caseId: 'case-safe',
					category: 'state-isolation-and-reset',
					baselineScore: 96,
					currentScore: 94,
					drop: 2,
				},
			],
			notes: ['baseline imported'],
		});
	});
});
