# TRANSPORT MODULE

**Updated:** 2026-06-25
**Parent:** ../AGENTS.md

## OVERVIEW

MCP transport implementations: 2 transport types plus a shared base. Communication channels between MCP server and clients. Factory pattern, async lifecycle, security baked in. `ITransport` contract: `src/contracts/transport.ts`.

## STRUCTURE

```
src/transport/
├── BaseTransport.ts            # 410L  Abstract base: rate limiting, CORS, validation
├── StreamableHttpTransport.ts  # 704L  MCP Streamable HTTP (stateful/stateless)
├── HttpTransport.ts            # 344L  HTTP JSON-RPC (stateless)
└── HttpHelpers.ts              # 109L  readRequestBody + shared utils
```

## TRANSPORTS

### StreamableHttpTransport (production, most complex)
Production MCP transport that replaced the dedicated legacy SSE transport as of the March 2025 MCP specification. Dual mode: stateful (per-client `SessionState` keyed by `Mcp-Session-Id` header) or stateless. In stateful mode, `GET /mcp` provides an optional `text/event-stream` notification stream. Request streaming, graceful shutdown, session reaper.

### HttpTransport (simplest)
Stateless JSON-RPC 2.0 over HTTP. Pipeline: rate limit → CORS → body size → schema → delegate. Body limit 10MB, 30s timeout.

## ENDPOINTS

| Transport | Method | Path | Notes |
|-----------|--------|------|-------|
| StreamableHTTP | POST | `/mcp` | JSON-RPC requests; stateful sessions use `Mcp-Session-Id` after init |
| StreamableHTTP | GET | `/mcp` | Optional stateful `text/event-stream` notification stream |
| StreamableHTTP | GET | `/health`, `/ready`, `/metrics` | Health/readiness/Prometheus |
| HTTP | POST | `/messages` | Stateless JSON-RPC 2.0 |
| HTTP | GET | `/health`, `/ready`, `/metrics` | Health/readiness/Prometheus |
## SHARED BASE

`BaseTransport` provides cross-cutting security:
- Rate limiting (100 req/min per-IP, `X-Forwarded-For` aware)
- CORS preflight + headers
- Session ID validation (`SESSION_ID_PATTERN` from `core/ids.ts`)
- Host header allowlist (`ALLOWED_HOSTS`)
- Query param sanitization, path traversal prevention, request size caps
- JSON-RPC parsing via `safeParse(JsonRpcRequestSchema, rawBody)` (valibot) — never raw `JSON.parse(...) as unknown`

## NOTES

- Factories: `createStreamableHttpTransport()`, `createHttpTransport()`
- All expose `start()` / `stop()` (Promise-based graceful shutdown)
- `HealthChecker` integration for `/health`
- `Mcp-Session-Id` header is the stateful StreamableHTTP session key
- `HttpHelpers.readRequestBody` shared across HTTP variants, never duplicate
