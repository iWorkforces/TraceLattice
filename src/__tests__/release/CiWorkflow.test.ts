import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const checkoutAction = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const setupNodeAction = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const setupBunAction = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6';
const uploadArtifactAction = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const requiredJobNames = ['library', 'native-sqlite', 'packed-cli'] as const;

const scalarSchema = v.union([v.string(), v.number(), v.boolean()]);
const stepSchema = v.looseObject({
	env: v.optional(v.record(v.string(), v.string())),
	if: v.optional(v.union([v.string(), v.boolean()])),
	'continue-on-error': v.optional(v.boolean()),
	run: v.optional(v.string()),
	uses: v.optional(v.string()),
	with: v.optional(v.record(v.string(), scalarSchema)),
});
const jobSchema = v.looseObject({
	'continue-on-error': v.optional(v.boolean()),
	if: v.optional(v.string()),
	needs: v.optional(v.union([v.string(), v.array(v.string())])),
	'runs-on': v.string(),
	steps: v.array(stepSchema),
	strategy: v.optional(
		v.looseObject({
			matrix: v.looseObject({ 'node-version': v.array(v.string()) }),
		})
	),
});
const workflowSchema = v.object({
	jobs: v.record(v.string(), jobSchema),
	on: v.record(v.string(), v.unknown()),
});

type Workflow = v.InferOutput<typeof workflowSchema>;
type Job = v.InferOutput<typeof jobSchema>;
type Step = v.InferOutput<typeof stepSchema>;

async function readWorkflow(): Promise<Workflow> {
	const contents = await readFile(resolve(projectRoot, '.github/workflows/ci.yml'), 'utf8');
	return v.parse(workflowSchema, parse(contents));
}

function getJob(workflow: Workflow, name: string): Job {
	return v.parse(jobSchema, workflow.jobs[name]);
}

function getStepByUses(job: Job, uses: string): Step {
	return v.parse(
		stepSchema,
		job.steps.find((step) => step.uses === uses)
	);
}

function getStepByRun(job: Job, run: string): Step {
	return v.parse(
		stepSchema,
		job.steps.find((step) => step.run === run)
	);
}

function expectPinnedNodeSteps(job: Job, nodeVersion: string): void {
	expect(getStepByUses(job, checkoutAction).uses).toBe(checkoutAction);
	expect(getStepByUses(job, setupNodeAction).with).toEqual({
		'node-version': nodeVersion,
		cache: 'npm',
	});
}

describe('CI workflow release policy', () => {
	it('preserves branch triggers and exposes workflow_call with the exact job set', async () => {
		// Given
		const workflow = await readWorkflow();
		// When
		const triggerNames = Object.keys(workflow.on).sort();
		// Then
		expect(triggerNames).toEqual(['pull_request', 'push', 'workflow_call']);
		expect(workflow.on['push']).toEqual({ branches: ['main'] });
		expect(Object.keys(workflow.jobs).sort()).toEqual([
			'advisory-audit',
			'library',
			'native-sqlite',
			'packed-cli',
			'required-gates',
		]);
	});

	it('runs the canonical library gate on the exact Node matrix', async () => {
		// Given
		const libraryJob = getJob(await readWorkflow(), 'library');
		// When
		const nodeVersions = libraryJob.strategy?.matrix['node-version'];
		const runCommands = libraryJob.steps.flatMap((step) =>
			step.run === undefined ? [] : [step.run]
		);
		// Then
		expect(libraryJob['runs-on']).toBe('ubuntu-latest');
		expect(new Set(nodeVersions)).toEqual(new Set(['24.x', '26.x']));
		expectPinnedNodeSteps(libraryJob, '${{ matrix.node-version }}');
		expect(runCommands).toEqual(['npm install', 'npm run verify:library']);
	});

	it('makes native SQLite conformance mandatory on Node 26', async () => {
		// Given
		const nativeJob = getJob(await readWorkflow(), 'native-sqlite');
		// When
		const runCommands = nativeJob.steps.flatMap((step) =>
			step.run === undefined ? [] : [step.run]
		);
		// Then
		expect(nativeJob['runs-on']).toBe('ubuntu-24.04');
		expectPinnedNodeSteps(nativeJob, '26.x');
		expect(runCommands).toEqual(['npm install', 'npm run verify:native']);
		expect(nativeJob.if).toBeUndefined();
		expect(nativeJob.steps.every((step) => step.if === undefined)).toBe(true);
	});

	it('builds and verifies the packed CLI with exact Node and Bun runtimes', async () => {
		// Given
		const packedJob = getJob(await readWorkflow(), 'packed-cli');
		// When
		const bunStep = getStepByUses(packedJob, setupBunAction);
		const verifyStep = getStepByRun(packedJob, 'npm run verify:packed');
		const runCommands = packedJob.steps.flatMap((step) =>
			step.run === undefined ? [] : [step.run]
		);
		// Then
		expect(packedJob['runs-on']).toBe('ubuntu-24.04');
		expectPinnedNodeSteps(packedJob, '26.x');
		expect(bunStep.with).toEqual({ 'bun-version': '1.4.2' });
		expect(runCommands).toEqual([
			'test "$(bun --version)" = "1.4.2"',
			'npm install',
			'npm run build',
			'npm run verify:packed',
		]);
		expect(verifyStep.env).toEqual({
			TRACELATTICE_PACK_OUTPUT_DIR: '${{ runner.temp }}/tracelattice-release',
			TRACELATTICE_SOURCE_SHA: '${{ github.sha }}',
		});
	});

	it('uploads only the immutable verified SHA artifact', async () => {
		// Given
		const packedJob = getJob(await readWorkflow(), 'packed-cli');
		// When
		const uploadStep = getStepByUses(packedJob, uploadArtifactAction);
		// Then
		expect(uploadStep.with).toEqual({
			name: 'tracelattice-release-${{ github.sha }}',
			path: '${{ runner.temp }}/tracelattice-release',
			'if-no-files-found': 'error',
			'retention-days': 7,
			'compression-level': 0,
			overwrite: false,
		});
		expect(packedJob.steps.at(-1)).toEqual(uploadStep);
	});
});

