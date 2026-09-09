import type { FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WatcherEventHandler = (path: string) => Promise<void> | void;
let eventHandlers: Map<string, WatcherEventHandler>;
let mockWatcher: {
	on: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
};

vi.mock('chokidar', () => ({
	watch: vi.fn(() => {
		eventHandlers = new Map();
		mockWatcher = {
			on: vi.fn((event: string, handler: WatcherEventHandler) => {
				eventHandlers.set(event, handler);
				return mockWatcher;
			}),
			close: vi.fn().mockResolvedValue(undefined),
		};
		return mockWatcher as unknown as FSWatcher;
	}),
}));

vi.mock('node:os', () => ({ homedir: () => '/mock/home' }));

import { watch } from 'chokidar';
import type { Logger, LogLevel } from '../logger/StructuredLogger.js';
import { ToolRegistry } from '../registry/ToolRegistry.js';
import { ToolWatcher } from '../watchers/ToolWatcher.js';

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

function handler(event: string): WatcherEventHandler {
	const registered = eventHandlers.get(event);
	if (!registered) throw new Error(`Missing ${event} handler`);
	return registered;
}

describe('ToolWatcher', () => {
	let registry: ToolRegistry;
	let logger: Logger;
	let refresh: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ToolRegistry({ toolDirs: [] });
		refresh = vi.spyOn(registry, 'refreshAsync').mockResolvedValue(0);
		logger = createLogger();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('watches default directories and all reconciliation events', async () => {
		// Given/When
		const watcher = new ToolWatcher(registry, logger);

		// Then
		expect(watch).toHaveBeenCalledWith(
			['.claude/tools', '/mock/home/.claude/tools'],
			expect.objectContaining({ persistent: true })
		);
		expect(mockWatcher.on).toHaveBeenCalledWith('add', expect.any(Function));
		expect(mockWatcher.on).toHaveBeenCalledWith('change', expect.any(Function));
		expect(mockWatcher.on).toHaveBeenCalledWith('unlink', expect.any(Function));
		await watcher.stop();
	});

	it('resolves ready after Chokidar signals readiness', async () => {
		// Given
		const watcher = new ToolWatcher(registry, logger);
		const readiness = watcher.ready();

		// When
		handler('ready')('');

		// Then
		await expect(readiness).resolves.toBeUndefined();
		await watcher.stop();
	});

	it.each(['add', 'change', 'unlink'])('refreshes the registry on tool %s', async (event) => {
		// Given
		const watcher = new ToolWatcher(registry, logger);

		// When
		await handler(event)('/tools/example.tool.md');

		// Then
		expect(refresh).toHaveBeenCalledTimes(1);
		await watcher.stop();
	});

	it.each(['add', 'change', 'unlink'])('ignores non-tool %s events', async (event) => {
		// Given
		const watcher = new ToolWatcher(registry, logger);

		// When
		await handler(event)('/tools/readme.md');

		// Then
		expect(refresh).not.toHaveBeenCalled();
		await watcher.stop();
	});

	it('coalesces duplicate events while preserving one trailing refresh', async () => {
		// Given
		let release: (() => void) | undefined;
		const gate = new Promise<number>((resolve) => {
			release = () => resolve(1);
		});
		refresh.mockImplementationOnce(() => gate).mockResolvedValue(1);
		const watcher = new ToolWatcher(registry, logger);

		// When
		const events = [
			handler('add')('/tools/example.tool.md'),
			handler('change')('/tools/example.tool.md'),
			handler('change')('/tools/example.tool.md'),
		];
		expect(refresh).toHaveBeenCalledTimes(1);
		release?.();
		await Promise.all(events);

		// Then
		expect(refresh).toHaveBeenCalledTimes(2);
		await watcher.stop();
	});

	it('reports refresh failures without rejecting the event callback', async () => {
		// Given
		refresh.mockRejectedValue('refresh failed');
		const watcher = new ToolWatcher(registry, logger);

		// When
		await expect(handler('add')('/tools/example.tool.md')).resolves.toBeUndefined();

		// Then
		expect(logger.error).toHaveBeenCalledWith('Tool discovery refresh failed', {
			path: '/tools/example.tool.md',
			error: 'refresh failed',
		});
		await watcher.stop();
	});

	it('joins a pending refresh and ignores events after stop begins', async () => {
		// Given
		let release: (() => void) | undefined;
		const gate = new Promise<number>((resolve) => {
			release = () => resolve(1);
		});
		refresh.mockImplementationOnce(() => gate);
		const watcher = new ToolWatcher(registry, logger);
		const event = handler('add')('/tools/example.tool.md');

		// When
		let stopped = false;
		const stopping = watcher.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		await handler('unlink')('/tools/ignored.tool.md');
		release?.();
		await Promise.all([event, stopping]);

		// Then
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(mockWatcher.close).toHaveBeenCalledTimes(1);
		await watcher.stop();
		expect(mockWatcher.close).toHaveBeenCalledTimes(1);
	});
});
