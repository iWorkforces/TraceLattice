# LOGGER MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Structured logging to **stderr**. **Never write stdout** — MCP owns it.

## FILES

```
logger/
├── StructuredLogger.ts  # Logger interface + StructuredLogger
└── NullLogger.ts        # no-op (tests / fallbacks)
```

## API

```
debug / info / warn / error(message, meta?)
setLevel(level)
getLevel()
createChild(context: string)   // NOT child(meta)
```

`createChild` takes a **string** context (`'Database'` → `[App:Database]`). There is no `child({ ...meta })`.

Depend on the `Logger` interface, not `StructuredLogger`. DI key is `Logger`.

`LogLevel`: `debug < info < warn < error`.

## MODES

- JSON default: one line `{ level, message, timestamp, requestId?, context, ...meta }` on stderr
- Pretty (Chalk): `TRACELATTICE_PRETTY_LOG=true` or `pretty: true`

## NOTES

- Every line auto-injects `getRequestId()` from ALS (`RequestContext`) when a request is active.
- `NullLogger` implements the same surface, including `createChild`.
- Watcher no-op loggers omit `createChild` — keep them local, do not widen `Logger` for that.
- Child inherits parent level + pretty; `setLevel` on a child is independent.
