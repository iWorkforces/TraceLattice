/**
 * Base registry providing shared CRUD, caching, and discovery logic.
 *
 * This abstract generic class extracts the common patterns from `ToolRegistry`
 * and `SkillRegistry` into a single reusable base. Subclasses only need to
 * implement item-specific parsing, file filtering, and error construction.
 *
 * @template T - The registry item type (must have a `name` property)
 * @module registry
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DiscoveryCache } from '../cache/DiscoveryCache.js';
import { NullLogger } from '../logger/NullLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';
import { getErrorMessage } from '../errors.js';

/**
 * Configuration options for creating a `BaseRegistry` instance.
 */
export interface BaseRegistryOptions {
	/** Optional logger for diagnostics. */
	logger?: Logger;

	/** Optional cache for lookups. */
	cache?: DiscoveryCache<{ name: string }>;

	/**
	 * Directory paths to search for items.
	 */
	searchDirs?: string[];

	/**
	 * Enable lazy discovery (discover on first access instead of startup).
	 * @default false
	 */
	lazyDiscovery?: boolean;
}

/**
 * Abstract base registry for managing named items with discovery and caching.
 *
 * Provides shared CRUD operations, filesystem discovery with deduplication,
 * and optional LRU caching. Subclasses implement item-specific parsing logic
 * and error construction.
 *
 * @template T - The registry item type (must have a `name` property)
 */
export abstract class BaseRegistry<T extends { name: string }> {
	/** Internal storage for items indexed by name. */
	protected _items: Map<string, T>;
	private _manualItems: Map<string, T>;
	private _discoveredItemsByPath: Map<string, T>;

	/** Logger for diagnostics. */
	protected _logger: Logger;

	/** Optional cache for lookups. */
	protected _cache: DiscoveryCache<T>;

	/** Directory paths to search for items. */
	protected _searchDirs: string[];

	/** Whether discovery has been performed. */
	protected _discovered: boolean = false;

	/** Promise for in-progress discovery (null if not in progress). */
	protected _discoveryPromise: Promise<number> | null = null;
	private _refreshRequested = false;

	/** File extensions to match during discovery. */
	protected abstract readonly _fileExtensions: string[];

	/**
	 * Creates an error for invalid item data.
	 * @param reason - The reason for the validation failure
	 */
	protected abstract _createInvalidError(reason: string): Error;

	/**
	 * Creates an error for duplicate items.
	 * @param name - The name of the duplicate item
	 */
	protected abstract _createDuplicateError(name: string): Error;

	/**
	 * Creates an error for items not found.
	 * @param name - The name of the missing item
	 * @param action - The action that was attempted
	 */
	protected abstract _createNotFoundError(name: string, action: string): Error;

	/**
	 * Parses frontmatter content into a partial item.
	 * @param content - The file content to parse
	 * @returns A partial item, with an `_error` property if parsing failed
	 */
	protected abstract _parseFrontmatter(content: string): Partial<T> & { _error?: string };

	/**
	 * Determines whether a file should be skipped during discovery.
	 * @param fileName - The name of the file to check
	 * @returns true if the file should be skipped
	 */
	protected abstract _shouldSkipFile(fileName: string): boolean;

	/**
	 * Constructs a complete item from parsed frontmatter data.
	 * Returns null if the parsed data is insufficient.
	 * @param parsed - The parsed frontmatter data
	 * @returns A complete item, or null if data is insufficient
	 */
	protected abstract _buildItem(parsed: Partial<T>): T | null;

	/**
	 * The entity name used in log messages (e.g., 'tool', 'skill').
	 */
	protected abstract readonly _entityName: string;

	constructor(options: BaseRegistryOptions) {
		this._items = new Map();
		this._manualItems = new Map();
		this._discoveredItemsByPath = new Map();
		this._logger = (options.logger ?? new NullLogger()) as Logger;
		this._cache = (options.cache ||
			new DiscoveryCache<T>({ maxSize: 50, ttl: 300000 })) as DiscoveryCache<T>;
		this._searchDirs = (options.searchDirs ?? []) as string[];
	}

	/**
	 * Internal logging method.
	 * @param message - The message to log
	 * @param meta - Optional metadata
	 */
	protected log(message: string, meta?: Record<string, unknown>): void {
		this._logger.info(message, meta);
	}

	/**
	 * Adds an item to the registry.
	 *
	 * @param item - The item to add
	 * @throws If item already exists or name is invalid
	 */
	public add(item: T): void {
		if (!item.name) {
			throw this._createInvalidError(`${this._entityName} must have a valid name`);
		}
		if (this._items.has(item.name)) {
			throw this._createDuplicateError(item.name);
		}
		this._items.set(item.name, item);
		this._manualItems.set(item.name, item);
		this.log(`Added ${this._entityName}: ${item.name}`, { [`${this._entityName}Name`]: item.name });
		// Invalidate cache when adding a new item
		this._cache?.invalidate('all');
	}

