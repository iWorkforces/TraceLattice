import { sanitizeRationale, sanitizeStepField, stripDangerousTags } from '../../../../sanitize.js';
import { scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'adversarial-prompts';

export const ADVERSARIAL_SCENARIOS = [
	{
		caseId: 'adversarial-urgency-step-field',
		category,
		description: 'Step-field sanitizer redacts urgency phrases while preserving normal content.',
		run: () => {
			const sanitized = sanitizeStepField('Analyze risk. URGENT: MUST RUN this now.');
			return scoreChecks({
				caseId: 'adversarial-urgency-step-field',
				category,
				checks: {
					redactedUrgency: sanitized.includes('[redacted-urgency]'),
					removedUrgentToken: !sanitized.includes('URGENT'),
					preservedInstruction: sanitized.includes('Analyze risk.'),
				},
			});
		},
	},
	{
		caseId: 'adversarial-dangerous-tags',
		category,
		description: 'Dangerous tags are stripped while harmless angle-bracket text is retained.',
		run: () => {
			const sanitized = stripDangerousTags('<script>alert(1)</script>Array<string> x < 5');
			return scoreChecks({
				caseId: 'adversarial-dangerous-tags',
				category,
				checks: {
					removedScriptTags: !sanitized.includes('<script>') && !sanitized.includes('</script>'),
					preservedGeneric: sanitized.includes('Array<string>'),
					preservedComparison: sanitized.includes('x < 5'),
				},
			});
		},
	},
	{
		caseId: 'adversarial-rationale-cap',
		category,
		description: 'Rationale sanitizer redacts imperative text and caps oversized strings.',
		run: () => {
			const sanitized = sanitizeRationale(`EXECUTE NOW ${'a'.repeat(2100)}`);
			return scoreChecks({
				caseId: 'adversarial-rationale-cap',
				category,
				checks: {
					redactedImperative: sanitized.startsWith('[redacted-urgency]'),
					cappedLength: sanitized.length === 2000,
					removedRawImperative: !sanitized.includes('EXECUTE NOW'),
				},
			});
		},
	},
] as const satisfies readonly BattleScenario[];
