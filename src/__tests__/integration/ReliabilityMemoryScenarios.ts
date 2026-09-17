import { expect } from 'vitest';
import { asBranchId, asSessionId } from '../../contracts/ids.js';
import { runWithContext } from '../../context/RequestContext.js';
import type { CallToolResult } from '../../core/ThoughtProcessor.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';

function payload(result: CallToolResult): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text ?? '{}');
}

function input(
	thought: string,
	number: number,
	sessionId: string
): {
	thought: string;
	thought_number: number;
	total_thoughts: number;
	next_thought_needed: boolean;
	session_id: string;
} {
	return {
		thought,
		thought_number: number,
		total_thoughts: 20,
		next_thought_needed: false,
		session_id: sessionId,
	};
}

export async function assertInvalidContinuationFlow(): Promise<void> {
	const server = await createServer({ autoDiscover: false, loadFromPersistence: false });
	try {
		const call = await runWithContext({ requestId: 'call', owner: 'alice' }, () =>
			server.processThought({
				...input('call tool', 1, 'A'),
				thought_type: 'tool_call',
				tool_name: 'sequentialthinking_tools',
				tool_arguments: {},
				next_thought_needed: true,
			})
		);
		const token = payload(call)['continuation_token'];
		if (typeof token !== 'string') throw new TypeError('Expected continuation token');
		const observe = (candidate: string, sessionId: string, owner: string) =>
			runWithContext({ requestId: `${owner}-${candidate}`, owner }, () =>
				server.processThought({
					...input('tool result', 2, sessionId),
					thought_type: 'tool_observation',
					continuation_token: candidate,
				})
			);

		expect(payload(await observe('malformed', 'A', 'alice'))).toMatchObject({
			code: 'SUSPENSION_NOT_FOUND',
		});
		expect(payload(await observe(token, 'B', 'alice'))).toMatchObject({
			code: 'SUSPENSION_NOT_FOUND',
		});
		expect(payload(await observe(token, 'A', 'mallory'))).toMatchObject({
			code: 'SESSION_ACCESS_DENIED',
		});
		expect(server.history.getHistory('A')).toHaveLength(1);
		expect((await observe(token, 'A', 'alice')).isError).toBeUndefined();
		expect(server.history.getHistory('A')).toHaveLength(2);
		expect(payload(await observe(token, 'A', 'alice'))).toMatchObject({
			code: 'SUSPENSION_NOT_FOUND',
		});
		expect(server.history.getHistory('A')).toHaveLength(2);
		expect(server.getContainer().resolve('suspensionStore').size()).toBe(0);
	} finally {
		await server.dispose();
	}
}

export async function assertEffectiveBoundedConfiguration(): Promise<void> {
	const config = new ServerConfig({
		maxHistorySize: 2,
		maxBranches: 2,
		maxBranchSize: 1,
		maxSessionsPerOwner: 2,
		features: {
			dagEdges: false,
			calibration: false,
			compression: false,
			outcomeRecording: false,
		},
	});
	const server = await createServer({ config, autoDiscover: false, loadFromPersistence: false });
	try {
		for (let number = 1; number <= 3; number += 1) {
			await server.processThought(input(`bounded ${number}`, number, 'bounded'));
		}
		for (let number = 1; number <= 3; number += 1) {
			await server.processThought({
				...input(`branch ${number}`, 10 + number, 'bounded'),
				branch_from_thought: number === 1 ? 3 : 9 + number,
				branch_id: `branch-${number}`,
			});
		}
		for (const sessionId of ['owner-1', 'owner-2', 'owner-3']) {
			await runWithContext({ requestId: sessionId, owner: 'owner' }, () =>
				server.processThought(input(sessionId, 1, sessionId))
			);
		}
		expect(server.config).toMatchObject({
			maxHistorySize: 2,
			maxBranches: 2,
			maxBranchSize: 1,
			maxSessionsPerOwner: 2,
		});
		expect(
			server.history.getHistory('bounded').map(({ thought_number }) => thought_number)
		).toEqual([12, 13]);
		expect(server.history.getBranchIds('bounded')).toEqual([
			asBranchId('branch-2'),
			asBranchId('branch-3'),
		]);
		expect(server.history.getBranch(asBranchId('branch-3'), 'bounded')).toHaveLength(1);
		expect(server.history.getSessionIds()).not.toContain(asSessionId('owner-1'));
		expect(server.getContainer().resolve('EdgeStore').size()).toBe(0);
		expect(server.getContainer().resolve('outcomeRecorder').getAllOutcomes()).toEqual([]);
	} finally {
		await server.dispose();
	}
}
