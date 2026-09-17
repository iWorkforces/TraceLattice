# CACHE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

LRU+TTL cache for tool/skill discovery. One file. Contract is `IDiscoveryCache` in `contracts/interfaces.ts`, not here.

## FILE

```
cache/
└── DiscoveryCache.ts   # DiscoveryCache<T>, CacheEntry, DiscoveryCacheOptions
```

## BEHAVIOR

- LRU via `Map` insertion order. `get`/`set` move the key to the end (MRU).
- TTL on `get`: expired entries are **deleted** (lazy) then counted as a miss.
- `has()` checks TTL and returns false if expired but **does not delete**.
- Defaults: `maxSize` 100, `ttl` 300_000 ms. `BaseRegistry` fallback is `maxSize` 50.
- Optional `cleanupInterval` starts an **unref'd `setInterval`** that sweeps expired keys.
- Docs saying "no background sweep" are **wrong**. `dispose()` clears the timer.

## METRICS (optional `IMetrics`)

| Name | When |
|------|------|
| `cache_hit_total` | `get` hit, unexpired |
| `cache_miss_total` | missing or TTL-expired on `get` |
| `cache_eviction_total` | `cause`: `ttl` (lazy get), `ttl_cleanup` (sweep), `lru` (capacity) |

## NOTES

- `BaseRegistry` only **populates** the `'all'` key. Per-name keys exist on the API; registry invalidates `name` on remove/update but never `set`s them.
- `get` refreshes `timestamp` + `accessCount` on hit. `get`/`set` copy the array.
- Not in DI. Wired by `lib.ts` / `BaseRegistry` constructor.
