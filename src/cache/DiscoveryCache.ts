import type { IMetrics } from '../contracts/interfaces.js';

/**
 * LRU Cache for tool/skill discovery results with TTL support.
 *
 * This module provides a generic Least Recently Used (LRU) cache with time-to-live
 * (TTL) support. It's designed to cache discovery results to avoid repeated expensive
 * operations like filesystem scanning.
 *
 * @module cache
 */

/**
 * A cache entry containing data and metadata for LRU tracking.
 *
 * @template T - The type of data being cached (typically Tool or Skill)
 *
 * @example
 * ```typescript
 * const entry: CacheEntry<string> = {
 *   data: ['tool1', 'tool2'],
 *   timestamp: 1705550000000,
 *   accessCount: 5
 * };
 * ```
 */
export interface CacheEntry<T> {
	/** The cached data array. */
	data: readonly T[];

	/** Unix timestamp (milliseconds) when the entry was created/last accessed. */
	timestamp: number;

	/** Number of times this entry has been accessed (for LRU tracking). */
	accessCount: number;
}

/**
 * Configuration options for creating a `DiscoveryCache` instance.
 *
 * @example
 * ```typescript
 * const options: DiscoveryCacheOptions = {
 *   maxSize: 200,
 *   ttl: 600000  // 10 minutes
 * };
 * ```
 */
export interface DiscoveryCacheOptions {
	/**
	 * Maximum number of cache entries before LRU eviction begins.
	 * @default 100
	 */
	maxSize?: number;

	/**
	 * Time-to-live for cache entries in milliseconds.
	 * Entries older than this are considered expired.
	 * @default 300000 (5 minutes)
	 */
	ttl?: number;

	cleanupInterval?: number;
	metrics?: IMetrics;
}

/**
 * LRU (Least Recently Used) cache with TTL support for caching discovery results.
 *
 * This cache implements an LRU eviction policy where entries that haven't been
 * accessed recently are removed first when the cache reaches maximum capacity.
 * Additionally, entries expire after a configurable TTL period.
 *
 * @remarks
 * **Eviction Policy:**
 * - When `maxSize` is reached, the least recently used entry is removed
 * - An entry's "recent use" is tracked by its position in the underlying Map
 * - Accessing an entry moves it to the "most recently used" position
 * - Setting an existing key also updates its position
 *
 * **Expiration:**
 * - Entries older than `ttl` milliseconds are automatically removed on access
 * - Expiration is checked lazily (when `get()` or `has()` is called)
 *
 * **Thread Safety:**
 * - This implementation is not thread-safe and should not be shared
 *   across asynchronous operations without proper synchronization
 *
 * @template T - The type of data being cached
 *
 * @example
 * ```typescript
 * const cache = new DiscoveryCache<string>({
 *   maxSize: 100,
 *   ttl: 300000  // 5 minutes
 * });
 *
 * // Store discovery results
 * cache.set('.claude/skills', ['commit', 'pdf', 'test']);
 *
 * // Retrieve from cache
 * const skills = cache.get('.claude/skills');
 * if (skills) {
 *   console.log('Cached skills:', skills);
 * } else {
 *   console.log('Not cached or expired');
 * }
 *
 * // Check if cached and valid
 * if (cache.has('.claude/skills')) {
 *   console.log('Skills are cached and fresh');
 * }
 *
 * // Manually invalidate
 * cache.invalidate('.claude/skills');
 *
 * // Clear all cache
 * cache.clear();
 *
 * // Get statistics
 * const stats = cache.getStats();
 * console.log(`Cache size: ${stats.size}, keys: ${stats.keys.join(', ')}`);
 * ```
 */
export class DiscoveryCache<T> {
	/** Internal Map storing cache entries. Insertion order tracks LRU status. */
	private _cache: Map<string, CacheEntry<T>>;

	/** Maximum number of entries before eviction begins. */
	private _maxSize: number;

	/** Time-to-live in milliseconds for cache entries. */
	private _ttl: number;
	private _metrics?: IMetrics;
	private _cleanupTimer: NodeJS.Timeout | null = null;

	/**
	 * Creates a new DiscoveryCache instance.
	 *
	 * @param options - Configuration options for the cache
	 *
	 * @example
	 * ```typescript
	 * // Default configuration (100 entries, 5 minute TTL)
	 * const cache1 = new DiscoveryCache();
	 *
	 * // Custom configuration
	 * const cache2 = new DiscoveryCache({
	 *   maxSize: 200,
	 *   ttl: 600000  // 10 minutes
	 * });
	 * ```
	 */
	constructor(options: DiscoveryCacheOptions = {}) {
		this._cache = new Map();
		this._maxSize = options.maxSize ?? 100;
		this._ttl = options.ttl ?? 300000; // 5 minutes default
		this._metrics = options.metrics;

		if (options.cleanupInterval && options.cleanupInterval > 0) {
			this._cleanupTimer = setInterval(() => {
				this._cleanupExpired();
			}, options.cleanupInterval);
			if (this._cleanupTimer.unref) this._cleanupTimer.unref();
		}
	}

	private _cleanupExpired(): void {
		const now = Date.now();
		for (const [key, entry] of this._cache.entries()) {
			const age = now - entry.timestamp;
			if (age > this._ttl) {
				this._cache.delete(key);
				this._metrics?.counter('cache_eviction_total', 1, { cause: 'ttl_cleanup' });
			}
		}
	}

