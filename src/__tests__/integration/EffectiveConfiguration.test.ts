import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigFileOptions } from '../../config/ConfigLoader.js';
import { ConfigLoader } from '../../config/ConfigLoader.js';
import { asSessionId } from '../../contracts/ids.js';
import { TreeOfThoughtStrategy } from '../../core/reasoning/strategies/TreeOfThoughtStrategy.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { ConfigurationError } from '../../errors.js';
import {
	createServer,
	initializeServer,
	type ToolAwareSequentialThinkingServer,
} from '../../lib.js';
import { SkillRegistry } from '../../registry/SkillRegistry.js';

const SuspendedResponseSchema = v.object({
	status: v.literal('suspended'),
	continuation_token: v.string(),
	expires_at: v.number(),
});

const temporaryDirectories = new Set<string>();
const liveServers = new Set<ToolAwareSequentialThinkingServer>();
const ENVIRONMENT_KEYS = [
	'TRACELATTICE_FEATURES_DAG_EDGES',
	'TRACELATTICE_FEATURES_REASONING_STRATEGY',
	'TRACELATTICE_FEATURES_CALIBRATION',
	'TRACELATTICE_FEATURES_COMPRESSION',
	'TRACELATTICE_FEATURES_TOOL_INTERLEAVE',
	'TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES',
	'TRACELATTICE_FEATURES_OUTCOME_RECORDING',
	'TRACELATTICE_TOOL_INTERLEAVE_TTL_MS',
	'TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS',
] as const;
const originalEnvironment = new Map<string, string | undefined>();

async function writeConfig(contents: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'tracelattice-effective-config-'));
	temporaryDirectories.add(directory);
	const configPath = join(directory, 'config.json');
	await writeFile(configPath, contents, 'utf8');
	return configPath;
}

function loadConfig(configPath: string): ConfigFileOptions {
	const loaded = new ConfigLoader(configPath).load();
	if (loaded === null) {
		throw new TypeError('ConfigLoader returned null for an existing configuration file');
	}
	return loaded;
}

async function dispose(server: ToolAwareSequentialThinkingServer): Promise<void> {
	await server.dispose();
	liveServers.delete(server);
}

beforeEach(() => {
	originalEnvironment.clear();
	for (const key of ENVIRONMENT_KEYS) {
		originalEnvironment.set(key, process.env[key]);
	}
});

afterEach(async () => {
	for (const server of liveServers) {
		await server.dispose();
	}
	liveServers.clear();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const [key, value] of originalEnvironment) {
		expect(process.env[key]).toBe(value);
	}
	for (const directory of temporaryDirectories) {
		await rm(directory, { recursive: true, force: true });
	}
	temporaryDirectories.clear();
});