describe('CI workflow action policy', () => {
	it('pins every action to the approved immutable revision', async () => {
		// Given
		const workflow = await readWorkflow();
		// When
		const actions = Object.values(workflow.jobs).flatMap((job) =>
			job.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses]))
		);
		// Then
		expect(actions.every((action) => /@[0-9a-f]{40}$/.test(action))).toBe(true);
		expect(new Set(actions)).toEqual(
			new Set([checkoutAction, setupNodeAction, setupBunAction, uploadArtifactAction])
		);
	});
});

describe('CI workflow failure policy', () => {
	it('does not permit required jobs or steps to hide failures', async () => {
		// Given
		const workflow = await readWorkflow();
		// When
		const requiredJobs = requiredJobNames.map((name) => getJob(workflow, name));
		// Then
		expect(requiredJobs.every((job) => job['continue-on-error'] === undefined)).toBe(true);
		expect(
			requiredJobs.every((job) =>
				job.steps.every((step) => step['continue-on-error'] === undefined && step.if === undefined)
			)
		).toBe(true);
	});

	it('aggregates every required result under always and fails non-success results', async () => {
		// Given
		const requiredGatesJob = getJob(await readWorkflow(), 'required-gates');
		// When
		const gateCommand = requiredGatesJob.steps[0]?.run;
		// Then
		expect(requiredGatesJob.needs).toEqual(requiredJobNames);
		expect(requiredGatesJob.if).toBe('always()');
		expect(requiredGatesJob['continue-on-error']).toBeUndefined();
		expect(requiredGatesJob.steps.every((step) => step['continue-on-error'] === undefined)).toBe(
			true
		);
		expect(gateCommand).toContain('${{ needs.library.result }}');
		expect(gateCommand).toContain('${{ needs.native-sqlite.result }}');
		expect(gateCommand).toContain('${{ needs.packed-cli.result }}');
		expect(gateCommand).toContain('!= "success"');
		expect(gateCommand).toContain('exit 1');
	});

	it('keeps npm audit advisory and outside the required aggregate', async () => {
		// Given
		const workflow = await readWorkflow();
		const auditJob = getJob(workflow, 'advisory-audit');
		// When
		const auditStep = getStepByRun(auditJob, 'npm audit --audit-level=high');
		// Then
		expect(auditJob['runs-on']).toBe('ubuntu-latest');
		expectPinnedNodeSteps(auditJob, '26.x');
		expect(getStepByRun(auditJob, 'npm install').run).toBeDefined();
		expect(auditStep['continue-on-error']).toBe(true);
		expect(getJob(workflow, 'required-gates').needs).not.toContain('advisory-audit');
	});
});
