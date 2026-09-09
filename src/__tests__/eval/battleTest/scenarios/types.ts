import type { CaseScore, Category } from '../types.js';

export interface BattleScenario {
	readonly caseId: string;
	readonly category: Category;
	readonly description: string;
	run(): CaseScore;
}

export function runScenarios(scenarios: readonly BattleScenario[]): readonly CaseScore[] {
	return scenarios.map((scenario) => scenario.run());
}
