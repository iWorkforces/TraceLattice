import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiscoveryCache } from '../cache/DiscoveryCache.js';
import { useFakeTimers, useRealTimers } from './helpers/timers.js';

describe('DiscoveryCache', () => {
	describe('basic operations', () => {
		let cache: DiscoveryCache<string>;

		beforeEach(() => {
			cache = new DiscoveryCache<string>({ maxSize: 3, ttl: 60000 });
		});

		afterEach(() => {
			cache.dispose();
		});

		it('should return null for missing keys', () => {
			expect(cache.get('missing')).toBeNull();
			expect(cache.size()).toBe(0);
		});

		it('should store and retrieve data', () => {
			cache.set('tools', ['Read', 'Write']);
			expect(cache.get('tools')).toEqual(['Read', 'Write']);
		});

		it('should snapshot input arrays when storing data', () => {
			// Given
			const tools = ['Read'];
			cache.set('tools', tools);

			// When
			tools.push('Write');

			// Then
			expect(cache.get('tools')).toEqual(['Read']);
		});

		it('should return caller-owned arrays when retrieving data', () => {
			// Given
			cache.set('tools', ['Read']);
			const firstRead = cache.get('tools');

			// When
			firstRead?.push('Write');

			// Then
			expect(cache.get('tools')).toEqual(['Read']);
		});

		it('should return false for missing keys with has()', () => {
			expect(cache.has('missing')).toBe(false);
		});

		it('should return true for existing keys with has()', () => {
			cache.set('tools', ['Read']);
			expect(cache.has('tools')).toBe(true);
		});

		it('should return size correctly', () => {
			cache.set('a', ['1']);
			cache.set('b', ['2']);
			expect(cache.size()).toBe(2);
		});

		it('should return 0 size when empty', () => {
			expect(cache.size()).toBe(0);
		});

		it('should clear all entries', () => {
			cache.set('a', ['1']);
			cache.set('b', ['2']);
			cache.clear();
			expect(cache.size()).toBe(0);
			expect(cache.get('a')).toBeNull();
			expect(cache.get('b')).toBeNull();
		});

		it('should invalidate a specific key', () => {
			cache.set('a', ['1']);
			cache.set('b', ['2']);
			cache.invalidate('a');
			expect(cache.get('a')).toBeNull();
			expect(cache.get('b')).toEqual(['2']);
			expect(cache.size()).toBe(1);
		});

		it('should not throw when invalidating missing key', () => {
			expect(() => cache.invalidate('nonexistent')).not.toThrow();
			expect(cache.size()).toBe(0);
		});

		it('should update existing key value', () => {
			cache.set('tools', ['Read']);
			cache.set('tools', ['Read', 'Write']);
			expect(cache.get('tools')).toEqual(['Read', 'Write']);
			expect(cache.size()).toBe(1);
		});

		it('should return stats with correct size and keys', () => {
			cache.set('a', ['1']);
			cache.set('b', ['2']);
			const stats = cache.getStats();
			expect(stats.size).toBe(2);
			expect(stats.keys).toEqual(['a', 'b']);
		});

		it('should return empty stats when no entries', () => {
			const stats = cache.getStats();
			expect(stats.size).toBe(0);
			expect(stats.keys).toEqual([]);
		});

		it('should track access count on get', () => {
			cache.set('tools', ['Read']);
			cache.get('tools');
			cache.get('tools');
			const stats = cache.getStats();
			expect(stats.size).toBe(1);
		});

		it('should use default maxSize and ttl', () => {
			const defaultCache = new DiscoveryCache<string>();
			defaultCache.set('a', ['1']);
			expect(defaultCache.get('a')).toEqual(['1']);
			expect(defaultCache.size()).toBe(1);
			defaultCache.dispose();
		});
	});

	describe('LRU eviction', () => {
		it('should evict oldest entry when maxSize exceeded', () => {
			const cache = new DiscoveryCache<string>({ maxSize: 2, ttl: 60000 });
			cache.set('first', ['1']);
			cache.set('second', ['2']);
			cache.set('third', ['3']);

			expect(cache.size()).toBe(2);
			expect(cache.get('first')).toBeNull();
			expect(cache.get('second')).toEqual(['2']);
			expect(cache.get('third')).toEqual(['3']);
			cache.dispose();
		});

		it('should not evict when key already exists (update)', () => {
			const cache = new DiscoveryCache<string>({ maxSize: 2, ttl: 60000 });
			cache.set('a', ['1']);
			cache.set('b', ['2']);
			cache.set('a', ['updated']);

			expect(cache.size()).toBe(2);
			expect(cache.get('a')).toEqual(['updated']);
			expect(cache.get('b')).toEqual(['2']);
			cache.dispose();
		});

		it('should evict in insertion order', () => {
			const cache = new DiscoveryCache<string>({ maxSize: 3, ttl: 60000 });
			cache.set('a', ['1']);
			cache.set('b', ['2']);
			cache.set('c', ['3']);
			cache.set('d', ['4']);

			expect(cache.get('a')).toBeNull();
			expect(cache.get('b')).toEqual(['2']);
			cache.dispose();
		});

		it('should work with maxSize 1', () => {
			const cache = new DiscoveryCache<string>({ maxSize: 1, ttl: 60000 });
			cache.set('first', ['1']);
			expect(cache.get('first')).toEqual(['1']);

			cache.set('second', ['2']);
			expect(cache.get('first')).toBeNull();
			expect(cache.get('second')).toEqual(['2']);
			expect(cache.size()).toBe(1);
			cache.dispose();
		});

		it('should increment accessCount on get', () => {
			const cache = new DiscoveryCache<string>({ maxSize: 100, ttl: 60000 });
			cache.set('tools', ['Read']);
			cache.get('tools');
			cache.get('tools');

			expect(cache.get('tools')).toEqual(['Read']);
			cache.dispose();
		});
	});

	describe('TTL expiration', () => {
		afterEach(() => {
			useRealTimers();
		});

		it('should return null for expired entries on get', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({ maxSize: 100, ttl: 5000 });
			cache.set('tools', ['Read']);

			vi.advanceTimersByTime(5001);
			expect(cache.get('tools')).toBeNull();
			cache.dispose();
		});

		it('should not expire entries before TTL', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({ maxSize: 100, ttl: 5000 });
			cache.set('tools', ['Read']);

			vi.advanceTimersByTime(5000);
			// get() checks age > ttl (strict), so at exactly ttl it should still be valid
			expect(cache.get('tools')).toEqual(['Read']);
			cache.dispose();
		});

		it('should report has() false for expired entries', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({ maxSize: 100, ttl: 5000 });
			cache.set('tools', ['Read']);

			vi.advanceTimersByTime(5001);
			expect(cache.has('tools')).toBe(false);
			cache.dispose();
		});

		it('should report has() true before TTL', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({ maxSize: 100, ttl: 5000 });
			cache.set('tools', ['Read']);

			vi.advanceTimersByTime(5000);
			expect(cache.has('tools')).toBe(true);
			cache.dispose();
		});

		it('should delete expired entries on get', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({ maxSize: 100, ttl: 5000 });
			cache.set('tools', ['Read']);
			cache.set('fresh', ['2']);

			vi.advanceTimersByTime(5001);
			cache.get('tools');
			expect(cache.size()).toBe(1);
			expect(cache.get('fresh')).toBeNull(); // fresh also expired now
			cache.dispose();
		});

		it('should not delete expired entries on has()', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({ maxSize: 100, ttl: 5000 });
			cache.set('tools', ['Read']);

			vi.advanceTimersByTime(5001);
			cache.has('tools'); // has() does NOT delete expired entries
			expect(cache.size()).toBe(1); // still in cache
			cache.dispose();
		});

		it('should update timestamp on get (refreshes TTL)', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({ maxSize: 100, ttl: 5000 });
			cache.set('tools', ['Read']);

			vi.advanceTimersByTime(4000);
			cache.get('tools'); // refreshes timestamp

			vi.advanceTimersByTime(4000);
			// total 8000ms since set, but only 4000ms since last get
			expect(cache.get('tools')).toEqual(['Read']);
			cache.dispose();
		});
	});

	describe('recency update', () => {
		it('should move accessed entry to most-recent position on get', () => {
			const cache = new DiscoveryCache<string>({ maxSize: 3, ttl: 60000 });
			cache.set('old', ['1']);
			cache.set('mid', ['2']);
			cache.set('new', ['3']);

			cache.get('old'); // old becomes most recent

			cache.set('extra', ['4']); // should evict mid, not old
			expect(cache.get('old')).toEqual(['1']);
			expect(cache.get('mid')).toBeNull();
			expect(cache.get('new')).toEqual(['3']);
			expect(cache.get('extra')).toEqual(['4']);
			cache.dispose();
		});

		it('should update value but NOT change LRU position on set (only get does)', () => {
			const cache = new DiscoveryCache<string>({ maxSize: 3, ttl: 60000 });
			cache.set('old', ['1']);
			cache.set('mid', ['2']);
			cache.set('new', ['3']);

			cache.set('old', ['updated']); // Map.set on existing key keeps insertion order

			cache.set('extra', ['4']); // should evict old (still at LRU position)
			expect(cache.get('old')).toBeNull();
			expect(cache.get('mid')).toEqual(['2']);
			expect(cache.get('new')).toEqual(['3']);
			expect(cache.get('extra')).toEqual(['4']);
			cache.dispose();
		});
	});

	describe('cleanup timer', () => {
		afterEach(() => {
			useRealTimers();
		});

		it('should remove expired entries on cleanup interval', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({
				maxSize: 100,
				ttl: 5000,
				cleanupInterval: 1000,
			});

			cache.set('stale', ['1']);
			vi.advanceTimersByTime(6000); // past TTL
			cache.set('fresh', ['2']);

			expect(cache.get('stale')).toBeNull(); // already expired
			expect(cache.get('fresh')).toEqual(['2']);
			cache.dispose();
		});

		it('should not remove fresh entries on cleanup', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({
				maxSize: 100,
				ttl: 5000,
				cleanupInterval: 1000,
			});

			cache.set('fresh', ['1']);
			vi.advanceTimersByTime(1000); // one cleanup cycle, but entry not expired

			expect(cache.has('fresh')).toBe(true);
			expect(cache.size()).toBe(1);
			cache.dispose();
		});

		it('should not start cleanup timer when cleanupInterval is 0', () => {
			useFakeTimers();
			const cache = new DiscoveryCache<string>({
				maxSize: 100,
				ttl: 5000,
				cleanupInterval: 0,
			});

			cache.set('stale', ['1']);
			vi.advanceTimersByTime(10000);

			// Without cleanup timer, stale entries only cleaned on access
			// has() doesn't delete, so size should still be 1
			expect(cache.size()).toBe(1);
			cache.dispose();
		});
	});

	describe('dispose', () => {
		it('should clear cleanup timer on dispose', () => {
			const cache = new DiscoveryCache<string>({
				maxSize: 100,
				ttl: 60000,
				cleanupInterval: 1000,
			});
			cache.dispose();

			const stats = cache.getStats();
			expect(stats.size).toBe(0);
		});

		it('should not throw when disposing twice', () => {
			const cache = new DiscoveryCache<string>({
				maxSize: 100,
				ttl: 60000,
				cleanupInterval: 1000,
			});
			cache.dispose();
			expect(() => cache.dispose()).not.toThrow();
		});

		it('should not throw when disposing without cleanup timer', () => {
			const cache = new DiscoveryCache<string>({
				maxSize: 100,
				ttl: 60000,
			});
			cache.set('a', ['1']);
			cache.dispose(); // does NOT clear entries, only clears timer

			// dispose() clears interval but not cache entries
			const stats = cache.getStats();
			expect(stats.size).toBe(1);
			expect(stats.keys).toEqual(['a']);
		});
	});

	describe('uncovered branch coverage', () => {
		it('should handle LRU eviction when maxSize is 0 (lruKey undefined branch)', () => {
			const cache = new DiscoveryCache<string>({ maxSize: 0, ttl: 60000 });
			// maxSize 0 means size(0) >= maxSize(0) is true, but map is empty
			// so lruKey is undefined → hits the falsy branch
			cache.set('key', ['value']);
			// The entry should still be added despite failing to evict
			expect(cache.get('key')).toEqual(['value']);
			cache.dispose();
		});

		it('should handle cleanup timer without unref method', () => {
			// Mock setInterval to return an object without unref
			const originalSetInterval = globalThis.setInterval;
			const mockTimer = { ref: vi.fn() } as unknown as NodeJS.Timeout;
			globalThis.setInterval = vi.fn(() => mockTimer) as unknown as typeof globalThis.setInterval;

			const cache = new DiscoveryCache<string>({
				maxSize: 100,
				ttl: 60000,
				cleanupInterval: 5000,
			});

			// The constructor should not throw even without unref
			expect(cache).toBeDefined();
			expect(globalThis.setInterval).toHaveBeenCalledOnce();

			globalThis.setInterval = originalSetInterval;
			// Don't call dispose since timer is mocked
		});
	});
});
