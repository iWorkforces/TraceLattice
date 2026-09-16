import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../config/ConfigLoader.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { Container } from '../../di/Container.js';
import { ConfigurationError, PersistenceUnavailableError } from '../../errors.js';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { asSessionId } from '../../contracts/ids.js';
import { SkillRegistry } from '../../registry/SkillRegistry.js';
import { ServerConfig } from '../../ServerConfig.js';
import { SkillWatcher } from '../../watchers/SkillWatcher.js';
import { ToolWatcher } from '../../watchers/ToolWatcher.js';

const temporaryDirectories = new Set<string>();

function delayWatcherStops(
	skillGate: PromiseWithResolvers<void>,
	toolGate: PromiseWithResolvers<void>
): {
	readonly skillStop: ReturnType<typeof vi.spyOn>;
	readonly toolStop: ReturnType<typeof vi.spyOn>;
	readonly pendingStops: Promise<void>[];
} {
	const originalSkillStop = SkillWatcher.prototype.stop;
	const originalToolStop = ToolWatcher.prototype.stop;
	const pendingStops: Promise<void>[] = [];
	const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop').mockImplementation(function (
		this: SkillWatcher
	) {
		const pending = Promise.all([originalSkillStop.call(this), skillGate.promise]).then(
			() => undefined
		);
		pendingStops.push(pending);
		return pending;
	});
	const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop').mockImplementation(function (
		this: ToolWatcher
	) {
		const pending = Promise.all([originalToolStop.call(this), toolGate.promise]).then(
			() => undefined
		);
		pendingStops.push(pending);
		return pending;
	});
	return { skillStop, toolStop, pendingStops };
}

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories) {
		await rm(directory, { recursive: true, force: true });
	}
	temporaryDirectories.clear();
});

