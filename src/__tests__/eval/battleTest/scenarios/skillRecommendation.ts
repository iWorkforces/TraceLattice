import { createSkillRecommendation, createStepRecommendation } from '../../../helpers/factories.js';
import { scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'skill-recommendation-quality';

export const SKILL_RECOMMENDATION_SCENARIOS = [
	{
		caseId: 'skill-recommendation-specific-skill',
		category,
		description:
			'Skill recommendation scores specificity, confidence, rationale, and invocability.',
		run: () => {
			const recommendation = createSkillRecommendation({
				skill_name: 'programming',
				confidence: 0.96,
				rationale: 'TypeScript edits require strict type-safety and TDD discipline.',
				user_invocable: true,
			});
			return scoreChecks({
				caseId: 'skill-recommendation-specific-skill',
				category,
				checks: {
					specificName: recommendation.skill_name === 'programming',
					strongConfidence: recommendation.confidence === 0.96,
					rationaleNamesTypeScript: recommendation.rationale?.includes('TypeScript') === true,
					userInvocable: recommendation.user_invocable === true,
				},
			});
		},
	},
	{
		caseId: 'skill-recommendation-allowed-tools',
		category,
		description: 'Skill recommendation preserves allowed tool metadata for routing decisions.',
		run: () => {
			const recommendation = createSkillRecommendation({
				skill_name: 'review-work',
				confidence: 0.87,
				rationale: 'Post-implementation review should verify goals, quality, security, and QA.',
				allowed_tools: ['task', 'bash', 'lsp_diagnostics'],
			});
			return scoreChecks({
				caseId: 'skill-recommendation-allowed-tools',
				category,
				checks: {
					skillNamed: recommendation.skill_name === 'review-work',
					allowedToolsPresent: recommendation.allowed_tools?.includes('lsp_diagnostics') === true,
					rationaleSpecific: recommendation.rationale?.includes('security') === true,
				},
			});
		},
	},
	{
		caseId: 'skill-recommendation-step-integration',
		category,
		description: 'Step recommendation can carry skill and tool recommendations together.',
		run: () => {
			const step = createStepRecommendation({
				step_description: 'Review TypeScript scenario catalog changes.',
				recommended_skills: [
					createSkillRecommendation({ skill_name: 'programming', confidence: 0.9 }),
				],
				expected_outcome: 'Catalog changes are type-safe and verified.',
			});
			return scoreChecks({
				caseId: 'skill-recommendation-step-integration',
				category,
				checks: {
					skillAttached: step.recommended_skills?.[0]?.skill_name === 'programming',
					toolStillPresent: step.recommended_tools.length === 1,
					expectedOutcomeSpecific: step.expected_outcome.includes('type-safe'),
				},
			});
		},
	},
] as const satisfies readonly BattleScenario[];
