# TOOLS

**Parent:** ../AGENTS.md

## OVERVIEW

`tool_call` suspend / `tool_observation` resume. One impl: `InMemorySuspensionStore`.

`toolInterleave` gates the **write path**. Store is registered in DI **only if the flag is on** — exception to “stores always registered”.

## STRUCTURE

```
tools/
└── InMemorySuspensionStore.ts
```

Contract: `src/contracts/suspension.ts`.

## ISUSPENSIONSTORE

| Method | Behavior |
|--------|----------|
| `suspend` | mint token + `createdAt`; TTL → `expiresAt` |
| `resume(token)` | consume; **returns `null`** (unknown or expired). Caller throws. |
| `peek(token)` | non-destructive; **returns `null`** if missing. Does not reap. Caller throws. |
| `compareAndAdmit` | throws `SuspensionNotFoundError` / `SuspensionExpiredError`. Session mismatch = **not-found, no consume**. |
| `expireOlderThan(now)` | bulk reap. **Not** `expire(token)`. |
| `clearSession` / `clearAll` / `size` | session or global |
| `start` / `stop` | sweep timer |

## DEFAULTS

- Direct construct TTL **300_000** ms. Wired `ServerConfig` defaults TTL/sweep **60_000** ms.
- Sweep **60_000** ms.
- Per-record TTL, not per-session.

## FLOW

1. Processor `tool_call` → `suspend` → token envelope (no evaluate/strategy).
2. `tool_observation` + token → `compareAndAdmit` (serialized per token).
3. `admit` runs inside the critical section; consume only after success.

## ANTI-PATTERNS

- Do **not** treat `resume`/`peek` null as an exception from the store.
- **Never silently catch `SuspensionExpiredError`** — surface it.
- Do not register this store when `toolInterleave` is off.