describe('configuration startup resource safety', () => {
	it('T10-L01 rejects unhealthy restore and closes the backend before becoming ready', async () => {
		// Given
		const unhealthy = vi.spyOn(MemoryPersistence.prototype, 'healthy').mockResolvedValue(false);
		const close = vi.spyOn(MemoryPersistence.prototype, 'close');
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false });

		// Then
		await expect(creation).rejects.toBeInstanceOf(PersistenceUnavailableError);
		expect(unhealthy).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('T10-L02 propagates restore reads and closes the backend before becoming ready', async () => {
		// Given
		const failure = new Error('injected list failure');
		vi.spyOn(MemoryPersistence.prototype, 'listSessions').mockRejectedValue(failure);
		const close = vi.spyOn(MemoryPersistence.prototype, 'close');
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false });

		// Then
		await expect(creation).rejects.toBe(failure);
		expect(close).toHaveBeenCalledOnce();
	});

	it('T10-L03 propagates a thrown health check and closes the backend', async () => {
		// Given
		const failure = new Error('injected health failure');
		vi.spyOn(MemoryPersistence.prototype, 'healthy').mockRejectedValue(failure);
		const close = vi.spyOn(MemoryPersistence.prototype, 'close');
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false });

		// Then
		await expect(creation).rejects.toBe(failure);
		expect(close).toHaveBeenCalledOnce();
	});

	it('T10-L04 propagates a partition load failure and closes the backend', async () => {
		// Given
		const failure = new Error('injected partition load failure');
		vi.spyOn(MemoryPersistence.prototype, 'listSessions').mockResolvedValue([
			asSessionId('restore-session'),
		]);
		vi.spyOn(MemoryPersistence.prototype, 'loadHistoryForSession').mockRejectedValue(failure);
		const close = vi.spyOn(MemoryPersistence.prototype, 'close');
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false });

		// Then
		await expect(creation).rejects.toBe(failure);
		expect(close).toHaveBeenCalledOnce();
	});
	it.each([
		['bogus strategy', 'TRACELATTICE_FEATURES_REASONING_STRATEGY', 'bogus'],
		['trailing numeric garbage', 'TRACELATTICE_TOOL_INTERLEAVE_TTL_MS', '1234garbage'],
	])('rejects %s before acquiring resources', async (_caseName, environmentName, value) => {
		// Given
		vi.useFakeTimers();
		vi.stubEnv(environmentName, value);
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-invalid-env-'));
		temporaryDirectories.add(root);
		const dataDir = join(root, 'backend');
		const startSpy = vi.spyOn(InMemorySuspensionStore.prototype, 'start');
		let server: ToolAwareSequentialThinkingServer | undefined;
		let failure: unknown;

		// When
		try {
			server = await createServer({
				fileConfig: {
					persistence: { enabled: true, backend: 'file', options: { dataDir } },
					features: { toolInterleave: true },
				},
				autoDiscover: false,
				loadFromPersistence: false,
			});
		} catch (error) {
			failure = error;
		}
		if (server) await server.dispose();

		// Then
		expect(failure).toBeInstanceOf(ConfigurationError);
		expect(existsSync(dataDir)).toBe(false);
		expect(startSpy).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('closes an acquired backend once when container construction fails', async () => {
		// Given
		const closeSpy = vi.spyOn(MemoryPersistence.prototype, 'close');
		vi.spyOn(Container.prototype, 'registerInstance').mockImplementationOnce(() => {
			throw new Error('injected container construction failure');
		});
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false, loadFromPersistence: false });

		// Then
		await expect(creation).rejects.toThrow('injected container construction failure');
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it('preserves construction and backend-close failures together', async () => {
		const constructionFailure = new Error('injected container construction failure');
		const closeFailure = new Error('injected backend close failure');
		const closeSpy = vi.spyOn(MemoryPersistence.prototype, 'close').mockRejectedValue(closeFailure);
		vi.spyOn(Container.prototype, 'registerInstance').mockImplementationOnce(() => {
			throw constructionFailure;
		});
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		const outcome = await createServer({
			config,
			autoDiscover: false,
			loadFromPersistence: false,
		}).then(
			(value) => ({ kind: 'resolved' as const, value }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);

		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected') throw new TypeError('Expected server construction to reject');
		expect(outcome.error).toBeInstanceOf(AggregateError);
		if (!(outcome.error instanceof AggregateError)) {
			throw new TypeError('Expected aggregate construction failure');
		}
		expect(outcome.error.cause).toBe(constructionFailure);
		expect(outcome.error.errors).toEqual([constructionFailure, closeFailure]);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it('does not load or warn about environment when explicit config is provided', async () => {
		// Given
		const config = new ServerConfig({ features: { toolInterleave: false } });
		vi.stubEnv('TRACELATTICE_FEATURES_REASONING_STRATEGY', 'bogus');
		const loadSpy = vi.spyOn(ConfigLoader.prototype, 'load');
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		// When
		const server = await createServer({ config, autoDiscover: false, loadFromPersistence: false });
		await server.dispose();

		// Then
		expect(loadSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe('watcher cleanup ownership', () => {
	it('joins one successful cleanup across repeated stop calls', async () => {
		const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop');
		const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop');
		const server = await createServer({
			config: new ServerConfig({
				persistence: { enabled: true, backend: 'memory' },
				features: { toolInterleave: true },
			}),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const suspensionStop = vi.spyOn(server.getContainer().resolve('suspensionStore'), 'stop');
		const historyShutdown = vi.spyOn(server.history, 'shutdownWithinLifecycle');
		const persistence = server.getContainer().resolve('Persistence');
		if (persistence === null) throw new TypeError('Expected configured memory persistence');
		const persistenceClose = vi.spyOn(persistence, 'close');

		const firstStop = server.stop();
		const secondStop = server.stop();
		expect(secondStop).toBe(firstStop);
		await Promise.all([firstStop, secondStop]);
		await server.dispose();

		expect(skillStop).toHaveBeenCalledOnce();
		expect(toolStop).toHaveBeenCalledOnce();
		expect(suspensionStop).toHaveBeenCalledOnce();
		expect(historyShutdown).toHaveBeenCalledOnce();
		expect(persistenceClose).toHaveBeenCalledOnce();
	});

	it('joins one watcher cleanup across concurrent dispose calls', async () => {
		// Given
		const skillGate = Promise.withResolvers<void>();
		const toolGate = Promise.withResolvers<void>();
		const { skillStop, toolStop, pendingStops } = delayWatcherStops(skillGate, toolGate);
		const server = await createServer({
			config: new ServerConfig({ features: { toolInterleave: false } }),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		let settled = false;

		// When
		const disposal = Promise.all([server.dispose(), server.dispose()]).then(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const settledBeforeRelease = settled;
		const skillStopCalls = skillStop.mock.calls.length;
		const toolStopCalls = toolStop.mock.calls.length;
		skillGate.resolve();
		toolGate.resolve();
		await disposal;
		await Promise.all(pendingStops);

		// Then
		expect(settledBeforeRelease).toBe(false);
		expect(skillStopCalls).toBe(1);
		expect(toolStopCalls).toBe(1);
	});

	it('surfaces watcher failures after attempting every stop cleanup once', async () => {
		const skillFailure = new Error('injected skill watcher stop failure');
		const toolFailure = new Error('injected tool watcher stop failure');
		const originalSkillStop = SkillWatcher.prototype.stop;
		const originalToolStop = ToolWatcher.prototype.stop;
		const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop').mockImplementation(async function (
			this: SkillWatcher
		) {
			await originalSkillStop.call(this);
			throw skillFailure;
		});
		const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop').mockImplementation(async function (
			this: ToolWatcher
		) {
			await originalToolStop.call(this);
			throw toolFailure;
		});
		const server = await createServer({
			config: new ServerConfig({
				persistence: { enabled: true, backend: 'memory' },
				features: { toolInterleave: true },
			}),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const suspensionStop = vi.spyOn(server.getContainer().resolve('suspensionStore'), 'stop');
		const historyShutdown = vi.spyOn(server.history, 'shutdownWithinLifecycle');
		const persistence = server.getContainer().resolve('Persistence');
		if (persistence === null) throw new TypeError('Expected configured memory persistence');
		const persistenceClose = vi.spyOn(persistence, 'close');

		const firstStop = server.stop();
		const secondStop = server.stop();
		const outcome = await firstStop.then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);
		await server.getContainer().dispose();

		expect(secondStop).toBe(firstStop);
		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected') throw new TypeError('Expected stop to reject');
		expect(outcome.error).toBeInstanceOf(AggregateError);
		if (!(outcome.error instanceof AggregateError)) {
			throw new TypeError('Expected aggregate stop failure');
		}
		expect(outcome.error.errors).toEqual([skillFailure, toolFailure]);
		expect(skillStop).toHaveBeenCalledOnce();
		expect(toolStop).toHaveBeenCalledOnce();
		expect(suspensionStop).toHaveBeenCalledOnce();
		expect(historyShutdown).toHaveBeenCalledOnce();
		expect(persistenceClose).toHaveBeenCalledOnce();
	});

	it('joins watcher cleanup before startup failure rejects', async () => {
		// Given
		const skillGate = Promise.withResolvers<void>();
		const toolGate = Promise.withResolvers<void>();
		const { pendingStops } = delayWatcherStops(skillGate, toolGate);
		vi.spyOn(SkillRegistry.prototype, 'discoverAsync').mockRejectedValue(
			new Error('injected discovery failure')
		);
		let settled = false;

		// When
		const creation = createServer({
			config: new ServerConfig({ features: { toolInterleave: false } }),
			enableWatcher: true,
			autoDiscover: true,
			loadFromPersistence: false,
		})
			.then(
				(value) => ({ kind: 'resolved' as const, value }),
				(error: unknown) => ({ kind: 'rejected' as const, error })
			)
			.finally(() => {
				settled = true;
			});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const settledBeforeRelease = settled;
		skillGate.resolve();
		toolGate.resolve();
		const outcome = await creation;
		await Promise.all(pendingStops);

		// Then
		expect(settledBeforeRelease).toBe(false);
		expect(outcome).toMatchObject({
			kind: 'rejected',
			error: expect.objectContaining({ message: 'injected discovery failure' }),
		});
	});
});
