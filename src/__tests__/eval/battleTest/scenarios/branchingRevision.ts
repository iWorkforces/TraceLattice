import { EdgeStore } from '../../../../core/graph/EdgeStore.js';
import { GraphView } from '../../../../core/graph/GraphView.js';
import { asThoughtId } from '../../../../contracts/ids.js';
import { CycleDetectedError } from '../../../../errors.js';
import { createTestSessionId } from '../../../helpers/factories.js';
import { battleEdge, scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'branching-revision-merge-backtrack';

export const BRANCHING_REVISION_SCENARIOS = [
	{
		caseId: 'branching-topological-merge-order',
		category,
		description: 'GraphView topological order keeps branch inputs before the merge node.',
		run: () => {
			const sessionId = createTestSessionId('branching-topological');
			const store = new EdgeStore();
			store.addEdge(
				battleEdge({
					id: 'e-branch-a',
					from: 'root',
					to: 'a',
					kind: 'branch',
					sessionId,
					createdAt: 1,
				})
			);
			store.addEdge(
				battleEdge({
					id: 'e-branch-b',
					from: 'root',
					to: 'b',
					kind: 'branch',
					sessionId,
					createdAt: 2,
				})
			);
			store.addEdge(
				battleEdge({
					id: 'e-merge-a',
					from: 'a',
					to: 'merge',
					kind: 'merge',
					sessionId,
					createdAt: 3,
				})
			);
			store.addEdge(
				battleEdge({
					id: 'e-merge-b',
					from: 'b',
					to: 'merge',
					kind: 'merge',
					sessionId,
					createdAt: 4,
				})
			);
			const order = new GraphView(store).topological(sessionId);
			return scoreChecks({
				caseId: 'branching-topological-merge-order',
				category,
				checks: {
					rootFirst: order[0] === 'root',
					mergeLast: order[order.length - 1] === 'merge',
					allNodesPresent: order.length === 4,
				},
			});
		},
	},
	{
		caseId: 'branching-branch-thoughts-only',
		category,
		description: 'GraphView branchThoughts follows only branch edges and ignores sequence edges.',
		run: () => {
			const sessionId = createTestSessionId('branching-branch-only');
			const root = asThoughtId('root');
			const branchChild = asThoughtId('branch-child');
			const sequenceChild = asThoughtId('sequence-child');
			const store = new EdgeStore();
			store.addEdge(
				battleEdge({
					id: 'e-branch-c',
					from: 'root',
					to: 'branch-child',
					kind: 'branch',
					sessionId,
					createdAt: 1,
				})
			);
			store.addEdge(
				battleEdge({
					id: 'e-seq-c',
					from: 'root',
					to: 'sequence-child',
					kind: 'sequence',
					sessionId,
					createdAt: 2,
				})
			);
			const branchIds = new GraphView(store).branchThoughts(sessionId, root);
			return scoreChecks({
				caseId: 'branching-branch-thoughts-only',
				category,
				checks: {
					includesRoot: branchIds.includes(root),
					includesBranchChild: branchIds.includes(branchChild),
					excludesSequenceChild: !branchIds.includes(sequenceChild),
				},
			});
		},
	},
	{
		caseId: 'branching-cycle-detected',
		category,
		description:
			'GraphView.topological catches only CycleDetectedError for invalid cyclic topology.',
		run: () => {
			const sessionId = createTestSessionId('branching-cycle');
			const store = new EdgeStore();
			store.addEdge(
				battleEdge({
					id: 'e-cycle-a',
					from: 'a',
					to: 'b',
					kind: 'sequence',
					sessionId,
					createdAt: 1,
				})
			);
			store.addEdge(
				battleEdge({
					id: 'e-cycle-b',
					from: 'b',
					to: 'a',
					kind: 'revises',
					sessionId,
					createdAt: 2,
				})
			);
			try {
				new GraphView(store).topological(sessionId);
				return scoreChecks({
					caseId: 'branching-cycle-detected',
					category,
					checks: { cycleDetected: false },
				});
			} catch (error) {
				if (error instanceof CycleDetectedError) {
					return scoreChecks({
						caseId: 'branching-cycle-detected',
						category,
						checks: { cycleDetected: true },
					});
				}
				throw error;
			}
		},
	},
] as const satisfies readonly BattleScenario[];