describe('effective runtime configuration', () => {
	it('applies false feature overrides and the selected strategy to running services', async () => {
		const rawFileConfig: ConfigFileOptions = {
			features: {
				dagEdges: true,
				reasoningStrategy: 'sequential',
				calibration: true,
				compression: true,
				toolInterleave: true,
				newThoughtTypes: true,
				outcomeRecording: true,
			},
		};
		vi.stubEnv('TRACELATTICE_FEATURES_DAG_EDGES', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_REASONING_STRATEGY', 'tot');
		vi.stubEnv('TRACELATTICE_FEATURES_CALIBRATION', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_COMPRESSION', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_TOOL_INTERLEAVE', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_OUTCOME_RECORDING', 'false');

		const server = await createServer({
			fileConfig: rawFileConfig,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);
		await server.processThought({
			thought: 'first accepted thought',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: 'effective-flags',
		});
		await server.processThought({
			thought: 'second accepted thought',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: 'effective-flags',
		});

		expect(server.config.features).toEqual({
			dagEdges: false,
			reasoningStrategy: 'tot',
			calibration: false,
			compression: false,
			toolInterleave: false,
			newThoughtTypes: false,
			outcomeRecording: false,
		});
		expect(server.getContainer().resolve('reasoningStrategy')).toBeInstanceOf(
			TreeOfThoughtStrategy
		);
		expect(server.getContainer().has('suspensionStore')).toBe(false);
		expect(server.getContainer().resolve('EdgeStore').size(asSessionId('effective-flags'))).toBe(0);
	});

	it('uses configured suspension TTL and sweep intervals in the running store', async () => {
		vi.useFakeTimers({ now: new Date('2026-09-09T00:00:00.000Z') });
		const rawFileConfig: ConfigFileOptions = {
			features: { toolInterleave: true },
			toolInterleaveTtlMs: 9000,
			toolInterleaveSweepMs: 8000,
		};
		vi.stubEnv('TRACELATTICE_TOOL_INTERLEAVE_TTL_MS', '1234');
		vi.stubEnv('TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS', '2468');
		const server = await createServer({
			fileConfig: rawFileConfig,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);
		const startedAt = Date.now();

		const result = await server.processThought({
			thought: 'suspend for configured expiry',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: 'effective-ttl',
			thought_type: 'tool_call',
			tool_name: 'sequentialthinking_tools',
			tool_arguments: {},
		});
		const response = v.parse(SuspendedResponseSchema, JSON.parse(result.content[0]?.text ?? '{}'));
		const store = server.getContainer().resolve('suspensionStore');

		expect(server.config.toolInterleaveTtlMs).toBe(1234);
		expect(server.config.toolInterleaveSweepMs).toBe(2468);
		expect(response.expires_at - startedAt).toBe(1234);
		vi.advanceTimersByTime(1234);
		expect(store.size('effective-ttl')).toBe(1);
		vi.advanceTimersByTime(1234);
		expect(store.size('effective-ttl')).toBe(0);
	});

	it.each([
		['invalid reasoning strategy', JSON.stringify({ features: { reasoningStrategy: 'bogus' } })],
		['invalid suspension TTL', JSON.stringify({ toolInterleaveTtlMs: 0 })],
	])('rejects %s before starting runtime timers', async (_caseName, contents) => {
		vi.useFakeTimers();
		const loaded = loadConfig(await writeConfig(contents));

		await expect(
			createServer({ fileConfig: loaded, autoDiscover: false, loadFromPersistence: false })
		).rejects.toBeInstanceOf(ConfigurationError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('tears down runtime timers when initialization fails', async () => {
		vi.useFakeTimers();
		const stopSpy = vi.spyOn(InMemorySuspensionStore.prototype, 'stop');
		vi.spyOn(SkillRegistry.prototype, 'discoverAsync').mockRejectedValue(
			new Error('injected discovery failure')
		);

		await expect(createServer({ autoDiscover: true, loadFromPersistence: false })).rejects.toThrow(
			'injected discovery failure'
		);
		expect(stopSpy).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('releases timers across repeated create and dispose cycles', async () => {
		vi.useFakeTimers();

		for (let cycle = 0; cycle < 3; cycle += 1) {
			const server = await createServer({ autoDiscover: false, loadFromPersistence: false });
			liveServers.add(server);
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			await dispose(server);
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it('uses one loaded configuration snapshot during initialization', async () => {
		const loadSpy = vi
			.spyOn(ConfigLoader.prototype, 'load')
			.mockReturnValueOnce({ maxHistorySize: 321 })
			.mockReturnValueOnce({ maxHistorySize: 654 });

		const server = await initializeServer();
		liveServers.add(server);

		expect(loadSpy).toHaveBeenCalledOnce();
		expect(server.config.maxHistorySize).toBe(321);
	});

	it('applies environment overrides exactly once during initialization', async () => {
		const overlaySpy = vi.spyOn(ConfigLoader.prototype, 'applyEnvironmentOverrides');
		const loadSpy = vi.spyOn(ConfigLoader.prototype, 'load').mockImplementation(function (
			this: ConfigLoader
		) {
			return this.applyEnvironmentOverrides({ maxHistorySize: 321 });
		});

		const server = await initializeServer();
		liveServers.add(server);

		expect(loadSpy).toHaveBeenCalledOnce();
		expect(overlaySpy).toHaveBeenCalledOnce();
		expect(server.config.maxHistorySize).toBe(321);
	});
});
