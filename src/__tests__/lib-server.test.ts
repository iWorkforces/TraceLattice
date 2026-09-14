import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolAwareSequentialThinkingServer, createServer, initializeServer } from '../lib.js';
import { Container } from '../di/Container.js';
import { ServerConfig } from '../ServerConfig.js';
import type { StructuredLogger } from '../logger/StructuredLogger.js';
import type { HistoryManager } from '../core/HistoryManager.js';
import type { ThoughtProcessor } from '../core/ThoughtProcessor.js';
import type { Metrics } from '../metrics/metrics.impl.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { SkillRegistry } from '../registry/SkillRegistry.js';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';

function createMockContainer() {
	const container = new Container();

	const mockLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		setLevel: vi.fn(),
		getLevel: vi.fn().mockReturnValue('info'),
	};

	const mockHistoryManager = {
		addThought: vi.fn(),
		getHistory: vi.fn().mockReturnValue([]),
		getHistoryLength: vi.fn().mockReturnValue(0),
		getBranches: vi.fn().mockReturnValue({}),
		getBranchIds: vi.fn().mockReturnValue([]),
		clear: vi.fn(),
		getAvailableMcpTools: vi.fn().mockReturnValue([]),
		getAvailableSkills: vi.fn().mockReturnValue([]),
		setEventEmitter: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		loadFromPersistence: vi.fn().mockResolvedValue(undefined),
	};

	const mockThoughtProcessor = {
		process: vi.fn().mockResolvedValue({
			content: [{ type: 'text', text: 'Processed thought' }],
		}),
	};

	const mockMetrics = {
		counter: vi.fn(),
		histogram: vi.fn(),
		gauge: vi.fn(),
		export: vi.fn().mockReturnValue('# Test metrics\n'),
	};

	const config = new ServerConfig({ maxHistorySize: 100 });

	const mockToolRegistry = {
		addTool: vi.fn(),
		getTool: vi.fn(),
		discoverAsync: vi.fn().mockResolvedValue(0),
	};

	const mockSkillRegistry = {
		discoverAsync: vi.fn().mockResolvedValue(0),
	};

	container.registerInstance('Logger', mockLogger as unknown as StructuredLogger);
	container.registerInstance('HistoryManager', mockHistoryManager as unknown as HistoryManager);
	container.registerInstance('ThoughtProcessor', mockThoughtProcessor as unknown as ThoughtProcessor);
	container.registerInstance('Metrics', mockMetrics as unknown as Metrics);
	container.registerInstance('Config', config);
	container.registerInstance('ToolRegistry', mockToolRegistry as unknown as ToolRegistry);
	container.registerInstance('SkillRegistry', mockSkillRegistry as unknown as SkillRegistry);
	container.registerInstance('Persistence', null);

	return {
		container,
		mockLogger,
		mockHistoryManager,
		mockThoughtProcessor,
		mockMetrics,
		config,
		mockToolRegistry,
		mockSkillRegistry,
	};
}

