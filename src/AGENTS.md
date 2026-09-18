# SRC

**Updated:** 2026-09-17 | **Parent:** ../AGENTS.md

## OVERVIEW

TypeScript source root. Entry: `cli.ts` → `initializeServer()` → `createServer()` wires **20** DI services.

## STRUCTURE

```
src/
├── lib.ts / cli.ts / CliLifecycle.ts
├── schema.ts / ServerConfig.ts / errors.ts / sanitize.ts / utils.ts
├── core/            # pipeline + session/persistence coordinators
├── persistence/     # File v2 / SQLite v2 / Memory sinks
├── contracts/       # cross-module interfaces (no barrels)
├── di/              # 20 ServiceRegistry keys
├── transport/       # Streamable HTTP + HTTP JSON-RPC
├── registry/ watchers/ cache/
├── pool/ config/ logger/ metrics/ health/ context/ types/
└── __tests__/       # central Vitest suite
```

## WHERE TO LOOK

| Need | File |
|------|------|
| Public API / DI graph | `lib.ts` (`_createContainerCore`) |
| Add a service | `di/ServiceRegistry.ts` + `lib.ts` |
| Add a feature flag | `contracts/features.ts` + `ServerConfig.ts` + `TRACELATTICE_FEATURES_*` |
| Add an error | `errors.ts` (`ERROR_CODES` ~41) or module `*Errors.ts` |
| MCP input schema / tool prompt | `schema.ts` (`SEQUENTIAL_THINKING_TOOL`) |
| Request owner / requestId | `context/RequestContext.ts` (`runWithContext`, `getOwner`, `getRequestId`) |
| Exhaustiveness | `utils.ts:assertNever` |

## NOTES

- **Entry split**: `lib.ts` = published API. `cli.ts` = bin. Don't mix.
- **20 DI keys** (not 19): extra is `sessionLifecycle`.
- Flags gate **writes**. Exception: `suspensionStore` registered only if `toolInterleave`.
- `HttpTransport` + `ConnectionPool` are off the CLI path.
- Child AGENTS.md: `core/` (+ 5 subdirs), `persistence/`, `contracts/`, `di/`, `transport/`, `registry/`, `pool/`, `config/`, `logger/`, `cache/`, `metrics/`, `watchers/`, `health/`, `types/`, `__tests__/` (+ `integration/`, `eval/`).
- Do **not** add `context/AGENTS.md` or `cluster/` (cluster does not exist).
