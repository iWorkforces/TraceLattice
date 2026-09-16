import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type FixtureManifest = Record<string, unknown>;
type FixtureCase = {
	readonly label: string;
	readonly code: string;
	readonly mutate: (root: string, manifest: FixtureManifest) => Promise<void>;
};
type ProcessResult = { readonly code: number | null; readonly stderr: string };

const verifier = fileURLToPath(new URL('../../../scripts/verify-packed-cli.mjs', import.meta.url));
const verifierUrl = new URL('../../../scripts/verify-packed-cli.mjs', import.meta.url).href;
const packageModuleUrl = new URL('../../../scripts/packed-cli-package.mjs', import.meta.url).href;
const temporaryRoots: string[] = [];
const cliBody = `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('tracelattice v1.2.3');
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'notifications/initialized') return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'tracelattice', version: '1.2.3' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: 'sequentialthinking_tools' }] };
    else result = request.params?.arguments ? { content: [{ type: 'text', text: 'ok' }] } : { isError: true, content: [{ type: 'text', text: 'invalid' }] };
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
}
`;

const cases: readonly FixtureCase[] = [
	{
		label: 'missing CLI',
		code: 'PACKED_CLI_MISSING',
		mutate: async (root) => rm(join(root, 'dist/cli.js')),
	},
	{
		label: 'missing root import',
		code: 'PACKED_EXPORT_MISSING: . import',
		mutate: async (_root, manifest) => {
			manifest.exports = { '.': { types: './dist/lib.d.ts' }, './package.json': './package.json' };
		},
	},
	{
		label: 'physically missing root import target',
		code: 'PACKED_EXPORT_MISSING: . import',
		mutate: async (root) => rm(join(root, 'dist/lib.js')),
	},
	{
		label: 'missing root types',
		code: 'PACKED_EXPORT_MISSING: . types',
		mutate: async (_root, manifest) => {
			manifest.exports = { '.': { import: './dist/lib.js' }, './package.json': './package.json' };
		},
	},
	{
		label: 'physically missing root types target',
		code: 'PACKED_EXPORT_MISSING: . types',
		mutate: async (root) => rm(join(root, 'dist/lib.d.ts')),
	},
	{
		label: 'missing package export',
		code: 'PACKED_EXPORT_MISSING: ./package.json',
		mutate: async (_root, manifest) => {
			manifest.exports = {
				'.': { types: './dist/lib.d.ts', import: './dist/lib.js' },
			};
		},
	},
	{
		label: 'missing bin key',
		code: 'PACKED_BIN_MISSING: tracelattice',
		mutate: async (_root, manifest) => {
			manifest.bin = { other: './dist/cli.js' };
		},
	},
	{
		label: 'absolute bin',
		code: 'PACKED_BIN_INVALID',
		mutate: async (_root, manifest) => {
			manifest.bin = { tracelattice: '/dist/cli.js' };
		},
	},
	{
		label: 'traversal bin',
		code: 'PACKED_BIN_INVALID',
		mutate: async (_root, manifest) => {
			manifest.bin = { tracelattice: '../cli.js' };
		},
	},
	{
		label: 'non-string bin',
		code: 'PACKED_BIN_INVALID',
		mutate: async (_root, manifest) => {
			manifest.bin = { tracelattice: 42 };
		},
	},
	{
		label: 'wrong shebang',
		code: 'PACKED_CLI_SHEBANG',
		mutate: async (root) => writeFile(join(root, 'dist/cli.js'), cliBody.replace('bun', 'node')),
	},
	{
		label: 'missing shebang',
		code: 'PACKED_CLI_SHEBANG',
		mutate: async (root) =>
			writeFile(join(root, 'dist/cli.js'), cliBody.slice(cliBody.indexOf('\n') + 1)),
	},
	{
		label: 'wrong package name',
		code: 'PACKED_NAME_INVALID',
		mutate: async (_root, manifest) => {
			manifest.name = 'not-tracelattice';
		},
	},
	{
		label: 'missing publish files contract',
		code: 'PACKED_FILES_INVALID',
		mutate: async (_root, manifest) => {
			delete manifest.files;
		},
	},
	{
		label: 'traversing publish file entry',
		code: 'PACKED_FILES_INVALID',
		mutate: async (_root, manifest) => {
			manifest.files = ['dist', 'README.md', 'LICENSE', '../outside'];
		},
	},
];

async function createFixture(fixtureCase: FixtureCase): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'tracelattice-packed-fixture-'));
	temporaryRoots.push(root);
	await mkdir(join(root, 'dist'));
	await writeFile(join(root, 'README.md'), 'fixture\n');
	await writeFile(join(root, 'LICENSE'), 'fixture\n');
	await writeFile(join(root, 'dist/lib.js'), 'export const fixture = true;\n');
	await writeFile(join(root, 'dist/lib.d.ts'), 'export declare const fixture: true;\n');
	await writeFile(join(root, 'dist/cli.js'), cliBody);
	await chmod(join(root, 'dist/cli.js'), 0o755);
	const manifest: FixtureManifest = {
		name: 'tracelattice',
		version: '1.2.3',
		type: 'module',
		main: 'dist/lib.js',
		types: 'dist/lib.d.ts',
		exports: {
			'.': { types: './dist/lib.d.ts', import: './dist/lib.js' },
			'./package.json': './package.json',
		},
		bin: { tracelattice: './dist/cli.js' },
		files: ['dist', 'README.md', 'LICENSE'],
	};
	await fixtureCase.mutate(root, manifest);
	await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	return root;
}

async function runVerifier(packageDirectory: string): Promise<ProcessResult> {
	const child = spawn(process.execPath, [verifier, '--package-dir', packageDirectory], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk;
	});
	const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code) => {
			clearTimeout(timeout);
			resolve({ code, stderr });
		});
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('packed CLI artifact contract', () => {
	it.each(cases)(
		'rejects $label with $code after packing and installing',
		async (fixtureCase) => {
			// Given
			const packageDirectory = await createFixture(fixtureCase);
			// When
			const result = await runVerifier(packageDirectory);
			// Then
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(fixtureCase.code);
			expect(result.stderr).toContain('PACK_SUCCEEDED=true');
			expect(result.stderr).toContain('INSTALL_SUCCEEDED=true');
		},
		120_000
	);

	it('preserves the semantic failure when cleanup also fails', () => {
		// Given
		const probe = `
			import { appendCleanupDiagnostics } from ${JSON.stringify(verifierUrl)};
			import { PackedCliError } from ${JSON.stringify(packageModuleUrl)};
			const primary = new PackedCliError('PACKED_EXPORT_MISSING', '. import', { packSucceeded: true, installSucceeded: true });
			const result = appendCleanupDiagnostics(primary, [new Error('rm denied')]);
			console.log(JSON.stringify({ code: result.code, message: result.message, pack: result.packSucceeded, install: result.installSucceeded }));
		`;
		// When
		const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
			encoding: 'utf8',
		});
		// Then
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			code: 'PACKED_EXPORT_MISSING',
			message: '. import; cleanup failures: Error: rm denied',
			pack: true,
			install: true,
		});
	});
});
