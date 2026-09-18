# DI MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Plain-TS IoC + typed `ServiceRegistry` (**20** keys). Circular detection via `_resolving`. Production graph is wired in `lib.ts`, not here.

## API

- `registerInstance` — eager singleton
- `register` — lazy singleton (factory once)
- `registerFactory` — transient
- `resolve(key)` — typed from `ServiceRegistry`
- `resolveDynamic(name)` — `unknown`; only for keys **not** in the registry
- `registerDisposable` + `dispose()` (reverse order)

Deprecated `resolve<T>(string)` overload is **gone**.

## SERVICE REGISTRY (20)

`Logger`, `Config`, `FileConfig`, `HistoryManager`, `ThoughtProcessor`, `ThoughtFormatter` (transient), `ThoughtEvaluator` (transient), `Persistence`, `ToolRegistry`, `SkillRegistry`, `Metrics`, `EdgeStore`, `reasoningStrategy`, `outcomeRecorder`, `calibrator`, `summaryStore`, `compressionService`, `suspensionStore`, `sessionLock`, **`sessionLifecycle`**.

Not in the registry: `DiscoveryCache`, watchers, `ConnectionPool`, `HealthChecker`, transports.

## RULES

- New service: extend `ServiceRegistry` **and** register in `lib.ts` `_createContainerCore()`.
- Never `resolveDynamic` for registry keys.
- `sessionLock` / `sessionLifecycle` are `@internal`.
