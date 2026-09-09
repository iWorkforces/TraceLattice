import { safeParse } from 'valibot';

import { SequentialThinkingSchema } from '../../../../schema.js';
import { fixedScore, scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'malformed-and-edge-inputs';

function scoreMalformedRejection(
	caseId: string,
	input: unknown
): ReturnType<BattleScenario['run']> {
	try {
		const result = safeParse(SequentialThinkingSchema, input);
		return scoreChecks({
			caseId,
			category,
			checks: {
				rejectedWithoutThrowing: !result.success,
			},
		});
	} catch (error) {
		if (error instanceof Error) {
			return fixedScore({
				caseId,
				category,
				score: 0,
				criticalFailure: 'malformed-input-crash',
				notes: [error.name],
			});
		}
		throw error;
	}
}

export const MALFORMED_INPUT_SCENARIOS = [
	{
		caseId: 'malformed-missing-thought',
		category,
		description: 'safeParse rejects missing thought without throwing malformed-input-crash.',
		run: () =>
			scoreMalformedRejection('malformed-missing-thought', {
				thought_number: 1,
				total_thoughts: 1,
			}),
	},
	{
		caseId: 'malformed-invalid-confidence',
		category,
		description:
			'safeParse rejects out-of-range confidence without throwing malformed-input-crash.',
		run: () =>
			scoreMalformedRejection('malformed-invalid-confidence', {
				thought: 'confidence is too high',
				thought_number: 1,
				total_thoughts: 1,
				confidence: 2,
			}),
	},
	{
		caseId: 'malformed-invalid-branch-id',
		category,
		description: 'safeParse rejects invalid branch IDs without throwing malformed-input-crash.',
		run: () =>
			scoreMalformedRejection('malformed-invalid-branch-id', {
				thought: 'branch id contains a space',
				thought_number: 1,
				total_thoughts: 1,
				branch_id: 'bad branch',
			}),
	},
] as const satisfies readonly BattleScenario[];
