# PERSISTENCE MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Dumb session-scoped sinks. Buffering / flush / restore live in `src/core/`. Contract is `src/contracts/PersistenceBackend.ts` (not in this folder).

## STRUCTURE

```
persistence/
├── PersistenceFactory.ts     # file | sqlite | memory | null
├── MemoryPersistence.ts
├── FilePersistence.ts + FileWriter + FileSnapshotV2 + FileLegacyImport
├── SqlitePersistence.ts + SqliteDriver + SqliteSchemaV2 + SqliteLegacyImport
├── PersistenceScope.ts / PersistenceCodec.ts / PersistenceErrors.ts
└── SessionScopedPersistence.ts
```

## BACKENDS

| Backend | Storage | Notes |
|---------|---------|-------|
| Memory | 4 `Map`s by `SessionId` | Tests / default |
| File v2 | **one** `<dataDir>/snapshot.json` | Exclusive lock; full rewrite; not `edges/{session}.json` |
| SQLite v2 | tables + `schema_version=(1,2)` | WAL unless `enableWAL === false`; `better-sqlite3` optional |

All three implement **indivisible** `SessionScopedPersistenceBackend`. Unscoped methods are `GLOBAL_SESSION_ID` aliases. Named sessions must use `*ForSession`.

## CONVENTIONS

- Sinks only: no timers, no batching, no debounce.
- Capability is all-or-nothing (`supportsSessionScopedPersistence`). Never fall back to global `clear()`.
- Restore session list is `listSessions()`, **not** `listEdgeSessions()`.
- Edges/summaries are replace-sets per session. Scope mismatch → `PersistenceScopeMismatchError`.
- **No auto-migrate.** Leftover v1 files/tables → `PersistenceImportRequiredError`. Import is explicit + destination-absent (`importLegacyFileV1` / `importLegacySqliteV1`).

## ANTI-PATTERNS

- Do not implement only the 13-method unscoped interface.
- Do not swallow parse errors into `[]`.
- Do not persist thoughts without `id`.
- Forbidden: `persistence → transport`.
