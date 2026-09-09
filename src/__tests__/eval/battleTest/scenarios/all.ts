import { ADVERSARIAL_SCENARIOS } from './adversarial.js';
import { BRANCHING_REVISION_SCENARIOS } from './branchingRevision.js';
import { FINAL_ANSWER_CONSISTENCY_SCENARIOS } from './finalAnswerConsistency.js';
import { HYPOTHESIS_VERIFICATION_SCENARIOS } from './hypothesisVerification.js';
import { LONG_HORIZON_SCENARIOS } from './longHorizon.js';
import { MALFORMED_INPUT_SCENARIOS } from './malformedInput.js';
import { REASONING_HINTS_SCENARIOS } from './reasoningHints.js';
import { REGRESSION_ANCHOR_SCENARIOS } from './regressionAnchors.js';
import { SKILL_RECOMMENDATION_SCENARIOS } from './skillRecommendation.js';
import { STATE_ISOLATION_SCENARIOS } from './stateIsolation.js';
import { TOOL_RECOMMENDATION_SCENARIOS } from './toolRecommendation.js';
import type { BattleScenario } from './types.js';

export const BATTLE_SCENARIOS = [
	...ADVERSARIAL_SCENARIOS,
	...LONG_HORIZON_SCENARIOS,
	...BRANCHING_REVISION_SCENARIOS,
	...HYPOTHESIS_VERIFICATION_SCENARIOS,
	...TOOL_RECOMMENDATION_SCENARIOS,
	...SKILL_RECOMMENDATION_SCENARIOS,
	...STATE_ISOLATION_SCENARIOS,
	...MALFORMED_INPUT_SCENARIOS,
	...REASONING_HINTS_SCENARIOS,
	...FINAL_ANSWER_CONSISTENCY_SCENARIOS,
	...REGRESSION_ANCHOR_SCENARIOS,
] as const satisfies readonly BattleScenario[];
