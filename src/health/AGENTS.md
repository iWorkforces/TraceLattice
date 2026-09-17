# HEALTH MODULE

**Updated:** 2026-05-17
**Parent:** ../AGENTS.md

## OVERVIEW

Aggregate liveness and readiness checks. `HealthChecker` accepts a `PersistenceBackend` and checks its `.healthy()` method. Consumed by transport `/health` and `/ready` endpoints.

## STRUCTURE

```
health/
└── HealthChecker.ts   # HealthChecker class + result types (161L)
```

## KEY TYPES

| Symbol | Role |
|--------|------|
| `HealthChecker` (class) | `checkLiveness()` (sync, always ok) + `async checkReadiness()` (aggregates backends) |
| `HealthCheckResult` | `{ status: 'ok'\|'degraded'\|'unhealthy', timestamp, components }` |
| `HealthComponent` | `{ name, healthy, details?, latencyMs? }` |

## BEHAVIOR

- `checkLiveness()`: synchronous, always returns `status: 'ok'`. Used by `GET /health`.
- `checkReadiness()`: calls `persistence.healthy()` (with latency measurement) and aggregates:
  - All healthy (or none registered) → `'ok'`
  - Some healthy → `'degraded'`
  - None healthy → `'unhealthy'`
- Used by `GET /ready` on `StreamableHttpTransport`.
- Pass `null` for persistence when no backend is configured — checker skips it.
