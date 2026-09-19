import { describe, it, expect } from 'vitest';
import type { ThoughtType } from '../contracts/reasoning-types.js';
import type { ConfidenceSignals, ReasoningStats } from '../core/reasoning.js';

describe('Reasoning Types', () => {
	describe('ThoughtType', () => {
		it('accepts all valid thought type values', () => {
			const validTypes: ThoughtType[] = [
				'regular',
				'hypothesis',
				'verification',
				'critique',
				'synthesis',
				'meta',
			];

			expect(validTypes).toHaveLength(6);

			// Each value satisfies ThoughtType at compile time
			const regular: ThoughtType = 'regular' satisfies ThoughtType;
			const hypothesis: ThoughtType = 'hypothesis' satisfies ThoughtType;
			const verification: ThoughtType = 'verification' satisfies ThoughtType;
			const critique: ThoughtType = 'critique' satisfies ThoughtType;
			const synthesis: ThoughtType = 'synthesis' satisfies ThoughtType;
			const meta: ThoughtType = 'meta' satisfies ThoughtType;

			expect(regular).toBe('regular');
			expect(hypothesis).toBe('hypothesis');
			expect(verification).toBe('verification');
			expect(critique).toBe('critique');
			expect(synthesis).toBe('synthesis');
			expect(meta).toBe('meta');
		});

		it('is assignable to string', () => {
			const thoughtType: ThoughtType = 'regular';
			const asString: string = thoughtType;
			expect(typeof asString).toBe('string');
		});
	});

	describe('ConfidenceSignals', () => {
		it('accepts a valid shape with all fields', () => {
			const signals: ConfidenceSignals = {
				reasoning_depth: 5,
				revision_count: 2,
				branch_count: 1,
				thought_type_distribution: {
					regular: 3,
					hypothesis: 1,
					verification: 1,
					critique: 0,
					synthesis: 0,
					meta: 0,
					tool_call: 0,
					tool_observation: 0,
					assumption: 0,
					decomposition: 0,
					backtrack: 0,				},
				has_hypothesis: true,
				has_verification: true,
				average_confidence: 0.85,
			};

			expect(signals.reasoning_depth).toBe(5);
			expect(signals.revision_count).toBe(2);
			expect(signals.branch_count).toBe(1);
			expect(signals.thought_type_distribution.regular).toBe(3);
			expect(signals.has_hypothesis).toBe(true);
			expect(signals.has_verification).toBe(true);
			expect(signals.average_confidence).toBe(0.85);
		});

		it('accepts null for average_confidence', () => {
			const signals: ConfidenceSignals = {
				reasoning_depth: 1,
				revision_count: 0,
				branch_count: 0,
				thought_type_distribution: {
					regular: 1,
					hypothesis: 0,
					verification: 0,
					critique: 0,
					synthesis: 0,
					meta: 0,
					tool_call: 0,
					tool_observation: 0,
					assumption: 0,
					decomposition: 0,
					backtrack: 0,				},
				has_hypothesis: false,
				has_verification: false,
				average_confidence: null,
			};

			expect(signals.average_confidence).toBeNull();
		});

		it('requires all thought types in distribution', () => {
			const distribution: Record<ThoughtType, number> = {
				regular: 0,
				hypothesis: 0,
				verification: 0,
				critique: 0,
				synthesis: 0,
				meta: 0,
				tool_call: 0,
				tool_observation: 0,
				assumption: 0,
				decomposition: 0,
				backtrack: 0,			};

			expect(Object.keys(distribution)).toHaveLength(11);
		});
	});

	describe('ReasoningStats', () => {
		it('accepts a valid shape with all fields', () => {
			const stats: ReasoningStats = {
				total_thoughts: 10,
				total_branches: 2,
				total_revisions: 1,
				total_merges: 0,
				chain_depth: 7,
				thought_type_counts: {
					regular: 5,
					hypothesis: 2,
					verification: 2,
					critique: 1,
					synthesis: 0,
					meta: 0,
					tool_call: 0,
					tool_observation: 0,
					assumption: 0,
					decomposition: 0,
					backtrack: 0,				},
				hypothesis_count: 2,
				verified_hypothesis_count: 1,
				unresolved_hypothesis_count: 1,
				average_quality_score: 0.75,
				average_confidence: 0.8,
			};

			expect(stats.total_thoughts).toBe(10);
			expect(stats.total_branches).toBe(2);
			expect(stats.total_revisions).toBe(1);
			expect(stats.total_merges).toBe(0);
			expect(stats.chain_depth).toBe(7);
			expect(stats.thought_type_counts.regular).toBe(5);
			expect(stats.hypothesis_count).toBe(2);
			expect(stats.verified_hypothesis_count).toBe(1);
			expect(stats.unresolved_hypothesis_count).toBe(1);
			expect(stats.average_quality_score).toBe(0.75);
			expect(stats.average_confidence).toBe(0.8);
		});

		it('accepts null for average_quality_score and average_confidence', () => {
			const stats: ReasoningStats = {
				total_thoughts: 1,
				total_branches: 0,
				total_revisions: 0,
				total_merges: 0,
				chain_depth: 1,
				thought_type_counts: {
					regular: 1,
					hypothesis: 0,
					verification: 0,
					critique: 0,
					synthesis: 0,
					meta: 0,
					tool_call: 0,
					tool_observation: 0,
					assumption: 0,
					decomposition: 0,
					backtrack: 0,				},
				hypothesis_count: 0,
				verified_hypothesis_count: 0,
				unresolved_hypothesis_count: 0,
				average_quality_score: null,
				average_confidence: null,
			};

			expect(stats.average_quality_score).toBeNull();
			expect(stats.average_confidence).toBeNull();
		});

		it('tracks hypothesis verification status', () => {
			const stats: ReasoningStats = {
				total_thoughts: 5,
				total_branches: 0,
				total_revisions: 0,
				total_merges: 0,
				chain_depth: 5,
				thought_type_counts: {
					regular: 2,
					hypothesis: 2,
					verification: 1,
					critique: 0,
					synthesis: 0,
					meta: 0,
					tool_call: 0,
					tool_observation: 0,
					assumption: 0,
					decomposition: 0,
					backtrack: 0,				},
				hypothesis_count: 2,
				verified_hypothesis_count: 1,
				unresolved_hypothesis_count: 1,
				average_quality_score: null,
				average_confidence: null,
			};

			expect(stats.hypothesis_count).toBe(
				stats.verified_hypothesis_count + stats.unresolved_hypothesis_count
			);
		});
	});
});
