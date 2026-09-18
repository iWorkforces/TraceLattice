# TRANSPORT MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

MCP HTTP channels. Contract is `ITransport` in `src/contracts/transport.ts`: `kind`, `connect`, `stop`, `clientCount`, `isShuttingDown`, `serverUrl`.

## FILES

```
transport/
├── BaseTransport.ts            # host allowlist, CORS, rate limit, health
├── StreamableHttpTransport.ts  # ~827L production MCP path
├── HttpTransport.ts            # stateless JSON-RPC; CLI does not select it
├── HttpHelpers.ts              # readRequestBody + shared writers
└── HttpRequestLifecycle.ts     # AcceptedWorkTracker + ResponseFinalizer
```

## TRANSPORTS

| Class | Endpoints | Mode | CLI |
|-------|-----------|------|-----|
| `StreamableHttpTransport` | POST/GET `/mcp` | stateful **default true**; `Mcp-Session-Id`; GET `/mcp` optional SSE | `TRANSPORT_TYPE=streamable-http` |
| `HttpTransport` | POST `/messages` | always stateless | **not** selected |

Shared GET: `/health`, `/ready`, `/metrics`.

## SHARED BASE

- Host allowlist (`ALLOWED_HOSTS`)
- CORS preflight + headers
- 100 req/min per-IP (`X-Forwarded-For` aware)
- 10MB body, 30s request timeout
- JSON-RPC via `safeParse(JsonRpcRequestSchema, raw)` — never `JSON.parse` as typed RPC
- `AcceptedWorkTracker` so `stop()` joins in-flight POSTs

## NOTES

- Factories: `createStreamableHttpTransport()`, `createHttpTransport()`.
- Stateful StreamableHTTP keys sessions by `Mcp-Session-Id` after init.
- Session objects track `lastActivityAt`. **No idle reaper** — nothing sweeps stale sessions.
- `ConnectionPool` is unused here. Do not wire it in.
- `HealthChecker` feeds `/health` + `/ready`.

## FORBIDDEN

- `transport → core`, `transport → registry`.
- **Known exception:** `BaseTransport` imports `SESSION_ID_PATTERN` from `core/ids.ts`. Do not add more core imports.
