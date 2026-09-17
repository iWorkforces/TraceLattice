import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(),
}));
vi.mock('node:os', () => ({
	homedir: vi.fn(() => '/home/testuser'),
}));

import { readFileSync, existsSync } from 'node:fs';
import { ConfigLoader } from '../../config/ConfigLoader.js';
import { ConfigurationError } from '../../errors.js';
import { ServerConfig } from '../../ServerConfig.js';

const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;

const FEATURE_ENV_VARS = [
	'TRACELATTICE_FEATURES_DAG_EDGES',
	'TRACELATTICE_FEATURES_REASONING_STRATEGY',
	'TRACELATTICE_FEATURES_CALIBRATION',
	'TRACELATTICE_FEATURES_COMPRESSION',
	'TRACELATTICE_FEATURES_TOOL_INTERLEAVE',
	'TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES',
	'TRACELATTICE_FEATURES_OUTCOME_RECORDING',
	'TRACELATTICE_TOOL_INTERLEAVE_TTL_MS',
	'TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS',
];

describe('ConfigLoader feature flags', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
		mockReadFileSync.mockImplementation(() => '');
		for (const v of FEATURE_ENV_VARS) delete process.env[v];
	});

	afterEach(() => {
		for (const v of FEATURE_ENV_VARS) delete process.env[v];
		vi.restoreAllMocks();
	});

	it('defaults all boolean feature flags to ON when no env vars or file set them', () => {
		const loader = new ConfigLoader();
		const loaded = loader.load();
		const opts = loader.toServerConfigOptions(loaded ?? {});
		const config = new ServerConfig(opts);

		expect(config.features.dagEdges).toBe(true);
		expect(config.features.calibration).toBe(true);
		expect(config.features.compression).toBe(true);
		expect(config.features.toolInterleave).toBe(true);
		expect(config.features.newThoughtTypes).toBe(true);
		expect(config.features.outcomeRecording).toBe(true);
		expect(config.features.reasoningStrategy).toBe('sequential');
	});

	it('preserves caller values and unknown fields when no environment override is present', () => {
		const extension = { enabled: true };
		const raw = {
			features: { dagEdges: false, reasoningStrategy: 'tot' as const },
			discoveryCache: { ttl: 4321, maxSize: 17 },
			persistence: { enabled: true, backend: 'memory' as const },
			extension,
		};

		const effective = new ConfigLoader().applyEnvironmentOverrides(raw);

		expect(effective).not.toBe(raw);
		expect(effective).toEqual(raw);
		expect(Reflect.get(effective, 'extension')).toBe(extension);
	});

	it('restores original feature values when the same raw input is reused after env cleanup', () => {
		const raw = {
			features: { dagEdges: true, calibration: false },
		};
		const loader = new ConfigLoader();
		process.env.TRACELATTICE_FEATURES_DAG_EDGES = 'false';

		const overridden = loader.applyEnvironmentOverrides(raw);
		delete process.env.TRACELATTICE_FEATURES_DAG_EDGES;
		const restored = loader.applyEnvironmentOverrides(raw);

		expect(overridden.features?.dagEdges).toBe(false);
		expect(restored.features).toEqual({ dagEdges: true, calibration: false });
		expect(raw.features).toEqual({ dagEdges: true, calibration: false });
	});

	it('TRACELATTICE_FEATURES_DAG_EDGES=true enables dagEdges', () => {
		process.env.TRACELATTICE_FEATURES_DAG_EDGES = 'true';
		const loader = new ConfigLoader();
		const loaded = loader.load();
		const config = new ServerConfig(loader.toServerConfigOptions(loaded ?? {}));

		expect(config.features.dagEdges).toBe(true);
		// Other flags remain on by default.
		expect(config.features.calibration).toBe(true);
	});

	it('TRACELATTICE_FEATURES_REASONING_STRATEGY=tot sets reasoningStrategy', () => {
		process.env.TRACELATTICE_FEATURES_REASONING_STRATEGY = 'tot';
		const loader = new ConfigLoader();
		const loaded = loader.load();
		const config = new ServerConfig(loader.toServerConfigOptions(loaded ?? {}));

		expect(config.features.reasoningStrategy).toBe('tot');
	});

	it('rejects an invalid reasoning strategy instead of silently falling back', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		process.env.TRACELATTICE_FEATURES_REASONING_STRATEGY = 'bogus';

		const loader = new ConfigLoader();

		expect(() => loader.load()).toThrow(ConfigurationError);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('rejects a numeric environment value with trailing characters', () => {
		process.env.TRACELATTICE_TOOL_INTERLEAVE_TTL_MS = '1234garbage';

		const loader = new ConfigLoader();

		expect(() => loader.load()).toThrow(ConfigurationError);
	});

	it('all boolean feature flags respond to env vars', () => {
		process.env.TRACELATTICE_FEATURES_DAG_EDGES = 'true';
		process.env.TRACELATTICE_FEATURES_CALIBRATION = '1';
		process.env.TRACELATTICE_FEATURES_COMPRESSION = 'true';
		process.env.TRACELATTICE_FEATURES_TOOL_INTERLEAVE = 'TRUE';
		process.env.TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES = '1';
		process.env.TRACELATTICE_FEATURES_OUTCOME_RECORDING = 'true';

		const loader = new ConfigLoader();
		const loaded = loader.load();
		const config = new ServerConfig(loader.toServerConfigOptions(loaded ?? {}));

		expect(config.features.dagEdges).toBe(true);
		expect(config.features.calibration).toBe(true);
		expect(config.features.compression).toBe(true);
		expect(config.features.toolInterleave).toBe(true);
		expect(config.features.newThoughtTypes).toBe(true);
		expect(config.features.outcomeRecording).toBe(true);
	});

	it('boolean flags also accept false / 0 to disable', () => {
		// File enables; env disables — env wins.
		mockExistsSync.mockImplementation((path: string) => path === '.claude/config.json');
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				features: { dagEdges: true, compression: true },
			})
		);
		process.env.TRACELATTICE_FEATURES_DAG_EDGES = 'false';
		process.env.TRACELATTICE_FEATURES_COMPRESSION = '0';

		const loader = new ConfigLoader();
		const loaded = loader.load();
		const config = new ServerConfig(loader.toServerConfigOptions(loaded ?? {}));

		expect(config.features.dagEdges).toBe(false);
		expect(config.features.compression).toBe(false);
	});

	it('invalid boolean values are warned and ignored (default ON preserved)', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		process.env.TRACELATTICE_FEATURES_DAG_EDGES = 'maybe';

		const loader = new ConfigLoader();
		const loaded = loader.load();
		const config = new ServerConfig(loader.toServerConfigOptions(loaded ?? {}));

		expect(config.features.dagEdges).toBe(true);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('TRACELATTICE_FEATURES_DAG_EDGES')
		);
	});

	it('environment values override distinct feature and timing values from the config file', () => {
		mockExistsSync.mockImplementation((path: string) => path === '.claude/config.json');
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				features: {
					dagEdges: true,
					reasoningStrategy: 'sequential',
					calibration: true,
				},
				toolInterleaveTtlMs: 9000,
				toolInterleaveSweepMs: 8000,
			})
		);
		process.env.TRACELATTICE_FEATURES_DAG_EDGES = 'false';
		process.env.TRACELATTICE_FEATURES_REASONING_STRATEGY = 'tot';
		process.env.TRACELATTICE_TOOL_INTERLEAVE_TTL_MS = '1234';
		process.env.TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS = '4321';

		const loader = new ConfigLoader();
		const loaded = loader.load();
		const config = new ServerConfig(loader.toServerConfigOptions(loaded ?? {}));

		expect(config.features.dagEdges).toBe(false);
		expect(config.features.reasoningStrategy).toBe('tot');
		expect(config.features.calibration).toBe(true);
		expect(config.features.compression).toBe(true);
		expect(config.toolInterleaveTtlMs).toBe(1234);
		expect(config.toolInterleaveSweepMs).toBe(4321);
	});

	it('feature flags from YAML config file are loaded', () => {
		mockExistsSync.mockImplementation((path: string) => path === '.claude/config.yaml');
		mockReadFileSync.mockReturnValue(
			[
				'features:',
				'  dagEdges: true',
				'  reasoningStrategy: tot',
				'  outcomeRecording: true',
			].join('\n')
		);

		const loader = new ConfigLoader();
		const loaded = loader.load();
		const config = new ServerConfig(loader.toServerConfigOptions(loaded ?? {}));

		expect(config.features.dagEdges).toBe(true);
		expect(config.features.reasoningStrategy).toBe('tot');
		expect(config.features.outcomeRecording).toBe(true);
		expect(config.features.calibration).toBe(true); // default (now ON)
	});

	it('toJSON includes the features field', () => {
		const config = new ServerConfig({ features: { dagEdges: true } });
		const json = config.toJSON();
		expect(json.features).toEqual({
			dagEdges: true,
			reasoningStrategy: 'sequential',
			calibration: true,
			compression: true,
			toolInterleave: true,
			newThoughtTypes: true,
			outcomeRecording: true,
		});
	});
});