	/**
	 * Retrieves a value from the cache by key.
	 *
	 * Returns the cached data if the key exists and the entry hasn't expired.
	 * Updates the entry's access time and moves it to the most-recently-used position.
	 * Returns null if the key doesn't exist or the entry has expired (expired entries
	 * are automatically deleted).
	 *
	 * @param key - The cache key to retrieve
	 * @returns The cached data array, or null if not found or expired
	 *
	 * @example
	 * ```typescript
	 * const tools = cache.get('/path/to/tools');
	 * if (tools) {
	 *   console.log('Found cached tools:', tools);
	 * } else {
	 *   console.log('Tools not cached or expired, need to discover');
	 * }
	 * ```
	 */
	get(key: string): T[] | null {
		const entry = this._cache.get(key);
		if (!entry) {
			this._metrics?.counter('cache_miss_total', 1, {}, 'Total discovery cache misses');
			return null;
		}

		const now = Date.now();
		const age = now - entry.timestamp;

		// Check TTL
		if (age > this._ttl) {
			this._cache.delete(key);
			this._metrics?.counter('cache_eviction_total', 1, { cause: 'ttl' }, 'Total cache evictions');
			this._metrics?.counter('cache_miss_total', 1, {}, 'Total discovery cache misses');
			return null;
		}

		// Update access metadata for LRU
		entry.accessCount++;
		entry.timestamp = now;

		// Move to end (most recently used)
		this._cache.delete(key);
		this._cache.set(key, entry);
		this._metrics?.counter('cache_hit_total', 1, {}, 'Total discovery cache hits');

		return [...entry.data];
	}

	/**
	 * Stores a value in the cache with the given key.
	 *
	 * If the cache is at maximum capacity and this is a new key, the least
	 * recently used entry is evicted before storing the new value. If the key
	 * already exists, its value and access time are updated.
	 *
	 * @param key - The cache key to store under
	 * @param data - The data array to cache
	 *
	 * @example
	 * ```typescript
	 * const discoveredTools = ['Read', 'Write', 'Bash', 'Grep'];
	 * cache.set('/usr/local/tools', discoveredTools);
	 * ```
	 */
	set(key: string, data: readonly T[]): void {
		// Enforce max size with LRU eviction
		if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
			// Remove least recently used (first entry)
			const lruKey = this._cache.keys().next().value;
			if (lruKey) {
				this._cache.delete(lruKey);
				this._metrics?.counter(
					'cache_eviction_total',
					1,
					{ cause: 'lru' },
					'Total cache evictions'
				);
			}
		}

		this._cache.set(key, {
			data: [...data],
			timestamp: Date.now(),
			accessCount: 0,
		});
	}

	/**
	 * Checks if a key exists in the cache and hasn't expired.
	 *
	 * Returns true only if the key exists and the entry is within its TTL.
	 * Expired entries are not automatically removed by this method (use `get()`
	 * for automatic expiration cleanup).
	 *
	 * @param key - The cache key to check
	 * @returns true if the key exists and hasn't expired, false otherwise
	 *
	 * @example
	 * ```typescript
	 * if (cache.has('/path/to/skills')) {
	 *   // Key exists and is fresh
	 *   const skills = cache.get('/path/to/skills')!;
	 * } else {
	 *   // Need to discover skills
	 * }
	 * ```
	 */
	has(key: string): boolean {
		const entry = this._cache.get(key);
		if (!entry) return false;

		const age = Date.now() - entry.timestamp;
		return age <= this._ttl;
	}

	/**
	 * Removes a specific entry from the cache.
	 *
	 * This is useful for explicit invalidation when cached data is known
	 * to be stale due to external changes.
	 *
	 * @param key - The cache key to invalidate
	 *
	 * @example
	 * ```typescript
	 * // Invalidate cache when files change
	 * watcher.on('change', (path) => {
	 *   cache.invalidate(path);
	 * });
	 * ```
	 */
	invalidate(key: string): void {
		this._cache.delete(key);
	}

	/**
	 * Removes all entries from the cache.
	 *
	 * This completely resets the cache to an empty state.
	 *
	 * @example
	 * ```typescript
	 * // Clear cache before running tests
	 * cache.clear();
	 * ```
	 */
	clear(): void {
		this._cache.clear();
	}

	dispose(): void {
		if (this._cleanupTimer) {
			clearInterval(this._cleanupTimer);
			this._cleanupTimer = null;
		}
	}

	/**
	 * Gets the current number of entries in the cache.
	 *
	 * @returns The number of cached entries
	 *
	 * @example
	 * ```typescript
	 * console.log(`Cache contains ${cache.size()} entries`);
	 * if (cache.size() >= maxSize) {
	 *   console.log('Cache is at capacity');
	 * }
	 * ```
	 */
	size(): number {
		return this._cache.size;
	}

	/**
	 * Gets cache statistics including size and all cached keys.
	 *
	 * Useful for monitoring and debugging cache behavior.
	 *
	 * @returns An object with cache size and array of all keys
	 *
	 * @example
	 * ```typescript
	 * const stats = cache.getStats();
	 * console.log(`Cache stats:`);
	 * console.log(`  Size: ${stats.size}`);
	 * console.log(`  Keys: ${stats.keys.join(', ')}`);
	 * ```
	 */
	getStats(): { size: number; keys: string[] } {
		return {
			size: this._cache.size,
			keys: Array.from(this._cache.keys()),
		};
	}
}
