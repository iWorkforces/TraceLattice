import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	BaselineFileMissingError,
	MalformedBaselineError,
	MalformedOverridesError,
	loadBaseline,
	loadOverrides,
	parseApprovedOverrides,
	parseBaselineRecord,
} from './baseline.js';
import type { ApprovedOverride, BaselineRecord } from './types.js';

const validCategoryAverages = {
	'adversarial-prompts': 0.9,
	'long-horizon-tasks': 0.9,
	'branching-revision-merge-backtrack': 0.9,
	'hypothesis-and-verification': 0.9,
	'tool-recommendation-quality': 0.9,
	'skill-recommendation-quality': 0.9,
	'state-isolation-and-reset': 0.9,
	'malformed-and-edge-inputs': 0.9,
	'reasoning-hints-and-confidence': 0.9,
	'final-answer-consistency': 0.9,
	'regression-anchors-and-calibration': 0.9,
} satisfies BaselineRecord['categoryAverages'];

function tempJsonPath(fileName: string): string {
	const directory = mkdtempSync(join(tmpdir(), 'tracelattice-baseline-'));
	return join(directory, fileName);
}

function writeJsonFixture(fileName: string, value: unknown): string {
	const path = tempJsonPath(fileName);
	writeFileSync(path, JSON.stringify(value), 'utf8');
	return path;
}

describe('parseBaselineRecord', () => {
	it('parses a valid baseline record when all category averages are present', () => {
		// Given
		const input = {
			version: '2026-06-26',
			approvedAt: '2026-06-26T00:00:00.000Z',
			categoryAverages: validCategoryAverages,
			caseScores: [
				{
					caseId: 'case-1',
					category: 'adversarial-prompts',
					score: 0.88,
				},
			],
			metadata: {
				commit: 'abc123',
				branch: 'develop',
				approvedBy: 'eval-owner',
				notes: ['seeded from accepted run'],
			},
		};

		// When
		const baseline = parseBaselineRecord(input);

		// Then
		expect(baseline.categoryAverages['regression-anchors-and-calibration']).toBe(0.9);
		expect(baseline.caseScores).toHaveLength(1);
	});

	it('throws a typed malformed baseline error when a category average is missing', () => {
		// Given
		const categoryAverages: Record<string, number> = Object.fromEntries(
			Object.entries(validCategoryAverages).filter(
				([category]) => category !== 'regression-anchors-and-calibration'
			)
		);
		const input = {
			version: '2026-06-26',
			approvedAt: '2026-06-26T00:00:00.000Z',
			categoryAverages,
		};

		// When
		const action = (): BaselineRecord => parseBaselineRecord(input);

		// Then
		expect(action).toThrow(MalformedBaselineError);
		expect(action).toThrow('baseline record is malformed');
	});
});

describe('loadBaseline', () => {
	it('loads a valid baseline file from a temp fixture path', () => {
		// Given
		const path = writeJsonFixture('baseline.json', {
			version: '2026-06-26',
			approvedAt: '2026-06-26T00:00:00.000Z',
			categoryAverages: validCategoryAverages,
		});

		// When
		const baseline = loadBaseline(path);

		// Then
		expect(baseline.version).toBe('2026-06-26');
	});

	it('throws a typed missing-file error when the baseline file is absent', () => {
		// Given
		const directory = mkdtempSync(join(tmpdir(), 'tracelattice-baseline-'));
		const path = join(directory, 'missing-baseline.json');

		// When
		const action = (): BaselineRecord => loadBaseline(path);

		// Then
		expect(action).toThrow(BaselineFileMissingError);
		expect(action).toThrow(path);
	});

	it('throws a typed malformed baseline error when JSON is invalid', () => {
		// Given
		const path = tempJsonPath('baseline.json');
		writeFileSync(path, '{', 'utf8');

		// When
		const action = (): BaselineRecord => loadBaseline(path);

		// Then
		expect(action).toThrow(MalformedBaselineError);
		expect(action).toThrow('baseline JSON is invalid');
	});
});

describe('parseApprovedOverrides', () => {
	it('parses approved overrides as data without evaluating expiration', () => {
		// Given
		const input = [
			{
				category: 'hypothesis-and-verification',
				approvedAt: '2026-06-26T00:00:00.000Z',
				reason: 'accepted deterministic scoring drift',
				owner: 'eval-owner',
				expiresAt: '2020-01-01T00:00:00.000Z',
				caseIds: ['case-7'],
			},
		];

		// When
		const overrides = parseApprovedOverrides(input);

		// Then
		expect(overrides).toEqual(input);
	});
});

describe('loadOverrides', () => {
	it('loads valid override files from a temp fixture path', () => {
		// Given
		const path = writeJsonFixture('overrides.json', [
			{
				category: 'skill-recommendation-quality',
				approvedAt: '2026-06-26T00:00:00.000Z',
				reason: 'manual approval',
				owner: 'eval-owner',
			},
		]);

		// When
		const overrides = loadOverrides(path);

		// Then
		expect(overrides).toHaveLength(1);
		expect(overrides[0]?.category).toBe('skill-recommendation-quality');
	});

	it('returns an empty list when the overrides file is absent', () => {
		// Given
		const directory = mkdtempSync(join(tmpdir(), 'tracelattice-baseline-'));
		const path = join(directory, 'missing-overrides.json');

		// When
		const overrides = loadOverrides(path);

		// Then
		expect(overrides).toEqual([]);
	});

	it('throws a typed malformed overrides error when override data is malformed', () => {
		// Given
		const input = [{ category: 'not-a-category', approvedAt: '2026-06-26T00:00:00.000Z' }];

		// When
		const action = (): readonly ApprovedOverride[] => parseApprovedOverrides(input);

		// Then
		expect(action).toThrow(MalformedOverridesError);
		expect(action).toThrow('approved overrides are malformed');
	});
});
