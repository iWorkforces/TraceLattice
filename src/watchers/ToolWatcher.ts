import { watch, type FSWatcher } from 'chokidar';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';

/** Watches tool discovery directories and serializes registry refreshes. */
export class ToolWatcher {
	private _watcher: FSWatcher | null = null;
	private readonly _logger: Logger;
	private readonly _readyPromise: Promise<void>;
	private _pendingRefresh: Promise<void> | null = null;
	private _refreshQueued = false;
	private _stopped = false;
	private _stopPromise: Promise<void> | null = null;

	constructor(
		private readonly _toolRegistry: ToolRegistry,
		logger?: Logger,
		watchDirs: readonly string[] = ['.claude/tools', join(homedir(), '.claude/tools')]
	) {
		this._logger = logger ?? this._createNoopLogger();
		this._readyPromise = this._setupWatcher(watchDirs);
	}

	private _createNoopLogger(): Logger {
		return {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
			setLevel: () => {},
			getLevel: () => 'info',
		};
	}

	private _setupWatcher(watchDirs: readonly string[]): Promise<void> {
		const watcher = watch([...watchDirs], {
			ignored: [/node_modules/, /\.DS_Store$/],
			persistent: true,
		});
		this._watcher = watcher;
		watcher.on('add', (path) => this._handleEvent(path));
		watcher.on('change', (path) => this._handleEvent(path));
		watcher.on('unlink', (path) => this._handleEvent(path));
		return new Promise((resolve) => watcher.on('ready', () => resolve()));
	}

	private _handleEvent(path: string): Promise<void> {
		if (this._stopped || !path.endsWith('.tool.md')) return Promise.resolve();
		return this._scheduleRefresh(path);
	}

	private _scheduleRefresh(path: string): Promise<void> {
		this._refreshQueued = true;
		if (!this._pendingRefresh) {
			this._pendingRefresh = this._drainRefreshes(path).finally(() => {
				this._pendingRefresh = null;
			});
		}
		return this._pendingRefresh;
	}

	private async _drainRefreshes(path: string): Promise<void> {
		while (this._refreshQueued) {
			this._refreshQueued = false;
			try {
				await this._toolRegistry.refreshAsync();
			} catch (error) {
				this._logger.error('Tool discovery refresh failed', {
					path,
					error: getErrorMessage(error),
				});
			}
		}
	}

	/** Resolves when Chokidar has completed its initial scan. */
	public ready(): Promise<void> {
		return this._readyPromise;
	}

	/** Closes Chokidar and joins any refresh accepted before shutdown. */
	public stop(): Promise<void> {
		if (this._stopPromise) return this._stopPromise;
		this._stopped = true;
		const watcher = this._watcher;
		const pendingRefresh = this._pendingRefresh;
		this._watcher = null;
		this._stopPromise = Promise.all([watcher?.close(), pendingRefresh]).then(() => undefined);
		return this._stopPromise;
	}
}