describe('ToolAwareSequentialThinkingServer', () => {
	let server: ToolAwareSequentialThinkingServer;
	let mocks: ReturnType<typeof createMockContainer>;

	beforeEach(() => {
		mocks = createMockContainer();
		server = new ToolAwareSequentialThinkingServer({
			container: mocks.container,
			autoDiscover: false,
		});
	});

	describe('constructor', () => {
		it('should create server with custom container', () => {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
			expect(server.history).toBeDefined();
			expect(server.tools).toBeDefined();
			expect(server.skills).toBeDefined();
			expect(server.config).toBeDefined();
		});

		it('should register sequential thinking tool', () => {
			expect(mocks.mockToolRegistry.addTool).toHaveBeenCalled();
		});

		it('should create watchers when enableWatcher is true', async () => {
			const serverWithWatchers = new ToolAwareSequentialThinkingServer({
				container: mocks.container,
				enableWatcher: true,
				autoDiscover: false,
			});
			try {
				expect(serverWithWatchers).toBeInstanceOf(ToolAwareSequentialThinkingServer);
			} finally {
				await serverWithWatchers.stop();
			}
		});

		it('should not create watchers when enableWatcher is false', () => {
			const serverNoWatchers = new ToolAwareSequentialThinkingServer({
				container: mocks.container,
				enableWatcher: false,
				autoDiscover: false,
			});
			expect(serverNoWatchers).toBeInstanceOf(ToolAwareSequentialThinkingServer);
		});
	});

	describe('getContainer', () => {
		it('should return the DI container', () => {
			const container = server.getContainer();
			expect(container).toBe(mocks.container);
		});
	});

	describe('processThought', () => {
		it('should process a thought and record metrics', async () => {
			const input = {
				thought: 'test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			};

			const result = await server.processThought(input);

			expect(mocks.mockThoughtProcessor.process).toHaveBeenCalled();
			expect(mocks.mockMetrics.histogram).toHaveBeenCalledWith(
				'thought_processing_duration_seconds',
				expect.any(Number),
				{}
			);
			expect(result).toBeDefined();
		});
	});

	describe('getMetricsSnapshot', () => {
		it('should export metrics', () => {
			const snapshot = server.getMetricsSnapshot();
			expect(snapshot).toBe('# Test metrics\n');
			expect(mocks.mockMetrics.export).toHaveBeenCalled();
		});
	});

	describe('getBranches', () => {
		it('should return branches from history manager', () => {
			mocks.mockHistoryManager.getBranches.mockReturnValue({ 'branch-1': [] });
			const branches = server.getBranches();
			expect(branches).toEqual({ 'branch-1': [] });
		});
	});

	describe('discoverSkillsAsync', () => {
		it('should discover skills', async () => {
			mocks.mockSkillRegistry.discoverAsync.mockResolvedValue(5);
			const count = await server.discoverSkillsAsync();
			expect(count).toBe(5);
		});
	});

	describe('clear', () => {
		it('should clear history', () => {
			server.clear();
			expect(mocks.mockHistoryManager.clear).toHaveBeenCalled();
		});
	});

	describe('stop', () => {
		it('should stop server and flush persistence', async () => {
			await server.stop();
			expect(mocks.mockHistoryManager.shutdown).toHaveBeenCalled();
		});

		it('should surface shutdown errors after cleanup', async () => {
			const failure = new Error('Flush failed');
			mocks.mockHistoryManager.shutdown.mockRejectedValue(failure);
			await expect(server.stop()).rejects.toMatchObject({ errors: [failure] });
			expect(mocks.mockLogger.error).toHaveBeenCalled();
		});

		it('should close persistence if available', async () => {
			const mockPersistence = { close: vi.fn().mockResolvedValue(undefined) };
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', mockPersistence as unknown as PersistenceBackend);

			await server.stop();
			expect(mockPersistence.close).toHaveBeenCalled();
		});

		it('should surface persistence close errors', async () => {
			const failure = new Error('Close failed');
			const mockPersistence = { close: vi.fn().mockRejectedValue(failure) };
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', mockPersistence as unknown as PersistenceBackend);

			await expect(server.stop()).rejects.toMatchObject({ errors: [failure] });
			expect(mocks.mockLogger.error).toHaveBeenCalled();
		});

		it('should handle null persistence', async () => {
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', null);
			await expect(server.stop()).resolves.toBeUndefined();
		});
	});

	describe('dispose', () => {
		it('should stop server and dispose container', async () => {
			await server.dispose();
			expect(mocks.mockHistoryManager.shutdown).toHaveBeenCalled();
		});
	});

	describe('events', () => {
		it('should emit and receive persistenceError events', () => {
			const handler = vi.fn();
			server.on('persistenceError', handler);
			server.emit('persistenceError', { operation: 'save', error: new Error('test') });
			expect(handler).toHaveBeenCalledWith({
				operation: 'save',
				error: expect.any(Error),
			});
		});

		it('should emit and receive discoveryError events', () => {
			const handler = vi.fn();
			server.on('discoveryError', handler);
			server.emit('discoveryError', { directory: '/skills', error: new Error('test') });
			expect(handler).toHaveBeenCalledWith({
				directory: '/skills',
				error: expect.any(Error),
			});
		});

		it('should emit and receive transportError events', () => {
			const handler = vi.fn();
			server.on('transportError', handler);
			server.emit('transportError', { transport: 'http', error: new Error('test') });
			expect(handler).toHaveBeenCalled();
		});

		it('should emit and receive thoughtProcessed events', () => {
			const handler = vi.fn();
			server.on('thoughtProcessed', handler);
			server.emit('thoughtProcessed', { thoughtNumber: 1, duration: 100 });
			expect(handler).toHaveBeenCalledWith({ thoughtNumber: 1, duration: 100 });
		});
	});
});

describe('createServer', () => {
	it('should create a server with async initialization', async () => {
		const server = await createServer({ autoDiscover: false, loadFromPersistence: false });
		try {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
			expect(server.getContainer()).toBeDefined();
		} finally {
			await server.stop();
		}
	});

	it('should create server with all options disabled', async () => {
		const server = await createServer({
			autoDiscover: false,
			loadFromPersistence: false,
			lazyDiscovery: true,
		});
		try {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
		} finally {
			await server.stop();
		}
	});

	it('should load from persistence when enabled', async () => {
		const server = await createServer({
			autoDiscover: false,
			loadFromPersistence: true,
		});
		try {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
		} finally {
			await server.stop();
		}
	});
});

describe('initializeServer', () => {
	it('should create and return a server', async () => {
		const server = await initializeServer();
		try {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
		} finally {
			await server.stop();
		}
	});
});

describe('lib.ts — uncovered branches', () => {
	describe('constructor without container (lines 246-264)', () => {
		it('should throw when no container is provided', () => {
			expect(
				() =>
					new ToolAwareSequentialThinkingServer({
						autoDiscover: false,
						enableWatcher: false,
					}),
			).toThrow('Container is required. Use createServer() or provide a container.');
		});

		it('should throw when no container is provided even with custom logger', async () => {
			const customLogger = new (await import('../logger/StructuredLogger.js')).StructuredLogger({
				context: 'CustomTest',
				pretty: false,
				level: 'warn',
			});
			expect(
				() =>
					new ToolAwareSequentialThinkingServer({
						autoDiscover: false,
						enableWatcher: false,
						logger: customLogger,
					}),
			).toThrow('Container is required. Use createServer() or provide a container.');
		});
	});

	describe('stop() non-Error branches (lines 389, 401)', () => {
		it('should surface a non-Error thrown during shutdown flush', async () => {
			const mocks = createMockContainer();
			mocks.mockHistoryManager.shutdown.mockRejectedValue('raw string error');
			const server = new ToolAwareSequentialThinkingServer({
				container: mocks.container,
				autoDiscover: false,
			});

			await expect(server.stop()).rejects.toMatchObject({ errors: ['raw string error'] });
			expect(mocks.mockLogger.error).toHaveBeenCalledWith(
				'Error flushing write buffer during shutdown',
				expect.objectContaining({ error: 'raw string error' })
			);
		});

		it('should surface a non-Error thrown during persistence close', async () => {
			const mocks = createMockContainer();
			const mockPersistence = { close: vi.fn().mockRejectedValue(42) };
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', mockPersistence as unknown as PersistenceBackend);
			const server = new ToolAwareSequentialThinkingServer({
				container: mocks.container,
				autoDiscover: false,
			});

			await expect(server.stop()).rejects.toMatchObject({ errors: [42] });
			expect(mocks.mockLogger.error).toHaveBeenCalledWith(
				'Error closing persistence backend',
				expect.objectContaining({ error: '42' })
			);
		});
	});
});
