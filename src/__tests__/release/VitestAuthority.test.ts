import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { loadConfigFromFile } from 'vite';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const vitestConfigPath = resolve(projectRoot, 'vitest.config.ts');
const vitestCliPath = resolve(projectRoot, 'node_modules/vitest/vitest.mjs');
const commandTimeoutMs = 30_000;
const runCommand = promisify(execFile);

const packageScriptsSchema = v.object({
	scripts: v.object({
		test: v.string(),
		'test:watch': v.string(),
		'test:coverage': v.string(),
	}),
});

const vitestConfigSchema = v.object({
	test: v.object({
		coverage: v.object({
			thresholds: v.object({
				branches: v.number(),
				functions: v.number(),
				lines: v.number(),
				statements: v.number(),
			}),
		}),
		hookTimeout: v.number(),
		include: v.array(v.string()),
		teardownTimeout: v.number(),
		testTimeout: v.number(),
	}),
});

async function listTestFiles(commandArguments: readonly string[]): Promise<readonly string[]> {
	const { stdout } = await runCommand(
		process.execPath,
		[vitestCliPath, 'list', ...commandArguments, '--filesOnly'],
		{
			cwd: projectRoot,
			encoding: 'utf8',
			maxBuffer: 1_000_000,
			timeout: commandTimeoutMs,
		}
	);

	return stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.sort();
}

describe('Vitest configuration authority', () => {
	it('keeps the TypeScript config as the only root Vitest config', async () => {
		// Given
		const rootEntries = await readdir(projectRoot);
		// When
		const configFiles = rootEntries.filter((entry) => entry.startsWith('vitest.config.')).sort();
		// Then
		expect(configFiles).toEqual(['vitest.config.ts']);
	});

	it('selects the TypeScript config explicitly from each test script', async () => {
		// Given
		const packageContents = await readFile(resolve(projectRoot, 'package.json'), 'utf8');
		// When
		const packageManifest = v.parse(packageScriptsSchema, JSON.parse(packageContents));
		// Then
		expect({
			test: packageManifest.scripts.test,
			'test:watch': packageManifest.scripts['test:watch'],
			'test:coverage': packageManifest.scripts['test:coverage'],
		}).toEqual({
			test: 'vitest run --config vitest.config.ts',
			'test:watch': 'vitest --config vitest.config.ts',
			'test:coverage': 'vitest run --config vitest.config.ts --coverage',
		});
	});

	it('preserves the configured coverage gates, timeouts, and test discovery includes', async () => {
		// Given
		const configLoadResult = await loadConfigFromFile(
			{ command: 'serve', mode: 'test' },
			vitestConfigPath
		);
		// When
		const config = v.parse(vitestConfigSchema, configLoadResult?.config);
		// Then
		expect(config.test.coverage.thresholds).toEqual({
			branches: 90,
			functions: 60,
			lines: 65,
			statements: 65,
		});
		expect(config.test.testTimeout).toBe(30_000);
		expect(config.test.hookTimeout).toBe(30_000);
		expect(config.test.teardownTimeout).toBe(30_000);
		expect(config.test.include).toContain('src/**/*.{test,spec}.{ts,tsx}');
		expect(config.test.include).toContain('src/**/*.eval.ts');
	});

	it('discovers the same nonempty test files with default and explicit config selection', async () => {
		// Given
		const explicitConfigArguments = ['--config', vitestConfigPath];
		// When
		const defaultFiles = await listTestFiles([]);
		const explicitConfigFiles = await listTestFiles(explicitConfigArguments);
		// Then
		expect(defaultFiles).not.toHaveLength(0);
		expect(explicitConfigFiles).not.toHaveLength(0);
		expect(defaultFiles).toEqual(explicitConfigFiles);
	});
});