	/**
	 * Removes an item from the registry.
	 *
	 * @param name - The name of the item to remove
	 * @throws If item not found
	 */
	public remove(name: string): void {
		if (!this._items.has(name)) {
			throw this._createNotFoundError(name, 'remove');
		}
		this._items.delete(name);
		this._manualItems.delete(name);
		for (const [filePath, item] of this._discoveredItemsByPath) {
			if (item.name === name) this._discoveredItemsByPath.delete(filePath);
		}
		this.log(`Removed ${this._entityName}: ${name}`, { [`${this._entityName}Name`]: name });
		// Invalidate cache when removing an item
		this._cache?.invalidate('all');
		this._cache?.invalidate(name);
	}

	/**
	 * Updates an existing item with partial data.
	 *
	 * @param name - The name of the item to update
	 * @param updates - Partial item data with fields to update
	 * @throws If item not found
	 */
	public update(name: string, updates: Partial<T>): void {
		if (!this._items.has(name)) {
			throw this._createNotFoundError(name, 'update');
		}
		const existing = this._items.get(name)!;
		const updated = { ...existing, ...updates };
		this._items.set(name, updated);
		if (this._manualItems.has(name)) this._manualItems.set(name, updated);
		for (const [filePath, item] of this._discoveredItemsByPath) {
			if (item.name === name) this._discoveredItemsByPath.set(filePath, updated);
		}
		this.log(`Updated ${this._entityName}: ${name}`, { [`${this._entityName}Name`]: name });
		// Invalidate cache when updating an item
		this._cache?.invalidate('all');
		this._cache?.invalidate(name);
	}

	/**
	 * Gets an item by name.
	 *
	 * @param name - The name of the item to get
	 * @returns The item if found, undefined otherwise
	 */
	public get(name: string): T | undefined {
		return this._items.get(name);
	}

	/**
	 * Gets all items as an array.
	 *
	 * Uses cache if available for performance.
	 *
	 * @returns An array of all registered items
	 */
	public getAll(): T[] {
		// Check cache first
		if (this._cache) {
			const cached = this._cache.get('all');
			if (cached) {
				return cached;
			}
		}
		// Get from storage
		const items = Array.from(this._items.values());
		// Cache the result
		this._cache?.set('all', items);
		return items;
	}

	/**
	 * Checks if an item exists in the registry.
	 *
	 * @param name - The name of the item to check
	 * @returns true if the item exists, false otherwise
	 */
	public has(name: string): boolean {
		return this._items.has(name);
	}

	/**
	 * Gets all item names as an array.
	 *
	 * @returns An array of item names
	 */
	public getNames(): string[] {
		return Array.from(this._items.keys());
	}

	/**
	 * Clears all items from the registry.
	 */
	public clear(): void {
		this._items.clear();
		this._manualItems.clear();
		this._discoveredItemsByPath.clear();
		this.log(`Cleared all ${this._entityName}s`);
		// Invalidate cache when clearing all items
		this._cache?.clear();
	}

	/**
	 * Gets the number of items in the registry.
	 *
	 * @returns The count of registered items
	 */
	public size(): number {
		return this._items.size;
	}

	/**
	 * Asynchronously discovers items from the configured directories.
	 *
	 * Multiple concurrent calls share the same discovery promise.
	 * Subsequent calls return cached results if discovery has already completed.
	 *
	 * @returns A Promise resolving to the number of items discovered
	 */
	public async discoverAsync(): Promise<number> {
		if (this._discoveryPromise) {
			return this._discoveryPromise;
		}

		if (this._discovered) {
			const cached = this._cache.get('all');
			return cached?.length ?? 0;
		}

		return this._beginDiscovery();
	}

	/**
	 * Re-scans configured directories and atomically reconciles discovered items.
	 *
	 * Calls made during an active scan share its promise and request at most one
	 * follow-up pass, ensuring an event that arrives mid-scan is not lost.
	 *
	 * @returns A Promise resolving to the number of discovered filesystem items
	 */
	public async refreshAsync(): Promise<number> {
		this._refreshRequested = true;
		return this._discoveryPromise ?? this._beginDiscovery();
	}

	private _beginDiscovery(): Promise<number> {
		const operation = this._runDiscoveryLoop();
		this._discoveryPromise = operation;
		const clearOperation = (): void => {
			if (this._discoveryPromise === operation) this._discoveryPromise = null;
		};
		operation.then(clearOperation, clearOperation);
		return operation;
	}

