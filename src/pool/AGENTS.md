# POOL MODULE

**Updated:** 2026-06-25
**Parent:** ../AGENTS.md

## OVERVIEW

Reusable HTTP-layer session isolation for concurrent MCP clients. Each session is a `SessionServer` with independent thought state. Enforces max-session limits, auto-cleanup via TTL, and graceful teardown.

## STRUCTURE

```
src/pool/
├── ConnectionPool.ts   # Main pool: session lifecycle, TTL cleanup, stats (450L)
└── IConnectionPool.ts  # Shared pool contract + ContentBlock, ProcessResult, SessionServer, SessionInfo, ConnectionPoolStats (133L)
```

## API

```typescript
const pool = new ConnectionPool({
  maxSessions: 100,           // default: 100
  sessionTimeout: 300_000,    // default: 5min in ms
  autoCleanup: true,          // default: true
  cleanupInterval: 60_000,    // default: 1min in ms
  logger?: Logger,
  serverFactory: () => Promise<SessionServer>,
});

const sessionId = await pool.createSession();  // throws MaxSessionsReachedError
await pool.process(sessionId, thought);         // throws SessionNotFoundError / SessionNotActiveError
await pool.closeSession(sessionId);
pool.getStats(): ConnectionPoolStats           // totalSessions, activeSessions, maxSessions, cleanupEnabled, sessionTimeout
await pool.dispose();                           // graceful shutdown, closes all sessions
```

## SESSION ERRORS

| Error | When |
|-------|------|
| `MaxSessionsReachedError` | `createSession()` when `activeSessions >= maxSessions` |
| `SessionNotFoundError` | `process()` / `closeSession()` with unknown sessionId |
| `SessionNotActiveError` | `process()` on an already-closed session |
| `PoolTerminatedError` | Any call after `dispose()` |

All errors are subclasses of `SequentialThinkingError` from `errors.ts`.

## NOTES

- `ConnectionPool` is NOT the same as `HistoryManager`'s internal `SessionManager`. Pool manages reusable HTTP-layer sessions; `SessionManager` manages thought-history sessions (keyed by `session_id` in the thought data).
- `SessionServer` is the per-user server instance created by `serverFactory` for HTTP-layer session isolation.
- Auto-cleanup sweeps expired sessions every `cleanupInterval` ms; sessions idle longer than `sessionTimeout` ms are closed.
- `IConnectionPool` defines the reusable pool boundary. Consumers should import the interface, not the concrete class.
- Shared pool types (`ContentBlock`, `ProcessResult`, `SessionServer`, `SessionInfo`, `ConnectionPoolStats`) are owned by `IConnectionPool.ts`. Keep them there rather than re-defining them in consumers.
