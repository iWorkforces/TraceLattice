# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-17
**Commit:** 7030031
**Branch:** develop

## OVERVIEW

MCP sequential-thinking server (`@iworkforces/tracelattice`). TypeScript ESM + Valibot + custom DI. Public API is `src/lib.ts` → `dist/lib.js`; CLI is Bun-shebang `src/cli.ts` → `dist/cli.js`. Thinking pipeline: normalize → validate → persist → format → evaluate → strategy → hints.

## STRUCTURE

```
./
├── src/lib.ts            # Public API: createServer / initializeServer
├── src/cli.ts            # Bin entry (tracelattice). Do not mix with lib.ts
├── src/CliLifecycle.ts   # SIGINT/SIGTERM + stdin-end shutdown
├── src/schema.ts         # Valibot SSOT + TOOL_DESCRIPTION
├── src/ServerConfig.ts   # Validated config + 7 feature flags
├── src/errors.ts         # SequentialThinkingError + ERROR_CODES (~41)
├── src/core/             # Pipeline + session/persistence coordinators
├── src/persistence/      # File v2 / SQLite v2 / Memory sinks
├── src/contracts/        # Cross-module interfaces (no barrels)
├── src/di/               # Container + ServiceRegistry (20 keys)
├── src/transport/        # Streamable HTTP + HTTP JSON-RPC
├── src/__tests__/        # Central Vitest suite (not colocated)
├── scripts/              # Packed-CLI shebang + verify:packed
└── .sentrux/             # 9 layers, 6 forbidden import edges
```


## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Public API / DI wiring | `src/lib.ts` | 20 ServiceRegistry keys registered here |
| CLI + shutdown | `src/cli.ts`, `src/CliLifecycle.ts` | stdio default; Streamable HTTP via `TRANSPORT_TYPE` |
| Thought ingest | `src/core/ThoughtProcessor.ts` | Only admission seam |
| History / ownership | `src/core/HistoryManager.ts` | Coordinates; does not score |
| DAG emit / walk | `src/core/graph/` | `EdgeEmitter` is here |
| Persistence backends | `src/persistence/` | Sinks only; buffer is in `core/` |
| Contracts | `src/contracts/` | `IHistoryManager` + `ThoughtData` stay in `core/` |
| Strategy policy | `src/core/reasoning/strategies/` | `decide()`, not `decideNext` |
| Packed release | `scripts/` | `verify:packed` + postbuild shebang |

## CODE MAP

Centrality unmeasured (no LSP / codegraph in this workspace). Inventory from exports + call sites.

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `ToolAwareSequentialThinkingServer` | class | `src/lib.ts` | Public server; wires 20 DI keys |
| `createServer` / `initializeServer` | fn | `src/lib.ts` | Library factory / CLI convenience |
| `ThoughtProcessor` | class | `src/core/ThoughtProcessor.ts` | Ingest seam (~890L) |
| `HistoryManager` | class | `src/core/HistoryManager.ts` | Session maps + mutation coordinator (~990L) |
| `ServiceRegistry` | interface | `src/di/ServiceRegistry.ts` | 20 typed keys incl. `sessionLifecycle` |
| `SequentialThinkingSchema` | schema | `src/schema.ts` | ThoughtData input SSOT |
| `ThoughtData` / `ValidatedThought` | type | `src/core/thought.ts` | Schema output + branded IDs + 7-way union |
| `IReasoningStrategy` | interface | `src/contracts/strategy.ts` | `decide` / `shouldBranch` / `shouldTerminate` |
| `EdgeEmitter` | class | `src/core/graph/EdgeEmitter.ts` | DAG writes; `dagEdges` gates this path |
| `PersistenceBuffer` | class | `src/core/PersistenceBuffer.ts` | Write queue / barriers (~652L) |
| `SessionLifecycleCoordinator` | class | `src/core/SessionLifecycleCoordinator.ts` | Admission + exclusive reset/evict |
| `createPersistenceBackend` | fn | `src/persistence/PersistenceFactory.ts` | file / sqlite / memory / null |
| `StreamableHttpTransport` | class | `src/transport/StreamableHttpTransport.ts` | Production HTTP MCP path |
| `asSessionId` / `GLOBAL_SESSION_ID` | fn / const | `src/contracts/ids.ts` | Only validated SessionId constructor |

