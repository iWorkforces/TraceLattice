import { once } from 'node:events';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, LogLevel } from '../../logger/StructuredLogger.js';
import { SkillRegistry } from '../../registry/SkillRegistry.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { SkillWatcher } from '../../watchers/SkillWatcher.js';
import { ToolWatcher } from '../../watchers/ToolWatcher.js';

const EVENT_DEADLINE_MS = 5_000;

type RefreshableRegistry = {
	refreshAsync(): Promise<number>;
};

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

function createLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		setLevel: vi.fn(),
		getLevel: vi.fn((): LogLevel => 'info'),
	};
}

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`Timed out waiting for ${label}`)),
			EVENT_DEADLINE_MS
		);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function observeRefreshes(registry: RefreshableRegistry): () => Promise<number> {
	const originalRefresh = registry.refreshAsync.bind(registry);
	const refreshSpy = vi.spyOn(registry, 'refreshAsync');
	return () =>
		new Promise<number>((resolve, reject) => {
			refreshSpy.mockImplementationOnce(async () => {
				try {
					const count = await originalRefresh();
					resolve(count);
					return count;
				} catch (error) {
					reject(error);
					throw error;
				}
			});
		});
}

describe('Discovery refresh integration', () => {
	let rootDir: string;
	const activeWatchers: Array<{ stop(): Promise<void> }> = [];

	beforeEach(async () => {
		rootDir = await mkdtemp(join(tmpdir(), 'tracelattice-discovery-refresh-'));
	});

	afterEach(async () => {
		await Promise.all(activeWatchers.splice(0).map((watcher) => watcher.stop()));
		await rm(rootDir, { recursive: true, force: true });
	});

	it('reconciles real skill add, change, and unlink events', async () => {
		// Given
		const skillDir = join(rootDir, 'skills');
		const alphaPath = join(skillDir, 'alpha.md');
		const betaPath = join(skillDir, 'beta.md');
		await mkdir(skillDir, { recursive: true });
		await writeFile(alphaPath, skillDocument('alpha', 'first'), 'utf8');
		const registry = new SkillRegistry({ skillDirs: [skillDir] });
		await registry.discoverAsync();
		const watcher = new SkillWatcher(registry, undefined, [skillDir]);
		activeWatchers.push(watcher);
		await withDeadline(watcher.ready(), 'skill watcher readiness');
		await registry.refreshAsync();
		const nextRefresh = observeRefreshes(registry);

		// When/Then: add
		let refreshed = nextRefresh();
		await writeFile(betaPath, skillDocument('beta', 'second'), 'utf8');
		await withDeadline(refreshed, 'skill add refresh');
		expect(registry.getNames().sort()).toEqual(['alpha', 'beta']);

		// When/Then: change
		refreshed = nextRefresh();
		await writeFile(alphaPath, skillDocument('alpha', 'updated'), 'utf8');
		await withDeadline(refreshed, 'skill change refresh');
		expect(registry.getSkill('alpha')?.description).toBe('updated');

		// When/Then: unlink
		refreshed = nextRefresh();
		await unlink(betaPath);
		await withDeadline(refreshed, 'skill unlink refresh');
		expect(registry.getNames()).toEqual(['alpha']);
	});

	it('retains the last-known-good skill when replacement metadata is malformed', async () => {
		// Given
		const skillDir = join(rootDir, 'skills');
		const skillPath = join(skillDir, 'alpha.md');
		await mkdir(skillDir, { recursive: true });
		await writeFile(skillPath, skillDocument('alpha', 'stable'), 'utf8');
		const logger = createLogger();
		const registry = new SkillRegistry({ skillDirs: [skillDir], logger });
		await registry.discoverAsync();
		const watcher = new SkillWatcher(registry, logger, [skillDir]);
		activeWatchers.push(watcher);
		await withDeadline(watcher.ready(), 'malformed skill watcher readiness');
		await registry.refreshAsync();
		const refreshed = observeRefreshes(registry)();

		// When
		await writeFile(skillPath, '---\n: invalid: [yaml\n---\n# Body', 'utf8');
		await withDeadline(refreshed, 'malformed skill refresh');

		// Then
		expect(registry.getSkill('alpha')?.description).toBe('stable');
		expect(logger.warn).toHaveBeenCalledWith(
			'Invalid skill discovery file',
			expect.objectContaining({ retainedLastKnownGood: true })
		);
	});

	it('reconciles real tool add, change, and unlink events without duplicates', async () => {
		// Given
		const toolDir = join(rootDir, 'tools');
		const toolPath = join(toolDir, 'search.tool.md');
		await mkdir(toolDir, { recursive: true });
		const registry = new ToolRegistry({ toolDirs: [toolDir] });
		await registry.discoverAsync();
		const watcher = new ToolWatcher(registry, undefined, [toolDir]);
		activeWatchers.push(watcher);
		await withDeadline(watcher.ready(), 'tool watcher readiness');
		const nextRefresh = observeRefreshes(registry);

		// When/Then: add
		let refreshed = nextRefresh();
		await writeFile(toolPath, toolDocument('search', 'first'), 'utf8');
		await withDeadline(refreshed, 'tool add refresh');
		expect(registry.getNames()).toEqual(['search']);

		// When/Then: change
		refreshed = nextRefresh();
		await writeFile(toolPath, toolDocument('search', 'updated'), 'utf8');
		await withDeadline(refreshed, 'tool change refresh');
		expect(registry.getTool('search')?.description).toBe('updated');
		expect(registry.size()).toBe(1);

		// When/Then: unlink
		refreshed = nextRefresh();
		await unlink(toolPath);
		await withDeadline(refreshed, 'tool unlink refresh');
		expect(registry.getNames()).toEqual([]);
	});

	it('joins an accepted refresh on stop and ignores later filesystem events', async () => {
		// Given
		const skillDir = join(rootDir, 'skills');
		await mkdir(skillDir, { recursive: true });
		const registry = new SkillRegistry({ skillDirs: [skillDir] });
		await registry.discoverAsync();
		let releaseRefresh: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const refreshStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const originalRefresh = registry.refreshAsync.bind(registry);
		const refreshSpy = vi.spyOn(registry, 'refreshAsync').mockImplementation(async () => {
			markStarted?.();
			await refreshGate;
			return originalRefresh();
		});
		const watcher = new SkillWatcher(registry, undefined, [skillDir]);
		activeWatchers.push(watcher);
		await withDeadline(watcher.ready(), 'stoppable watcher readiness');

		// When
		await writeFile(join(skillDir, 'before-stop.md'), skillDocument('before-stop', 'one'), 'utf8');
		await withDeadline(refreshStarted, 'pending refresh start');
		let stopCompleted = false;
		const stopping = watcher.stop().then(() => {
			stopCompleted = true;
		});
		await Promise.resolve();

		// Then
		expect(stopCompleted).toBe(false);
		releaseRefresh?.();
		await withDeadline(stopping, 'watcher stop');
		expect(registry.hasSkill('before-stop')).toBe(true);

		const observer = watch(skillDir, { ignoreInitial: true });
		await withDeadline(
			new Promise<void>((resolve) => observer.once('ready', resolve)),
			'observer ready'
		);
		const observedAdd = waitForEvent(observer, 'add');
		await writeFile(join(skillDir, 'after-stop.md'), skillDocument('after-stop', 'two'), 'utf8');
		await withDeadline(observedAdd, 'post-stop filesystem event');
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		await observer.close();
	});
});

async function waitForEvent(watcher: FSWatcher, event: 'add'): Promise<void> {
	await once(watcher, event);
}
