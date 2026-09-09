import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as v from 'valibot';

import { CATEGORY_NAMES } from './types.js';

import type { ApprovedOverride, BaselineRecord } from './types.js';

const categorySchema = v.picklist(CATEGORY_NAMES);

const categoryAveragesSchema = v.object({
	'adversarial-prompts': v.number(),
	'long-horizon-tasks': v.number(),
	'branching-revision-merge-backtrack': v.number(),
	'hypothesis-and-verification': v.number(),
	'tool-recommendation-quality': v.number(),
	'skill-recommendation-quality': v.number(),
	'state-isolation-and-reset': v.number(),
	'malformed-and-edge-inputs': v.number(),
	'reasoning-hints-and-confidence': v.number(),
	'final-answer-consistency': v.number(),
	'regression-anchors-and-calibration': v.number(),
});

const baselineCaseScoreSchema = v.object({
	caseId: v.string(),
	category: categorySchema,
	score: v.number(),
});

const baselineRecordSchema = v.object({
	version: v.string(),
	approvedAt: v.string(),
	categoryAverages: categoryAveragesSchema,
	caseScores: v.optional(v.array(baselineCaseScoreSchema)),
	metadata: v.optional(
		v.object({
			commit: v.optional(v.string()),
			branch: v.optional(v.string()),
			approvedBy: v.optional(v.string()),
			notes: v.optional(v.array(v.string())),
		})
	),
});

const approvedOverrideSchema = v.object({
	category: categorySchema,
	approvedAt: v.string(),
	reason: v.string(),
	owner: v.string(),
	expiresAt: v.optional(v.string()),
	caseIds: v.optional(v.array(v.string())),
});

const approvedOverridesSchema = v.array(approvedOverrideSchema);

export class BaselineFileMissingError extends Error {
	override readonly name = 'BaselineFileMissingError';

	constructor(readonly path: string) {
		super(`baseline file is missing: ${path}`);
	}
}

export class BaselineFileReadError extends Error {
	override readonly name = 'BaselineFileReadError';

	constructor(
		readonly path: string,
		options: ErrorOptions
	) {
		super(`baseline file could not be read: ${path}`, options);
	}
}

export class OverridesFileReadError extends Error {
	override readonly name = 'OverridesFileReadError';

	constructor(
		readonly path: string,
		options: ErrorOptions
	) {
		super(`overrides file could not be read: ${path}`, options);
	}
}

export class MalformedBaselineError extends Error {
	override readonly name = 'MalformedBaselineError';

	constructor(
		readonly detail: string,
		readonly path: string | undefined,
		options?: ErrorOptions
	) {
		const location = path === undefined ? '' : ` at ${path}`;
		super(`baseline ${detail}${location}`, options);
	}
}

export class MalformedOverridesError extends Error {
	override readonly name = 'MalformedOverridesError';

	constructor(
		readonly detail: string,
		readonly path: string | undefined,
		options?: ErrorOptions
	) {
		const location = path === undefined ? '' : ` at ${path}`;
		super(`approved overrides ${detail}${location}`, options);
	}
}

export function parseBaselineRecord(input: unknown): BaselineRecord {
	try {
		return v.parse(baselineRecordSchema, input);
	} catch (error) {
		if (error instanceof v.ValiError) {
			throw new MalformedBaselineError('record is malformed', undefined, { cause: error });
		}
		throw error;
	}
}

export function parseApprovedOverrides(input: unknown): readonly ApprovedOverride[] {
	try {
		return v.parse(approvedOverridesSchema, input);
	} catch (error) {
		if (error instanceof v.ValiError) {
			throw new MalformedOverridesError('are malformed', undefined, { cause: error });
		}
		throw error;
	}
}

export function loadBaseline(path = defaultJsonPath('baseline.json')): BaselineRecord {
	if (!existsSync(path)) {
		throw new BaselineFileMissingError(path);
	}

	const input = readJsonFile(path, 'baseline');

	try {
		return v.parse(baselineRecordSchema, input);
	} catch (error) {
		if (error instanceof v.ValiError) {
			throw new MalformedBaselineError('record is malformed', path, { cause: error });
		}
		throw error;
	}
}

export function loadOverrides(
	path = defaultJsonPath('overrides.json')
): readonly ApprovedOverride[] {
	if (!existsSync(path)) {
		return [];
	}

	const input = readJsonFile(path, 'overrides');

	try {
		return v.parse(approvedOverridesSchema, input);
	} catch (error) {
		if (error instanceof v.ValiError) {
			throw new MalformedOverridesError('are malformed', path, { cause: error });
		}
		throw error;
	}
}

function defaultJsonPath(fileName: 'baseline.json' | 'overrides.json'): string {
	return fileURLToPath(new URL(fileName, import.meta.url));
}

function readJsonFile(path: string, kind: 'baseline' | 'overrides'): unknown {
	let content: string;
	try {
		content = readFileSync(path, 'utf8');
	} catch (error) {
		if (error instanceof Error) {
			throw kind === 'baseline'
				? new BaselineFileReadError(path, { cause: error })
				: new OverridesFileReadError(path, { cause: error });
		}
		throw error;
	}

	try {
		const parsed: unknown = JSON.parse(content);
		return parsed;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw kind === 'baseline'
				? new MalformedBaselineError('JSON is invalid', path, { cause: error })
				: new MalformedOverridesError('JSON is invalid', path, { cause: error });
		}
		throw error;
	}
}
