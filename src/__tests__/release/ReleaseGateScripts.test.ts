import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageManifestSchema = v.object({
	name: v.string(),
	bin: v.object({ tracelattice: v.string() }),
	dependencies: v.optional(v.record(v.string(), v.string())),
	devDependencies: v.record(v.string(), v.string()),
	scripts: v.looseObject({
		'test:native': v.string(),
		'verify:library': v.string(),
		'verify:native': v.string(),
		'verify:packed': v.string(),
		'verify:release': v.string(),
		prepublishOnly: v.string(),
	}),
});
const expectedReleaseScripts = {
	'test:native':
		'vitest run --config vitest.config.ts src/__tests__/integration/NativeSqliteConformance.test.ts',
	'verify:library': 'npm run type-check && npm run lint && npm run build && npm run test:coverage',
	'verify:native': 'npm ls better-sqlite3@13.0.3 --depth=0 && npm run test:native',
	'verify:packed': 'node scripts/verify-packed-cli.mjs',
	'verify:release': 'npm run verify:library && npm run verify:native && npm run verify:packed',
	prepublishOnly: 'npm run verify:release',
} as const;
const alternatePublishHooks = [
	'prepublish',
	'prepare',
	'prepack',
	'postpack',
	'publish',
	'postpublish',
] as const;

async function readPackageManifest() {
	const packageContents = await readFile(resolve(projectRoot, 'package.json'), 'utf8');
	return v.parse(packageManifestSchema, JSON.parse(packageContents));
}

describe('release gate package scripts', () => {
	it('publishes the scoped package while preserving the public CLI bin', async () => {
		// Given
		const packageManifest = await readPackageManifest();
		// When
		const packageIdentity = { name: packageManifest.name, bin: packageManifest.bin };
		// Then
		expect(packageIdentity).toEqual({
			name: '@iworkforces/tracelattice',
			bin: { tracelattice: './dist/cli.js' },
		});
	});

	it('defines the canonical release-gate command graph', async () => {
		// Given
		const packageManifest = await readPackageManifest();
		// When
		const releaseScripts = {
			'test:native': packageManifest.scripts['test:native'],
			'verify:library': packageManifest.scripts['verify:library'],
			'verify:native': packageManifest.scripts['verify:native'],
			'verify:packed': packageManifest.scripts['verify:packed'],
			'verify:release': packageManifest.scripts['verify:release'],
			prepublishOnly: packageManifest.scripts.prepublishOnly,
		};
		// Then
		expect(releaseScripts).toEqual(expectedReleaseScripts);
	});

	it('requires coverage and native SQLite conformance through && composition', async () => {
		// Given
		const packageManifest = await readPackageManifest();
		const composedScripts = [
			packageManifest.scripts['verify:library'],
			packageManifest.scripts['verify:native'],
			packageManifest.scripts['verify:release'],
		];
		// When
		const libraryGate = packageManifest.scripts['verify:library'];
		// Then
		expect(libraryGate).toContain('npm run test:coverage');
		expect(libraryGate).not.toMatch(/(?:^|&& )npm(?: run)? test(?:$| &&)/);
		expect(composedScripts.every((script) => script.includes(' && '))).toBe(true);
		expect(
			composedScripts.every((script) => !script.includes(' || ') && !script.includes(';'))
		).toBe(true);
		expect(packageManifest.scripts['verify:native']).toContain(
			'npm ls better-sqlite3@13.0.3 --depth=0'
		);
		expect(packageManifest.scripts['test:native']).not.toContain('||');
	});

	it('keeps SQLite development-only and prevents lifecycle bypasses', async () => {
		// Given
		const packageManifest = await readPackageManifest();
		// When
		const alternateHooks = alternatePublishHooks.map((hook) => packageManifest.scripts[hook]);
		// Then
		expect(packageManifest.dependencies?.['better-sqlite3']).toBeUndefined();
		expect(packageManifest.devDependencies['better-sqlite3']).toBe('13.0.3');
		expect(alternateHooks).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});
