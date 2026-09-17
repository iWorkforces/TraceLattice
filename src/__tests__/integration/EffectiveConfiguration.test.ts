import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { SEQUENTIAL_THINKING_TOOL } from '../../schema.js';
import { ServerConfig } from '../../ServerConfig.js';

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
	'MAX_HISTORY_SIZE',
	'MAX_BRANCHES',
	'MAX_BRANCH_SIZE',
	'SKILL_DIRS',
	'TOOL_DIRS',
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

function skillDocument(name: string, description: string): string {
	return ['---', `name: ${name}`, `description: ${description}`, '---', '# Body'].join('\n');
}

function toolDocument(name: string, description: string): string {
	return [
		'---',
		`name: ${name}`,
		`description: ${description}`,
		'inputSchema:',
		'  type: object',
		'---',
		'# Body',
	].join('\n');
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
		const expired = await server.processThought({
			thought: 'result at exact expiry',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: 'effective-ttl',
			thought_type: 'tool_observation',
			continuation_token: response.continuation_token,
		});

		expect(JSON.parse(expired.content[0]?.text ?? '{}')).toMatchObject({
			code: 'SUSPENSION_EXPIRED',
			status: 'failed',
		});
		expect(server.history.getHistory('effective-ttl')).toHaveLength(1);
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

	it('initializes both registries from one configured temporary root snapshot', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-initialize-roots-'));
		temporaryDirectories.add(root);
		const skillDir = join(root, 'skills');
		const toolDir = join(root, 'tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(
				join(skillDir, 'initialized.md'),
				skillDocument('initialized-skill', 'ready'),
				'utf8'
			),
			writeFile(
				join(toolDir, 'initialized.tool.md'),
				toolDocument('initialized-tool', 'ready'),
				'utf8'
			),
		]);
		const loadSpy = vi.spyOn(ConfigLoader.prototype, 'load').mockReturnValue({
			skillDirs: [skillDir],
			toolDirs: [toolDir],
			features: { toolInterleave: false },
		});

		const server = await initializeServer();
		liveServers.add(server);

		expect(loadSpy).toHaveBeenCalledOnce();
		expect(server.skills.hasSkill('initialized-skill')).toBe(true);
		expect(server.tools.hasTool('initialized-tool')).toBe(true);
	});

	it('discovers tools and skills from the same ordered configured roots at startup', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-root-order-'));
		temporaryDirectories.add(root);
		const firstSkills = join(root, 'first-skills');
		const secondSkills = join(root, 'second-skills');
		const firstTools = join(root, 'first-tools');
		const secondTools = join(root, 'second-tools');
		await Promise.all(
			[firstSkills, secondSkills, firstTools, secondTools].map((directory) =>
				mkdir(directory, { recursive: true })
			)
		);
		await Promise.all([
			writeFile(join(firstSkills, 'shared.md'), skillDocument('shared-skill', 'first'), 'utf8'),
			writeFile(join(secondSkills, 'shared.md'), skillDocument('shared-skill', 'second'), 'utf8'),
			writeFile(join(firstTools, 'shared.tool.md'), toolDocument('shared-tool', 'first'), 'utf8'),
			writeFile(join(secondTools, 'shared.tool.md'), toolDocument('shared-tool', 'second'), 'utf8'),
			writeFile(
				join(firstTools, 'builtin.tool.md'),
				toolDocument('sequentialthinking_tools', 'filesystem shadow'),
				'utf8'
			),
		]);
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [firstSkills, secondSkills],
				toolDirs: [firstTools, secondTools],
				features: { toolInterleave: false },
			}),
			autoDiscover: true,
			loadFromPersistence: false,
		});
		liveServers.add(server);

		expect(server.skills.getSkill('shared-skill')?.description).toBe('first');
		expect(server.tools.getTool('shared-tool')?.description).toBe('first');
		expect(server.tools.getTool('sequentialthinking_tools')).toBe(SEQUENTIAL_THINKING_TOOL);
	});

	it('applies environment discovery roots and legacy limits over file and default values', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-root-precedence-'));
		temporaryDirectories.add(root);
		const fileSkillDir = join(root, 'file-skills');
		const fileToolDir = join(root, 'file-tools');
		const environmentSkillDir = join(root, 'environment-skills');
		const environmentToolDir = join(root, 'environment-tools');
		const defaultSkillDir = join(root, '.claude', 'skills');
		const defaultToolDir = join(root, '.claude', 'tools');
		await Promise.all(
			[
				fileSkillDir,
				fileToolDir,
				environmentSkillDir,
				environmentToolDir,
				defaultSkillDir,
				defaultToolDir,
			].map((directory) => mkdir(directory, { recursive: true }))
		);
		await Promise.all([
			writeFile(join(fileSkillDir, 'file.md'), skillDocument('file-skill', 'file'), 'utf8'),
			writeFile(join(fileToolDir, 'file.tool.md'), toolDocument('file-tool', 'file'), 'utf8'),
			writeFile(
				join(environmentSkillDir, 'environment.md'),
				skillDocument('environment-skill', 'environment'),
				'utf8'
			),
			writeFile(
				join(environmentToolDir, 'environment.tool.md'),
				toolDocument('environment-tool', 'environment'),
				'utf8'
			),
			writeFile(
				join(defaultSkillDir, 'default.md'),
				skillDocument('default-skill', 'default'),
				'utf8'
			),
			writeFile(
				join(defaultToolDir, 'default.tool.md'),
				toolDocument('default-tool', 'default'),
				'utf8'
			),
		]);
		vi.stubEnv('SKILL_DIRS', environmentSkillDir);
		vi.stubEnv('TOOL_DIRS', environmentToolDir);
		const originalWorkingDirectory = process.cwd();
		process.chdir(root);

		try {
			const server = await createServer({
				fileConfig: {
					maxHistorySize: 101,
					maxBranches: 11,
					maxBranchSize: 12,
					skillDirs: [fileSkillDir],
					toolDirs: [fileToolDir],
					features: { toolInterleave: false },
				},
				maxHistorySize: 202,
				maxBranches: 22,
				maxBranchSize: 23,
				autoDiscover: true,
				loadFromPersistence: false,
			});
			liveServers.add(server);

			expect(server.config.skillDirs).toEqual([environmentSkillDir]);
			expect(server.config.toolDirs).toEqual([environmentToolDir]);
			expect(server.config.maxHistorySize).toBe(202);
			expect(server.config.maxBranches).toBe(22);
			expect(server.config.maxBranchSize).toBe(23);
			expect(server.skills.getNames()).toEqual(['environment-skill']);
			expect(server.tools.getNames().sort()).toEqual([
				'environment-tool',
				'sequentialthinking_tools',
			]);
		} finally {
			process.chdir(originalWorkingDirectory);
		}
	});

	it('keeps both startup scans disabled and skill discovery as the only server discovery method', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-manual-discovery-'));
		temporaryDirectories.add(root);
		const skillDir = join(root, 'skills');
		const toolDir = join(root, 'tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(join(skillDir, 'manual.md'), skillDocument('manual-skill', 'manual'), 'utf8'),
			writeFile(join(toolDir, 'manual.tool.md'), toolDocument('manual-tool', 'manual'), 'utf8'),
		]);
		const skillDiscovery = vi.spyOn(SkillRegistry.prototype, 'discoverAsync');
		const toolDiscovery = vi.spyOn(ToolRegistry.prototype, 'discoverAsync');
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [skillDir],
				toolDirs: [toolDir],
				features: { toolInterleave: false },
			}),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);

		expect(skillDiscovery).not.toHaveBeenCalled();
		expect(toolDiscovery).not.toHaveBeenCalled();
		expect(server.skills.hasSkill('manual-skill')).toBe(false);
		expect(server.tools.hasTool('manual-tool')).toBe(false);
		expect(
			Object.getOwnPropertyNames(Object.getPrototypeOf(server)).filter((name) =>
				name.startsWith('discover')
			)
		).toEqual(['discoverSkillsAsync']);

		await server.discoverSkillsAsync();
		expect(skillDiscovery).toHaveBeenCalledOnce();
		expect(toolDiscovery).not.toHaveBeenCalled();
		expect(server.skills.hasSkill('manual-skill')).toBe(true);
		expect(server.tools.hasTool('manual-tool')).toBe(false);

		await server.tools.discoverAsync();
		expect(toolDiscovery).toHaveBeenCalledOnce();
		expect(server.tools.hasTool('manual-tool')).toBe(true);
	});

	it('defers both registry scans when lazy discovery is enabled', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-lazy-roots-'));
		temporaryDirectories.add(root);
		const skillDir = join(root, 'skills');
		const toolDir = join(root, 'tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(join(skillDir, 'lazy.md'), skillDocument('lazy-skill', 'lazy'), 'utf8'),
			writeFile(join(toolDir, 'lazy.tool.md'), toolDocument('lazy-tool', 'lazy'), 'utf8'),
		]);
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [skillDir],
				toolDirs: [toolDir],
				features: { toolInterleave: false },
			}),
			autoDiscover: true,
			lazyDiscovery: true,
			loadFromPersistence: false,
		});
		liveServers.add(server);

		expect(server.skills.hasSkill('lazy-skill')).toBe(false);
		expect(server.tools.hasTool('lazy-tool')).toBe(false);

		await Promise.all([server.skills.discoverAsync(), server.tools.discoverAsync()]);
		expect(server.skills.hasSkill('lazy-skill')).toBe(true);
		expect(server.tools.hasTool('lazy-tool')).toBe(true);
	});

	it('keeps an explicit ServerConfig instance ahead of file and top-level options', async () => {
		const config = new ServerConfig({
			maxHistorySize: 111,
			skillDirs: [],
			toolDirs: [],
			features: { toolInterleave: false },
		});
		const server = await createServer({
			config,
			fileConfig: {
				maxHistorySize: 222,
				skillDirs: ['/file/skills'],
				toolDirs: ['/file/tools'],
			},
			maxHistorySize: 333,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);

		expect(server.config).toBe(config);
		expect(server.config.maxHistorySize).toBe(111);
		expect(server.config.skillDirs).toEqual([]);
		expect(server.config.toolDirs).toEqual([]);
	});
});
