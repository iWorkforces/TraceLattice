import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(),
}));
vi.mock('node:os', () => ({
	homedir: vi.fn(() => '/home/testuser'),
}));

import { readFileSync, existsSync } from 'node:fs';
import { ConfigLoader } from '../config/ConfigLoader.js';
import { ConfigurationError } from '../errors.js';

const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;

describe('ConfigLoader', () => {
	let loader: ConfigLoader;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
		mockReadFileSync.mockImplementation(() => '');
	});

	afterEach(() => {
		delete process.env.MAX_HISTORY_SIZE;
		delete process.env.MAX_BRANCHES;
		delete process.env.MAX_BRANCH_SIZE;
		delete process.env.LOG_LEVEL;
		delete process.env.PRETTY_LOG;
		delete process.env.SKILL_DIRS;
		delete process.env.TOOL_DIRS;
		delete process.env.DISCOVERY_CACHE_TTL;
		delete process.env.DISCOVERY_CACHE_MAX_SIZE;
	});

	describe('constructor', () => {
		it('should use default search paths when no custom path', () => {
			loader = new ConfigLoader();
			// Just verify it doesn't throw - paths are private
			expect(loader).toBeDefined();
		});

		it('should use single custom path when provided', () => {
			loader = new ConfigLoader('/custom/config.yaml');
			mockExistsSync.mockImplementation((path: string) => path === '/custom/config.yaml');
			mockReadFileSync.mockReturnValue(JSON.stringify({ maxHistorySize: 500 }));

			const config = loader.load();
			expect(config).not.toBeNull();
			expect(config!.maxHistorySize).toBe(500);
		});
	});

	describe('load - file loading', () => {
		it('should return null when no config file found and no env vars', () => {
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			// load() applies env overrides to {} or config, returns the result
			// With no env vars set, the result is an empty object (falsy values not present)
			expect(config).toBeDefined();
			expect(config!.maxHistorySize).toBeUndefined();
		});

		it('should load JSON config file', () => {
			loader = new ConfigLoader();
			mockExistsSync.mockImplementation((path: string) => path.endsWith('.json'));
			mockReadFileSync.mockReturnValue(
				JSON.stringify({ maxHistorySize: 500, maxBranches: 20, logLevel: 'debug' })
			);

			const config = loader.load();
			expect(config).not.toBeNull();
			expect(config!.maxHistorySize).toBe(500);
			expect(config!.maxBranches).toBe(20);
			expect(config!.logLevel).toBe('debug');
		});

		it('should load YAML config file', () => {
			loader = new ConfigLoader();
			mockExistsSync.mockImplementation((path: string) => path.endsWith('.yaml'));
			mockReadFileSync.mockReturnValue('maxHistorySize: 300\nmaxBranches: 15\nlogLevel: warn');

			const config = loader.load();
			expect(config).not.toBeNull();
			expect(config!.maxHistorySize).toBe(300);
			expect(config!.maxBranches).toBe(15);
			expect(config!.logLevel).toBe('warn');
		});

		it('should load .yml config file', () => {
			loader = new ConfigLoader();
			mockExistsSync.mockImplementation((path: string) => path.endsWith('.yml'));
			mockReadFileSync.mockReturnValue('maxHistorySize: 200');

			const config = loader.load();
			expect(config!.maxHistorySize).toBe(200);
		});

		it('should use first matching file (priority order)', () => {
			loader = new ConfigLoader();
			mockExistsSync.mockImplementation((path: string) => {
				if (path.endsWith('config.json')) return true;
				if (path.endsWith('config.yaml')) return true;
				return false;
			});
			mockReadFileSync.mockImplementation((_path: string, _encoding: string) => {
				return JSON.stringify({ maxHistorySize: 100 });
			});

			const config = loader.load();
			expect(config!.maxHistorySize).toBe(100);
			// readFileSync should only be called once (first match)
			expect(mockReadFileSync).toHaveBeenCalledTimes(1);
		});

		it('should handle parse error and continue to next file', () => {
			loader = new ConfigLoader();
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation(() => {
				throw new Error('Invalid YAML');
			});

			// Should not throw, should log error
			const config = loader.load();
			expect(consoleSpy).toHaveBeenCalled();
			expect(config).toBeDefined();
			consoleSpy.mockRestore();
		});

		it('should fall back to second file when first parse fails', () => {
			loader = new ConfigLoader();
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync
				.mockImplementationOnce(() => {
					throw new Error('Bad JSON');
				})
				.mockImplementationOnce(() => JSON.stringify({ maxHistorySize: 750 }));

			const config = loader.load();
			expect(config!.maxHistorySize).toBe(750);
			consoleSpy.mockRestore();
		});
	});

	describe('environment variable overrides', () => {
		it('should override maxHistorySize from env', () => {
			process.env.MAX_HISTORY_SIZE = '500';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.maxHistorySize).toBe(500);
		});

		it('should override maxBranches from env', () => {
			process.env.MAX_BRANCHES = '25';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.maxBranches).toBe(25);
		});

		it('should override maxBranchSize from env', () => {
			process.env.MAX_BRANCH_SIZE = '200';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.maxBranchSize).toBe(200);
		});

		it('should override logLevel from env (valid values only)', () => {
			process.env.LOG_LEVEL = 'debug';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.logLevel).toBe('debug');
		});

		it('should ignore invalid logLevel from env', () => {
			process.env.LOG_LEVEL = 'trace';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.logLevel).toBeUndefined();
		});

		it('should set prettyLog to false when PRETTY_LOG=false', () => {
			process.env.PRETTY_LOG = 'false';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.prettyLog).toBe(false);
		});

		it('should not set prettyLog when PRETTY_LOG has other value', () => {
			process.env.PRETTY_LOG = 'true';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.prettyLog).toBeUndefined();
		});

		it('should parse SKILL_DIRS from colon-separated env', () => {
			process.env.SKILL_DIRS = '/skills/a:/skills/b:/skills/c';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.skillDirs).toEqual(['/skills/a', '/skills/b', '/skills/c']);
		});

		it('should parse TOOL_DIRS from colon-separated env', () => {
			process.env.TOOL_DIRS = '/tools/a:/tools/b:/tools/c';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config?.toolDirs).toEqual(['/tools/a', '/tools/b', '/tools/c']);
		});

		it('should let explicit empty root environments disable file roots', () => {
			process.env.SKILL_DIRS = '';
			process.env.TOOL_DIRS = '';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(
				JSON.stringify({ skillDirs: ['/file/skills'], toolDirs: ['/file/tools'] })
			);

			const config = loader.load();
			expect(config?.skillDirs).toEqual([]);
			expect(config?.toolDirs).toEqual([]);
		});

		it('should retain file roots when root environments are omitted', () => {
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(
				JSON.stringify({ skillDirs: ['/file/skills'], toolDirs: ['/file/tools'] })
			);

			const config = loader.load();
			expect(config?.skillDirs).toEqual(['/file/skills']);
			expect(config?.toolDirs).toEqual(['/file/tools']);
		});

		it('should defensively copy configured discovery roots', () => {
			loader = new ConfigLoader();
			const skillDirs = ['/file/skills'];
			const toolDirs = ['/file/tools'];

			const config = loader.applyEnvironmentOverrides({ skillDirs, toolDirs });

			expect(config.skillDirs).not.toBe(skillDirs);
			expect(config.toolDirs).not.toBe(toolDirs);
		});

		it('should convert DISCOVERY_CACHE_TTL from seconds to ms', () => {
			process.env.DISCOVERY_CACHE_TTL = '60';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.discoveryCache).toBeDefined();
			expect(config!.discoveryCache!.ttl).toBe(60000);
		});

		it('should set DISCOVERY_CACHE_MAX_SIZE from env', () => {
			process.env.DISCOVERY_CACHE_MAX_SIZE = '200';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			const config = loader.load();
			expect(config!.discoveryCache).toBeDefined();
			expect(config!.discoveryCache!.maxSize).toBe(200);
		});

		it('should merge discoveryCache env vars with file config', () => {
			process.env.DISCOVERY_CACHE_TTL = '120';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(JSON.stringify({ discoveryCache: { maxSize: 50 } }));

			const config = loader.load();
			expect(config!.discoveryCache!.ttl).toBe(120000);
			expect(config!.discoveryCache!.maxSize).toBe(50);
		});

		it('should override file values with env vars', () => {
			process.env.MAX_HISTORY_SIZE = '999';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(JSON.stringify({ maxHistorySize: 100 }));

			const config = loader.load();
			expect(config!.maxHistorySize).toBe(999);
		});

		it('should reject non-numeric values in numeric env vars', () => {
			process.env.MAX_HISTORY_SIZE = 'not-a-number';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(JSON.stringify({ maxHistorySize: 100 }));

			expect(() => loader.load()).toThrow(ConfigurationError);
		});

		it('should reject Infinity values in numeric env vars', () => {
			process.env.MAX_HISTORY_SIZE = 'Infinity';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			expect(() => loader.load()).toThrow(ConfigurationError);
		});
	});

	describe('toServerConfigOptions', () => {
		it('should extract server config options from loaded config', () => {
			loader = new ConfigLoader();
			const config = {
				maxHistorySize: 500,
				maxBranches: 25,
				maxBranchSize: 200,
				logLevel: 'debug' as const,
				prettyLog: true,
			};

			const opts = loader.toServerConfigOptions(config);
			expect(opts).toEqual({
				maxHistorySize: 500,
				maxBranches: 25,
				maxBranchSize: 200,
			});
		});

		it('should return undefined for missing values', () => {
			loader = new ConfigLoader();
			const opts = loader.toServerConfigOptions({});
			expect(opts.maxHistorySize).toBeUndefined();
			expect(opts.maxBranches).toBeUndefined();
			expect(opts.maxBranchSize).toBeUndefined();
		});

		it('should handle partial config', () => {
			loader = new ConfigLoader();
			const opts = loader.toServerConfigOptions({ maxHistorySize: 300 });
			expect(opts.maxHistorySize).toBe(300);
			expect(opts.maxBranches).toBeUndefined();
		});

		it('should carry both discovery root types into server options', () => {
			loader = new ConfigLoader();

			const opts = loader.toServerConfigOptions({
				skillDirs: ['/skills'],
				toolDirs: ['/tools'],
			});

			expect(opts.skillDirs).toEqual(['/skills']);
			expect(opts.toolDirs).toEqual(['/tools']);
		});
	});

	describe('uncovered branch coverage', () => {
		it('should reject NaN MAX_BRANCH_SIZE from env', () => {
			process.env.MAX_BRANCH_SIZE = 'not-a-number';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			expect(() => loader.load()).toThrow(ConfigurationError);
		});

		it('should reject NaN DISCOVERY_CACHE_TTL from env', () => {
			process.env.DISCOVERY_CACHE_TTL = 'invalid';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			expect(() => loader.load()).toThrow(ConfigurationError);
		});

		it('should reject NaN DISCOVERY_CACHE_MAX_SIZE from env', () => {
			process.env.DISCOVERY_CACHE_MAX_SIZE = 'invalid';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			expect(() => loader.load()).toThrow(ConfigurationError);
		});

		it('should handle non-Error thrown during config parse', () => {
			loader = new ConfigLoader();
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockExistsSync.mockReturnValue(true);

			mockReadFileSync.mockImplementation(() => {
				throw 'string error thrown';
			});

			const config = loader.load();
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to load config'),
				'string error thrown'
			);
			expect(config).toBeDefined();
			consoleSpy.mockRestore();
		});

		it('should reject Infinity MAX_BRANCHES from env', () => {
			process.env.MAX_BRANCHES = 'Infinity';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			expect(() => loader.load()).toThrow(ConfigurationError);
		});

		it('should reject Infinity MAX_BRANCH_SIZE from env', () => {
			process.env.MAX_BRANCH_SIZE = 'Infinity';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			expect(() => loader.load()).toThrow(ConfigurationError);
		});

		it('should reject Infinity DISCOVERY_CACHE_TTL from env', () => {
			process.env.DISCOVERY_CACHE_TTL = 'Infinity';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			expect(() => loader.load()).toThrow(ConfigurationError);
		});

		it('should reject Infinity DISCOVERY_CACHE_MAX_SIZE from env', () => {
			process.env.DISCOVERY_CACHE_MAX_SIZE = 'Infinity';
			loader = new ConfigLoader();
			mockExistsSync.mockReturnValue(false);

			expect(() => loader.load()).toThrow(ConfigurationError);
		});
	});
});
