import type { Edge } from '../../../../core/graph/Edge.js';
import type { EdgeKind } from '../../../../core/graph/Edge.js';
import type { SessionId } from '../../../../contracts/ids.js';
import { asEdgeId, asThoughtId } from '../../../../contracts/ids.js';
import type { CaseScore, Category, CriticalFailureKind } from '../types.js';

export type ScoreChecksInput = {
	readonly caseId: string;
	readonly category: Category;
	readonly checks: Readonly<Record<string, boolean>>;
	readonly notes?: readonly string[];
	readonly criticalFailure?: CriticalFailureKind;
};

export type FixedScoreInput = {
	readonly caseId: string;
	readonly category: Category;
	readonly score: number;
	readonly dimensions?: Readonly<Record<string, number>>;
	readonly notes?: readonly string[];
	readonly criticalFailure?: CriticalFailureKind;
};

export type BattleEdgeInput = {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly kind: EdgeKind;
	readonly sessionId: SessionId;
	readonly createdAt: number;
};

export function scoreChecks(input: ScoreChecksInput): CaseScore {
	const dimensions: Record<string, number> = {};
	for (const [name, passed] of Object.entries(input.checks)) {
		dimensions[name] = passed ? 100 : 0;
	}
	const values = Object.values(dimensions);
	const score =
		values.length === 0
			? 100
			: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
	return fixedScore({
		caseId: input.caseId,
		category: input.category,
		score,
		dimensions,
		...(input.notes === undefined ? {} : { notes: input.notes }),
		...(score === 100 || input.criticalFailure === undefined
			? {}
			: { criticalFailure: input.criticalFailure }),
	});
}

export function fixedScore(input: FixedScoreInput): CaseScore {
	return {
		caseId: input.caseId,
		category: input.category,
		score: input.score,
		deterministic: true,
		...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
		...(input.notes === undefined ? {} : { notes: input.notes }),
		...(input.criticalFailure === undefined ? {} : { criticalFailure: input.criticalFailure }),
	};
}

export function battleEdge(input: BattleEdgeInput): Edge {
	return {
		id: asEdgeId(input.id),
		from: asThoughtId(input.from),
		to: asThoughtId(input.to),
		kind: input.kind,
		sessionId: input.sessionId,
		createdAt: input.createdAt,
	};
}