## CONVENTIONS

- **ESM + `.js` specifiers**, no barrels, tabs + single quotes + printWidth 100.
- **Valibot** in `src/schema.ts` — not Zod. `ThoughtData` brands schema output.
- **DI**: 20 `ServiceRegistry` keys registered in `lib.ts`. Typed `resolve(key)` only; `resolveDynamic` is untyped escape hatch.
- **Contracts hub**: cross-module types via `src/contracts/`. Exceptions: `IHistoryManager` + `ThoughtData` stay in `core/`.
- **Branded IDs**: `asSessionId()` validates. Other `asX()` are unchecked casts. Never `as SessionId`. Never literal `'__global__'` — use `GLOBAL_SESSION_ID`.
- **Feature flags** (7): `dagEdges`, `reasoningStrategy` (`sequential`\|`tot`), `calibration`, `compression`, `toolInterleave`, `newThoughtTypes`, `outcomeRecording`. `validateFeatures()` defaults booleans **on**. Flags gate **writes**; stores stay in DI except `suspensionStore` (registered only if `toolInterleave`).
- **Session ownership**: `getOwner()` from ALS. Stdio (no owner) unrestricted. Cross-owner → `SessionAccessDeniedError`. Restored sessions deny owner-aware access.
- **Strategy purity**: `decide(ctx)` over a snapshot. No I/O, no graph mutation.
- **`override` + `_` private prefix**. `noImplicitOverride`, unused args `^_`.

## ANTI-PATTERNS (THIS PROJECT)

- No `as SessionId`, no inline `import()` types, no barrels, no `as any` / `@ts-ignore`.
- No mixing `lib.ts` (public API) and `cli.ts` (bin).
- No stdout logs (MCP). No empty catch. No sync I/O except startup `existsSync`.
- Forbidden sentrux edges: `transport→core`, `transport→registry`, `watchers→persistence`, `cluster→registry`, `persistence→transport`, `registry→core/HistoryManager.ts`.
- `BaseTransport` currently imports `SESSION_ID_PATTERN` from `core/ids.ts` — do not add more `transport→core` imports.
- Max CC 25, max function 100 lines (sentrux). `generateUlid` is not a real ULID — do not rename.

## NOTES

- CI: Node **24.x + 26.x**. Hard gates: `verify:library` (type-check + **lint** + build + coverage), `verify:native`, `verify:packed`. Soft: `npm audit` only.
- CD publishes the packed tarball artifact (does not rebuild). Packed CLI shebang is **Bun 1.4.2**.
- Coverage: branches 90 / functions 60 / lines 65 / statements 65.
- Layers: types → crosscutting → config → core → domain → infrastructure → di → app → cli.
- `ConnectionPool` and `HttpTransport` are off the CLI path. `cluster/` does not exist (still a sentrux boundary).
- Large files: `HistoryManager` 990, `ThoughtProcessor` 890, `errors` 867, `StreamableHttpTransport` 827, `lib` 819, `schema` 738, `PersistenceBuffer` 652.
- Tests: `src/__tests__/` mirrors source; flags via constructor; `RUN_EVAL=1` for `*.eval.ts`.

## COMMANDS

```bash
npm run build            # rslib && rsbuild && postbuild shebang
npm run start            # bun dist/cli.js
npm run dev              # bunx MCP inspector
npm test                 # vitest run --config vitest.config.ts
npm run test:coverage
npm run test:native
npm run type-check
npm run lint
npm run verify:library   # type-check + lint + build + coverage
npm run verify:native
npm run verify:packed
npm run verify:release   # all three (also prepublishOnly)
```