	private async _runDiscoveryLoop(): Promise<number> {
		this._refreshRequested = false;
		let count = await this._performDiscovery();
		while (this._refreshRequested) {
			this._refreshRequested = false;
			count = await this._performDiscovery();
		}
		return count;
	}

	/**
	 * Performs the actual discovery operation.
	 *
	 * Scans configured directories for item files, parses their frontmatter,
	 * and adds valid items to the registry.
	 *
	 * @returns A Promise resolving to the number of items discovered
	 */
	protected async _performDiscovery(): Promise<number> {
		const discoveredItems = new Map<string, T>();
		const claimedNames = new Set(this._manualItems.keys());

		for (const dir of this._searchDirs) {
			try {
				if (!existsSync(dir)) {
					continue;
				}

				const entries = await readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (this._shouldSkipFile(entry.name)) {
						continue;
					}

					if (entry.isFile() && this._fileExtensions.some((ext) => entry.name.endsWith(ext))) {
						const filePath = join(dir, entry.name);
						try {
							const content = await readFile(filePath, 'utf-8');
							const parsed = this._parseFrontmatter(content);
							if (parsed._error) {
								this._retainLastKnownGood(filePath, parsed._error, discoveredItems, claimedNames);
								continue;
							}
							if (parsed.name) {
								const item = this._buildItem(parsed);
								if (item && !claimedNames.has(item.name)) {
									discoveredItems.set(filePath, item);
									claimedNames.add(item.name);
								}
							}
						} catch (readError) {
							this._retainLastKnownGood(
								filePath,
								getErrorMessage(readError),
								discoveredItems,
								claimedNames
							);
						}
					}
				}
			} catch (error) {
				this._logger.warn(`Failed to scan ${this._entityName} directory`, {
					directory: dir,
					error: getErrorMessage(error),
				});
				this._retainDirectory(dir, discoveredItems, claimedNames);
			}
		}

		this._discoveredItemsByPath = discoveredItems;
		this._items = new Map(this._manualItems);
		for (const item of discoveredItems.values()) {
			if (!this._items.has(item.name)) this._items.set(item.name, item);
		}
		this._discovered = true;
		this._cache.clear();
		this._cache.set('all', Array.from(this._items.values()));
		this.log(`Discovery complete: found ${discoveredItems.size} ${this._entityName}s`, {
			discoveredCount: discoveredItems.size,
		});
		return discoveredItems.size;
	}

	private _retainLastKnownGood(
		filePath: string,
		reason: string,
		discoveredItems: Map<string, T>,
		claimedNames: Set<string>
	): void {
		const previous = this._discoveredItemsByPath.get(filePath);
		if (previous && !claimedNames.has(previous.name)) {
			discoveredItems.set(filePath, previous);
			claimedNames.add(previous.name);
		}
		this._logger.warn(`Invalid ${this._entityName} discovery file`, {
			filePath,
			reason,
			retainedLastKnownGood: previous !== undefined,
		});
	}

	private _retainDirectory(
		directory: string,
		discoveredItems: Map<string, T>,
		claimedNames: Set<string>
	): void {
		for (const [filePath, item] of this._discoveredItemsByPath) {
			if (dirname(filePath) === directory && !claimedNames.has(item.name)) {
				discoveredItems.set(filePath, item);
				claimedNames.add(item.name);
			}
		}
	}

	/**
	 * Parses YAML frontmatter from file content.
	 *
	 * This is a shared utility for subclasses that parse YAML frontmatter.
	 *
	 * @param content - The file content to parse
	 * @returns The parsed YAML object, or null if no frontmatter found
	 */
	protected _extractFrontmatter(content: string): Record<string, unknown> | null {
		const match = content.match(/^---\n([\s\S]+?)\n---/);
		if (!match) {
			return null;
		}
		return parseYaml(match[1]!) as Record<string, unknown>;
	}

	/**
	 * Sets items from an external source.
	 *
	 * Clears existing items and adds new ones from the provided array.
	 *
	 * @param items - Array of items from an external source
	 */
	public setAll(items: T[]): void {
		this.clear();
		for (const item of items) {
			try {
				this.add(item);
			} catch (error) {
				this.log(`Error adding ${this._entityName} '${item.name}':`, {
					[`${this._entityName}Name`]: item.name,
					error: getErrorMessage(error),
				});
			}
		}
		this.log(`Set ${items.length} ${this._entityName}s from external source`, {
			[`${this._entityName}Count`]: items.length,
		});
	}
}
