# LOGGER MODULE

**Updated:** 2026-05-17
**Parent:** ../AGENTS.md

## OVERVIEW

Lightweight structured logging without external dependencies. Writes to `stderr` (MCP protocol constraint — stdout is reserved for MCP messages). JSON mode for production, pretty (Chalk) mode for development.

## STRUCTURE

```
src/logger/
├── StructuredLogger.ts  # Logger interface + StructuredLogger + NullLogger (413L)
└── NullLogger.ts        # No-op logger implementation (standalone, 4.5K)
```

## API

```typescript
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  setLevel(level: LogLevel): void;
  child(context: Record<string, unknown>): Logger;  // inherits level + context
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
```

`StructuredLogger` is registered as `Logger` in DI. All modules accept `Logger` (the interface), not the concrete class.

## MODES

- **JSON mode** (default, `prettyLog: false`): `{ level, message, timestamp, requestId?, ...meta }` as single-line JSON to stderr. Suitable for log aggregators.
- **Pretty mode** (`prettyLog: true`): Colorized human-readable output using Chalk. Enable via `TRACELATTICE_PRETTY_LOG=true`.

## CHILD LOGGERS

```typescript
const childLogger = logger.child({ transport: 'streamable-http', sessionId: '...' });
// All child log calls include inherited context fields
```

Child loggers inherit parent's log level. Override level on child independently via `setLevel()`.

## NOTES

- `NullLogger`: No-op implementation used in tests and as a fallback default (e.g., `HealthChecker` default). Lives in both `NullLogger.ts` (standalone) and inline in some consumers.
- `RequestContext.getRequestId()` is injected into every log line automatically when an active request context exists (`AsyncLocalStorage`).
- Never write to `stdout` — MCP reads stdout as protocol messages.
- Log level hierarchy: `debug < info < warn < error`. Only messages at or above the configured level emit.
