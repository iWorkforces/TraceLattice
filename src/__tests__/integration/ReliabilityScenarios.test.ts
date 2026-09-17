import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertInitializedTransportDrain,
	assertResetJoinsQueuedWrites,
	assertVisibleDrainFailure,
} from './ReliabilityLifecycleScenarios.js';
import {
	assertEffectiveBoundedConfiguration,
	assertInvalidContinuationFlow,
} from './ReliabilityMemoryScenarios.js';
import {
	assertFilePublicationInterruption,
	assertIsolationRestartReset,
	assertRetainedReferenceRestart,
	assertSqliteAbruptDrain,
} from './ReliabilityPersistenceScenarios.js';
import {
	cleanupReliabilityFixtures,
	createReliabilityRoot,
	runReliabilityFixture,
	spawnReliabilityFixture,
	withDeadline,
} from './ReliabilityScenarioHarness.js';
import {
	assertFiveCycleBoundedChurn,
	assertMalformedIdentityRejected,
} from './ReliabilityStateScenarios.js';

afterEach(async () => {
	vi.restoreAllMocks();
	await cleanupReliabilityFixtures();
});

describe('Task 17 cross-component reliability scenarios', () => {
	it('[file] preserves isolated A/B state through restart, scoped reset, and restart', async () => {
		await assertIsolationRestartReset('file');
	});

	it('[sqlite] preserves isolated A/B state through restart, scoped reset, and restart', async () => {
		await assertIsolationRestartReset('sqlite');
	});

	it('[memory] consumes an authorized continuation exactly once', async () => {
		await assertInvalidContinuationFlow();
	});

	it('[memory] applies non-default limits and feature flags to behavior', async () => {
		await assertEffectiveBoundedConfiguration();
	});

	it('[file] retains stable references through trim and restart', async () => {
		await assertRetainedReferenceRestart('file');
	});

	it('[sqlite] retains stable references through trim and restart', async () => {
		await assertRetainedReferenceRestart('sqlite');
	});

	it('[shared] rejects malformed identities before live or durable mutation', async () => {
		await assertMalformedIdentityRejected();
	});

	it('[file] drains accepted initialized transport work before shutdown', async () => {
		await assertInitializedTransportDrain('file');
	});

	it('[sqlite] drains accepted initialized transport work before shutdown', async () => {
		await assertInitializedTransportDrain('sqlite');
	});

	it('[file] preserves canonical snapshots across publication interruption', async () => {
		await assertFilePublicationInterruption();
	});

	it('[sqlite] preserves acknowledged persistence drain across abrupt termination', async () => {
		await assertSqliteAbruptDrain();
	});

	it('[fixture] fails the parent run after an unhandled rejection', async () => {
		await expect(runReliabilityFixture('unhandled-rejection')).rejects.toThrow(
			/unhandled-rejection.*exit code 1.*controlled unhandled rejection/
		);
	});

	it('[fixture] bounds abandoned-child cleanup and removes tracked roots', async () => {
		const root = await createReliabilityRoot('tracelattice-reliability-cleanup-');
		const fixture = spawnReliabilityFixture('cleanup-hold');
		expect(await fixture.nextEvent()).toEqual({ event: 'scenario-ready' });
		expect(await fixture.nextEvent()).toEqual({ event: 'cleanup-holding' });

		await withDeadline(cleanupReliabilityFixtures(), 5_000, 'parent reliability cleanup');

		expect(await fixture.exited).toEqual({ code: null, signal: 'SIGKILL' });
		await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('[shared] keeps storage drain failure visible and state uncleared', async () => {
		await assertVisibleDrainFailure();
	});

	it('[file] joins queued writes before scoped reset', async () => {
		await assertResetJoinsQueuedWrites('file');
	});

	it('[sqlite] joins queued writes before scoped reset', async () => {
		await assertResetJoinsQueuedWrites('sqlite');
	});

	it('[memory] bounds and clears five churn cycles', async () => {
		await assertFiveCycleBoundedChurn('memory');
	});

	it('[file] bounds and clears five churn cycles', async () => {
		await assertFiveCycleBoundedChurn('file');
	});

	it('[sqlite] bounds and clears five churn cycles', async () => {
		await assertFiveCycleBoundedChurn('sqlite');
	});
});
