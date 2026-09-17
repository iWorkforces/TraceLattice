# Reliability hardening execution contract

Status: authoritative wave-0 execution contract, frozen 2026-09-09.

This document controls the reliability-hardening work described by the accepted plan. It records the baseline, approved behavior, compatibility boundaries, and the task-to-requirement trace. It does not claim that a repair is implemented or proven. Later work must update this document from passing evidence before making a release claim.

## Authority and limits

The user authorized the plan as written on 2026-09-09. Every numbered decision in the approved-decision table below is **APPROVED for implementation**. Approval permits source work, fixture-based compatibility work under the plan's tests, and local commits. Local commits are the only authorized VCS action. It does not authorize a deployment, publication, production dependency change, or access to user data.

The following boundaries apply throughout execution:

- Local commits are authorized. Push, pull request creation, merge, tag, release, package publication, and deployment are prohibited.
- No production dependency or runtime requirement may be added without separate approval.
- Data migration is limited to fixtures and disposable copies. Ordinary startup must not migrate data. No live or production data migration is authorized.
- Existing source data must remain untouched during compatibility tests. An import writes only to a separate approved destination.
- A passing test is not a production service-level, security, authentication, power-loss durability, or readiness guarantee.
- Review artifacts under `.omo/reliability-review-20260909-114754/` are immutable inputs.

## Frozen baseline

| Item | Frozen value |
| --- | --- |
| Branch | `ulw/tracelattice-reliability-wave-0` |
| Revision | `b66651fa883f46ac2a5ec57b218f03aed0783df8` |
| Package | `tracelattice@1.4.6` |
| Module mode | ESM (`"type": "module"`) |
| Library entry | `dist/lib.js` |
| Type entry | `dist/lib.d.ts` |
| Package subpaths | `.` for types/import and `./package.json` |
| Executable | `tracelattice` -> `dist/cli.js` |
| Runtime used for this baseline | Node `v26.8.1`, npm `12.0.2`, Bun `1.4.2` |
| Optional SQLite driver | `better-sqlite3` absent |
| Graph evidence | Full index generation `2026-09-09T02:17:37Z`; no recorded issue for the cited source/config/test paths. This is a best-effort signal, so exact contracts below also come from direct source reads. |
| Execution-input freeze | The exact SHA-256 manifest for the ignored plan plus `REPORT.md`, `EVIDENCE.md`, `GATE.md`, and all four retained probe programs/logs is recorded in `.omo/evidence/tracelattice-reliability-hardening/20260909-wave0/task-1-contracts.md`. These are current pre-production-edit freeze hashes captured after independent review; they identify the inputs for later stale-state checks but do not prove that mtimes or bytes were unchanged earlier. |

The package root exports five TypeScript declarations from `src/lib.ts`: `ServerOptions`, `IToolAwareSequentialThinkingServer`, `ToolAwareSequentialThinkingServer`, `createServer`, and `initializeServer`. The public server contract includes `processThought(...): Promise<CallToolResult>`, `stop(): Promise<void>`, `dispose(): Promise<void>`, and synchronous `clear(): void`. `IHistoryManager.clear(sessionId?: string): void` currently treats an omitted ID as all sessions. `PersistenceBackend.clear(): Promise<void>` is currently global and destructive.

## Current persistence contract and formats

`PersistenceBackend` currently has thirteen methods. History and branch operations are global: `saveThought`, `loadHistory`, `saveBranch`, `loadBranch`, `listBranches`, and `clear`. Edge and summary operations accept a session ID. There is no session-scoped history/branch clear capability and no capability negotiation for custom backends.

All current durable formats are unversioned.

| Backend | Current baseline format | Namespace and replacement behavior |
| --- | --- | --- |
| Memory | One `ThoughtData[]`; one `Map<BranchId, ThoughtData[]>`; per-session `Map<SessionId, Edge[]>`; per-session `Map<SessionId, Summary[]>` | Thoughts and branches share global collections. Edge and summary sets replace the named session's set. `clear()` empties all four collections. This backend is ephemeral. |
| File | `history.json` is a JSON thought array; `branches/<branch-id>.json` is one JSON thought array per branch; `edges/<session-id>.json` is a created-time-sorted edge array; `summaries/<session-id>.json` is a created-time-sorted summary array | History and branch filenames do not partition by session. History, branch, and edge writes target their final paths directly. Summary writes use a fixed `.tmp` sibling followed by rename. `clear()` deletes all JSON files from every namespace and suppresses deletion errors. Parse/validation failures currently return an empty or missing result. |
| SQLite | `thoughts(id, data, created_at)` with each thought as JSON; `branches(branch_id, data, updated_at)` with each branch array as JSON; structured `edges(id, session_id, from_id, to_id, kind, created_at, metadata)`; structured `summaries(id, session_id, branch_id, root_thought_id, covered_ids, covered_range_start, covered_range_end, topics, aggregate_confidence, created_at, meta)` | Thoughts have no session column and branches use `branch_id` as the sole primary key. Edges and summaries are session-scoped and replaced transactionally per session. `clear()` deletes every table. The backend creates tables in place without an explicit schema-version record. WAL is enabled unless disabled; `better-sqlite3` is optional and absent from this baseline. |

Built-in implementations affected by the approved session-aware contract are `MemoryPersistence`, `FilePersistence`, and `SqlitePersistence`, selected by `createPersistenceBackend`. Contract-shaped test doubles also exist in `src/__tests__/history-manager.test.ts`, `src/__tests__/health-checker.test.ts`, `src/__tests__/health-checker-cov.test.ts`, and `src/__tests__/base-transport-cov.test.ts`. Backend matrix factories in `src/__tests__/integration/dag-edges.test.ts` and `src/__tests__/integration/CompressionPersistence.test.ts` consume the same interface. Any additive method must update these implementations and doubles. A custom backend without the new session capability must reject named durable operations; it must never fall back to global deletion.

## Approved File v2 schema

Task 7 must implement File v2 exactly as this section specifies. The only v2 document is `<canonical-data-dir>/snapshot.json`. It is one UTF-8 JSON document published by Task 6's unique-temporary-file plus atomic-replacement protocol while the directory writer is held. The legacy split files are import inputs only; an ordinary v2 startup does not read them as an empty v2 store, modify them, or migrate them.

The Valibot envelope is exactly the following construction. It has no optional envelope fields, every envelope record is strict, and payload field lists remain owned by their existing schemas:

```typescript
const SessionIdStringSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_-]{1,100}$/),
);
const BranchIdStringSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_-]{1,50}$/),
);

const ThoughtSessionV2Schema = v.strictObject({
  sessionId: SessionIdStringSchema,
  thoughts: v.array(SequentialThinkingSchema),
});
const BranchRecordV2Schema = v.strictObject({
  sessionId: SessionIdStringSchema,
  branchId: BranchIdStringSchema,
  thoughts: v.array(SequentialThinkingSchema),
});
const EdgeSessionV2Schema = v.strictObject({
  sessionId: SessionIdStringSchema,
  edges: v.array(EdgeSchema),
});
const SummarySessionV2Schema = v.strictObject({
  sessionId: SessionIdStringSchema,
  summaries: v.array(SummarySchema),
});

const FileSnapshotV2Schema = v.strictObject({
  version: v.literal(2),
  thoughts: v.array(ThoughtSessionV2Schema),
  branches: v.array(BranchRecordV2Schema),
  edges: v.array(EdgeSessionV2Schema),
  summaries: v.array(SummarySessionV2Schema),
});
```

`version` is the JSON number literal `2`; the string `"2"`, another number, `null`, or a missing value is invalid. `SessionIdString` is either the literal `__global__` or a value accepted by `asSessionId` from `src/contracts/ids.ts`: 1-100 ASCII letters, digits, hyphens, or underscores. `BranchIdString` is 1-50 ASCII letters, digits, hyphens, or underscores, matching the persisted branch field in `SequentialThinkingSchema` from `src/schema.ts`. JSON `null` never substitutes for an optional payload field or an empty array.

The envelope must reference, not copy, the payload contracts:

- Every `ThoughtData` value is the exact `ThoughtData` type from `src/core/thought.ts` and is parsed by the exact existing `SequentialThinkingSchema` from `src/schema.ts`. The envelope must import and reuse that schema; it must not enumerate, redefine, add, or remove thought payload fields.
- Every `Edge` value is parsed by the exact `EdgeSchema` from `src/schema.ts` and remains assignable to `Edge` from `src/core/graph/Edge.ts`.
- Every `Summary` value is parsed by the exact `SummarySchema` from `src/core/compression/Summary.ts` and remains assignable to `Summary` from that file.

The following refinements and canonical ordering are part of the schema contract:

- `thoughts`, `edges`, and `summaries` contain at most one record per `sessionId`. Their records are written in ascending Unicode code-point order by `sessionId`. A record with an empty payload array is invalid; absence means an empty namespace.
- `branches` contains at most one record per `(sessionId, branchId)` and is written by ascending `sessionId`, then ascending `branchId`. An explicitly scoped empty branch is valid in v2 because its outer keys make ownership unambiguous.
- Thought arrays preserve persisted admission order. Branch thought arrays preserve branch order. They are never sorted by `thought_number`.
- Edge and summary arrays are ascending by `createdAt`, with ascending `id` as the deterministic tie-breaker. `Summary.coveredIds` keeps its canonical chronological order.
- Every v2 thought has a present, non-empty `id`. Within one session, an ID may occur in main history and branch material only when every occurrence is deeply equal after parsing through `SequentialThinkingSchema`; conflicting payloads are invalid. Duplicate IDs inside one array are invalid. Edge IDs and summary IDs are unique within their session.
- A thought with absent `session_id` is valid only inside the `__global__` record. A present `thought.session_id`, every `edge.sessionId`, and every `summary.sessionId` must equal its enclosing `sessionId`. A summary's optional `branchId` must satisfy `BranchIdStringSchema`, but it need not have a live branch record because summaries may represent collapsed branches. A branch thought follows the same absent-global/present-equals-outer rule.
- `maxHistorySize` applies independently to each thought-session array, removing the oldest entries from that session only. Scoped deletion removes that session's thought record, branch records, edge record, and summary record in one serialized snapshot mutation. Global deletion publishes the canonical empty document with all four arrays empty.

Parsing is fail-closed. Unknown envelope/record fields and missing, invalid, duplicate, out-of-order, cross-session, or conflicting values produce a typed persistence compatibility error and no state is exposed as a successful empty store. Payload-object key behavior remains exactly that of the referenced canonical payload schemas. A missing `snapshot.json` is a new empty v2 store only when none of the legacy paths `history.json`, `branches/*.json`, `edges/*.json`, or `summaries/*.json` exists. If any legacy path exists, ordinary startup returns a typed import-required error. A present `snapshot.json` without the exact literal version is invalid v2 and is never guessed to be legacy.

## Approved SQLite v2 schema

Task 7 must create exactly the following logical schema. Identifier and payload refinements are the same as File v2. `session_id` is always non-null text; `__global__` is the only encoding for the global namespace. Application reads reconstruct and validate `ThoughtData`, `Edge`, and `Summary` through the same canonical schemas named above. No JSON parse or schema failure is filtered into an empty result.

```sql
CREATE TABLE schema_version (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 2)
);

INSERT INTO schema_version (singleton, version) VALUES (1, 2);

CREATE TABLE thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (length(session_id) BETWEEN 1 AND 100),
  CHECK (session_id NOT GLOB '*[^A-Za-z0-9_-]*')
);

CREATE INDEX idx_thoughts_session_id ON thoughts(session_id, id);

CREATE TABLE branches (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session_id, branch_id),
  CHECK (length(session_id) BETWEEN 1 AND 100),
  CHECK (session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (length(branch_id) BETWEEN 1 AND 50),
  CHECK (branch_id NOT GLOB '*[^A-Za-z0-9_-]*')
);

CREATE TABLE edges (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  PRIMARY KEY (session_id, id),
  CHECK (length(session_id) BETWEEN 1 AND 100),
  CHECK (session_id NOT GLOB '*[^A-Za-z0-9_-]*')
);

CREATE INDEX idx_edges_session_created ON edges(session_id, created_at, id);
CREATE INDEX idx_edges_from ON edges(session_id, from_id);
CREATE INDEX idx_edges_to ON edges(session_id, to_id);

CREATE TABLE summaries (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id TEXT,
  root_thought_id TEXT NOT NULL,
  covered_ids TEXT NOT NULL,
  covered_range_start INTEGER NOT NULL,
  covered_range_end INTEGER NOT NULL,
  topics TEXT NOT NULL,
  aggregate_confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  meta TEXT,
  PRIMARY KEY (session_id, id),
  CHECK (length(session_id) BETWEEN 1 AND 100),
  CHECK (session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (branch_id IS NULL OR (
    length(branch_id) BETWEEN 1 AND 50
    AND branch_id NOT GLOB '*[^A-Za-z0-9_-]*'
  )),
  CHECK (aggregate_confidence >= 0.0 AND aggregate_confidence <= 1.0)
);

CREATE INDEX idx_summaries_session_created
  ON summaries(session_id, created_at, id);
CREATE INDEX idx_summaries_session_branch
  ON summaries(session_id, branch_id);
```

The single `schema_version` row is authoritative. An empty database may receive this DDL. A database with version `2` must match the full DDL and indexes before use; drift is a typed compatibility error. A database with any other version, multiple/no version rows, a version table but legacy tables, or tables that match neither exact unversioned v1 nor exact v2 is rejected without mutation. Ordinary startup never migrates an unversioned database.

All replacements and clears are transactional. Saving a thought inserts and enforces that session's retention limit in one transaction. Saving a branch replaces only `(session_id, branch_id)`. Saving edges or summaries deletes and inserts only the named session in one transaction. Scoped clear deletes that session from all four payload tables in one transaction. Explicit global clear deletes all four payload tables in one transaction but retains `schema_version`. Any statement, constraint, validation, or commit failure rolls the whole operation back and is returned; no partial success or empty-store fallback is allowed.

## Frozen legacy migration fixtures

Migration tests use immutable sources and separate, initially absent destinations. File import writes a new v2 `snapshot.json` only under a separate destination directory. SQLite import opens the source read-only, writes the exact v2 DDL and all copied rows to a new temporary destination database inside one `BEGIN IMMEDIATE` transaction, writes the version row last, runs validation before `COMMIT`, closes it, and atomically publishes it at the separate destination path. If the final destination already exists, import rejects before opening it for write. Any failure issues `ROLLBACK`, removes only the importer-owned temporary destination, leaves no published destination, and leaves every source byte unchanged. These imports are explicit commands against fixtures or approved disposable copies only.

The accepted File v1 source layout is exactly a missing or JSON-array `history.json`, zero or more `branches/<branch-id>.json` JSON arrays, zero or more `edges/<session-id>.json` `EdgeSchema[]` values, and zero or more `summaries/<session-id>.json` `SummarySchema[]` values. Branch IDs must satisfy `BranchIdStringSchema`; filename session IDs must satisfy `SessionIdStringSchema`. A source with `snapshot.json`, unknown JSON files in these namespaces, or both v1 and v2 payload paths is not an accepted v1 layout.

The accepted SQLite v1 source is unversioned and has the exact current tables: `thoughts(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s', 'now')))`, optional `branches(branch_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER DEFAULT (strftime('%s', 'now')))`, `edges(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT)`, and `summaries(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, branch_id TEXT, root_thought_id TEXT NOT NULL, covered_ids TEXT NOT NULL, covered_range_start INTEGER NOT NULL, covered_range_end INTEGER NOT NULL, topics TEXT NOT NULL, aggregate_confidence REAL NOT NULL, created_at INTEGER NOT NULL, meta TEXT)`. The `branches` table is absent only for a backend created with `persistBranches: false`; no branch rows are inferred in that variant. The exact five indexes are `idx_thoughts_created_at(created_at)`, `idx_edges_session(session_id)`, `idx_edges_from(session_id, from_id)`, `idx_edges_to(session_id, to_id)`, and `idx_summaries_session(session_id)`. SQLite internal objects such as `sqlite_sequence` are permitted. Any other user table, trigger, view, or user-created index is unknown schema and rejected.

The exact fixture matrix is:

| Fixture | Exact source condition | Required result |
| --- | --- | --- |
| `accepted-empty-v1` | Exact unversioned v1 layout/schema; all payload collections empty or legacy files absent. | Import one canonical empty v2 destination. |
| `accepted-global-v1` | Valid thoughts omit `session_id`; every non-empty branch also contains only omitted IDs; edge/summary namespace is `__global__`. | Map every omitted identity to `__global__`; preserve payload fields and array order. |
| `accepted-partitioned-v1` | History may mix omitted IDs and valid explicit IDs; each non-empty branch resolves to exactly one identity after omitted-to-global mapping; edge/summary namespace agrees with its filename/column. | Retain valid explicit IDs, map only omitted IDs to global, and emit distinct v2 namespaces. |
| `accepted-empty-scoped-v2` | Exact v2 input has a branch record with valid explicit outer keys and an empty thought array. | Preserve the empty scoped branch; it is not legacy ambiguity. |
| `accepted-already-lossy-v1` | The only observable `shared` branch row/file contains valid session-B thoughts; the fixture states an earlier session-A value was overwritten by v1's single-key layout, but no A bytes remain. | Import only the observable B branch. Emit no A branch and make no recovery claim. |
| `rejected-empty-unscoped-branch-v1` | A legacy branch row/file contains `[]`, so no session can be inferred. | Typed ambiguous-legacy error; no destination published. |
| `rejected-mixed-branch-v1` | One legacy branch contains thoughts resolving to more than one session. | Typed ambiguous-legacy error; no destination published. |
| `rejected-invalid-session-v1` | Any explicit thought session, edge/summary filename, or SQLite `session_id` fails `SessionIdString`. | Typed validation/compatibility error; no destination published. |
| `rejected-namespace-mismatch-v1` | An edge or summary payload identifies a session different from its legacy filename/row namespace, or a branch's resolved session conflicts with its enclosing namespace. | Typed compatibility error; no destination published. |
| `rejected-corrupt-json-v1` | Any JSON document/column is malformed or fails its canonical payload schema, including malformed metadata/list columns. | Typed corruption error naming the source record; no destination published. |
| `rejected-duplicate-or-conflicting-id-v1` | Duplicate IDs violate the v2 uniqueness rules, or one thought ID has non-equivalent payloads in the same session. | Typed compatibility error; no destination published. |
| `rejected-unknown-file-layout` | `snapshot.json` lacks literal numeric version `2`, has unknown/extra envelope fields, or coexists with legacy payload files in one source directory. | Typed compatibility error; do not guess precedence. |
| `rejected-unknown-sql-schema` | SQLite has a non-2/malformed version record, v2 drift, partial legacy tables, extra payload columns/tables that make the layout ambiguous, or neither exact v1 nor exact v2 schema. | Typed compatibility error before destination write. |
| `rejected-existing-destination` | The requested destination file/directory already exists, even if empty or v2-shaped. | Reject before mutation; never overwrite it. |
| `rejected-interrupted-import` | A deterministic fixture injects failure after at least one destination table/file payload is staged but before publication. | Roll back/remove only temporary output; source hashes and destination absence remain unchanged. |

Task 7's fixture manifest must name the fixture, backend, source SHA-256, expected disposition/error code, destination path, destination SHA-256 when accepted, and post-run source SHA-256. A test skip is not a fixture result. The SQLite cases remain blocked as conformance evidence until Task 18's approved driver is provisioned, but File and Memory work and all other non-Task-18 work may proceed.

## Vitest baseline and ambiguity

The package scripts currently invoke `vitest run` and `vitest run --coverage` without a config path. Both `vitest.config.ts` and `vitest.config.js` exist:

- `vitest.config.ts` sets 30-second test, hook, and teardown timeouts; includes `src/**/*.{test,spec}.{ts,tsx}` and `src/**/*.eval.ts`; and enforces branches 90%, functions 60%, lines 65%, and statements 65%.
- `vitest.config.js` sets globals and coverage provider/reporters/exclusions but has no include list, timeouts, or thresholds.

The coexistence of two auto-discoverable files makes the default package-script contract ambiguous. Plan commands must pass `--config vitest.config.ts` until task 18 makes the default and explicit paths equivalent. This baseline's explicit TypeScript-config coverage run executed 2,174 tests: 2,157 passed and 17 skipped. It exited 1 because branch coverage was 89.95% against 90%. Statements 95.17%, functions 93.41%, and lines 95.45% passed their thresholds. This known branch-threshold failure predates wave-0 documentation and remains visible.

## Existing skipped tests

The 17 skips observed by the explicit verbose run are intentional baseline gaps, not passes:

| Count | Tests | Reason |
| ---: | --- | --- |
| 11 | `ToT vs Sequential Eval`: Linear Converge, Plateau, Dead End, Branch Opportunity, Fast Converge, Slow Progress, Contradiction Recovery, Multi-Branch, Single Thought, Empty History, summary | The enclosing suite uses `describe.skipIf(!process.env.RUN_EVAL)`. `RUN_EVAL` was not set for the baseline. |
| 1 | `Battle Test > runs category regression gates` | The enclosing suite uses `describe.skipIf(!process.env.RUN_EVAL)`. `RUN_EVAL` was not set. |
| 2 | Compression persistence, SQLite backend: flag ON summary round trip; flag OFF produces no summaries | `better-sqlite3` is unavailable, so the SQLite cases use `it.skipIf`. These are not SQLite conformance evidence. |
| 2 | DAG edge integration, SQLite backend: mixed edge-set round trip; topological order across restart | `better-sqlite3` is unavailable, so the SQLite cases use `it.skipIf`. These are not SQLite restart evidence. |
| 1 | SSE endpoint custom path | The test is explicitly skipped because its open SSE connection caused test timeouts; only constructor/factory acceptance was covered. |

Task 18 is **[blocked: owner approval of an exact pinned test-only better-sqlite3 version and provisioning method]**. No version or provisioning mechanism has been selected. Optional skips are not evidence and cannot satisfy Task 7/17/18 SQLite conformance. All non-Task-18 work may proceed, including File/Memory contracts and source-only work that does not claim live SQLite compatibility. Once the owner records the exact test-only pin and provisioning method, Task 18 must make missing required SQLite verification fail visibly; it must not convert these skips into evidence, lower coverage, or add a production dependency.

## Requirement and follow-up trace

| Requirement | Baseline invariant and failure | Repair task(s) | Cross-component or release proof |
| --- | --- | --- | --- |
| R01 | Preserve valid JSON-RPC object parameters; custom network adapters currently erase them. | 2 | 17, 18 |
| R02 | Reset one session without deleting another session's durable data; current named clear calls global backend clear. | 7, 8, 9 | 17 |
| R03 | Restore persisted thoughts and branches to their stored session partitions; current restore places them in global state. | 7, 10 | 17 |
| R04 | Every successful file save must publish a complete, recoverable snapshot; concurrent direct writes currently lose data or corrupt JSON. | 6, 7 | 17 |
| R05 | Drain accepted work before successful shutdown and await owned pool/server stops; current flush/stop paths can return early. | 8, 15, 16 | 17, 18 |
| R06 | Preserve same-session exclusion after a waiter times out; current tail deletion can let a later caller bypass an active holder. | 3 | 9, 11, 17 |
| R07 | Apply validated configuration to actual runtime services; current factory wiring and tool TTL override discard selected values. | 4 | 17, 19 |
| R08 | Bind continuation admission and consumption to its session and owner context; current token-only resume lets another session consume it. | 11 | 17 |
| R09 | Reject invalid explicit session input before any reset or branch mutation; current normalization can broaden reset to global. | 9 | 17 |
| R10 | Coordinate retention and eviction across history, graph, summaries, suspensions, hints, calibration, and pending writes; current eviction leaves edges. | 13 | 17 |
| R11 | Resolve numeric references against retained session identities; current length checks drop a retained target after trimming. | 12 | 17 |
| Late network completion | Reproduce and then give timeout, late success/failure, disconnect, and accounting one idempotent finalization owner. | 14 | 15, 16, 17 |
| SSE pool identity and routing | Reproduce with two initialized clients, then correlate POST routing to the server-issued connection identity under the approved bearer-correlation limit. | 15 | 16, 17 |
| Watcher refresh | Reproduce watcher use of cached one-shot discovery, then add explicit refresh/invalidation for real add/change/unlink events. | 5 | 16, 17 |
| Mutable discovery result | Reproduce cached-array aliasing, then return snapshots that caller mutation cannot corrupt. | 5 | 17 |

Tasks 18 and 19 enforce release checks and update operator-facing guarantees only after integration evidence exists. Final checks F1-F4 audit traceability, code quality, real surfaces, and scope. Documentation alone never changes a finding's status.

## Approved decisions and failure behavior

All rows are approved for implementation exactly as recorded here. A failed implementation assumption stops dependent work and requires a plan revision; it does not grant authority to choose a different compatibility policy.

| ID | Status | Approved contract and required failure behavior | Primary dependent tasks / compatibility gate |
| --- | --- | --- | --- |
| D0 | APPROVED | Ordinary thought success means admission to the live session, not disk commit. Explicit drain/reset and successful shutdown include all work inside their admission boundary, including owned branch, edge, and summary writes. A response timeout is not rollback; still-running accepted work remains tracked. | 8, 9, 14, 16; acceptance-versus-durability clarification. |
| D1 | APPROVED | Add awaitable public `resetSession(sessionId: string): Promise<void>` and `resetAll(): Promise<void>` with validation and current owner rules. Missing thought identity maps only to `GLOBAL_SESSION_ID`. Keep `clear(...): void`: permit immediate clear only for an idle persistence-disabled scope, otherwise reject before mutation with a typed async-reset-required error. Owner-scoped reset-all cannot affect other owners. | 7, 9; published API/behavior and release-version gate. |
| D2 | APPROVED | Add a session-aware persistence capability while retaining legacy global methods as explicit global operations. Unsupported custom backends reject named durable operations without global fallback. File and SQLite v2 must use the exact schemas, ordering, refinements, transaction rules, and fixture dispositions frozen above. Memory mirrors those namespaces. | 7; exact public persistence capability and data-format gate is satisfied for implementation. Only fixtures/disposable destinations may be migrated. |
| D3 | APPROVED | Permit one active writer per canonical file-storage directory across instances and processes. Acquire ownership before mutable load, serialize every mutation, and release only ownership held by that instance. Competing writers fail explicitly. Never auto-steal a stale-looking lock. Pooled SSE plus per-session file backends sharing a directory fails at startup before acquisition. | 6, 15; supported-topology gate, not distributed coordination. |
| D4 | APPROVED | Missing legacy thought session identity maps to global; a valid explicit identity is retained. A legacy branch maps only when all entries agree after that rule. Mixed/invalid identities or an empty unscoped branch are ambiguous: preserve the input and stop with a typed compatibility error. Explicit import writes only v2 to a separate destination and never overwrites legacy input. Never fabricate already-overwritten data. | 7, 10; legacy-data gate. Old binaries are not assumed to read v2. |
| D5 | APPROVED | A transport connection ID is not a durable principal. Do not persist random request owners, infer ownership from a session name, or let the first network caller claim restored data. Restored namespaces remain available to trusted ownerless library/stdio access; owner-aware network access without a verified durable owner binding is rejected. No identity system is added. | 10, 15, 17; deployment/compatibility gate. Persistent shared-network recovery remains unsupported. |
| D6 | APPROVED | Validate the complete request before reset or branch registration. Reset freezes the target, joins prior accepted work, performs scoped durable deletion, clears live/auxiliary state, then admits the replacement thought. On persistence failure, return an error and keep the scope closed until explicit successful recovery/reset; do not claim rollback of unknown I/O. Other sessions remain unchanged. | 8, 9, 13; ordering contract after session-capability work. |
| D7 | APPROVED | Resolve a numeric reference across all retained thoughts in its session and deduplicate by stable thought ID. Keep one distinct match. Drop an optional missing or ambiguous reference with the existing warning and emit no edge. If an operation requires the reference, fail with its existing validation error before mutation. Never select the first ambiguous match. | 12; conservative retained-reference policy with unchanged public numeric fields. |
| D8 | APPROVED | Preserve SSE base paths and current connected-event `sessionId` plus GET `session`/`sessionId` forms. Add the same server-issued `sessionId` as POST `/sse/message` query correlation when pooling is enabled; reject missing, unknown, or stale values. This is bearer-style correlation, not authentication, and does not protect a stolen valid value. | 15; wire-compatibility gate because formerly accepted POSTs gain a routing requirement. |
| D9 | APPROVED | Keep the 30-second CLI outer shutdown budget across shipped modes. Stop new admission first; repeated stop/signal joins one outcome. Deadline expiry or drain/close failure exits nonzero with stderr diagnostics and never reports a clean drain. Tests inject shorter deadlines without adding a public setting. | 16; bounded CLI behavior. |
| D10 | APPROVED | Keep Node 24/26 library jobs and add a Bun CLI artifact check. Native SQLite remains optional for ordinary consumers but requires a dedicated conformance job before claims cover it. Record and approve exact tool/test-only dependency versions; use no floating `latest` and add no worker-selected runtime requirement. Missing required native verification blocks release acceptance. | 18 is `[blocked: owner approval of an exact pinned test-only better-sqlite3 version and provisioning method]`; no version is selected. |

## Compatibility and release gates

Implementation approval does not by itself make the following changes release-compatible:

| Change class | Approved default | Release condition and failure boundary |
| --- | --- | --- |
| Public reset behavior | Awaitable scoped/admin methods are additive; synchronous clear remains typed `void` but rejects persistent or active scopes before mutation. | Version policy and migration guidance must acknowledge changed synchronous behavior. No detached durable clear may remain. |
| Persistence capability | Built-ins implement session-aware operations; legacy globals remain explicit; unsupported custom implementations reject named durable work. | Backend conformance and custom-backend rejection must pass before release. No global fallback. |
| Durable format | File/SQLite v2 is explicit and versioned; import is requested, one-way to a separate destination, and transactional where specified. | Accepted, ambiguous, corrupt, and already-lossy fixtures must pass. No startup or live migration. Do not point an old binary at v2. |
| Writer topology | One canonical directory has one active writer. | Competing instances/processes and unsupported SSE pool topology must fail before mutation or conflicting acquisition. |
| Restored network ownership | No durable principal is inferred. | Reject owner-aware network recovery without verified durable binding. Do not advertise authenticated multi-tenancy. |
| SSE pooled POST routing | Existing base paths and connected identity remain; pooled POSTs require server-issued correlation. | Initialized two-client wire tests must prove routing and rejection behavior. Correlation remains bearer-style, not authentication. |
| Shutdown | Existing outer 30-second budget applies to all shipped modes. | Failure or deadline is nonzero with stderr diagnostics; success requires joined owned work. |
| Runtime and SQLite verification | Node 24/26 library checks, Bun CLI artifact check, dedicated approved native-SQLite conformance. | Missing required matrix evidence blocks release. It is not converted to a skip or a production dependency change. |

## Baseline tests and missing invariants

The targeted baseline command passes 24 tests across `HistoryManager.ownership.test.ts` and `SessionLock.test.ts`. It proves current owner checks for live session reads/writes/clear and ordinary lock serialization, independent-session concurrency, timeout rejection, error recovery, and eventual map cleanup.

It does not prove the repair contracts. The ownership suite uses no persistence backend and therefore does not show that clearing A preserves durable B, that reset waits for queued writes, or that invalid input leaves state unchanged. The lock suite checks one stuck holder plus one timed-out waiter, but does not enqueue a third caller after the timeout while the first holder is still active. Those missing schedules are the required red tests for later tasks.

## Evidence and update rule

Wave-0 evidence is stored under `.omo/evidence/tracelattice-reliability-hardening/20260909-wave0/`. These repository-relative paths are execution receipts, not public documentation links. The baseline log records command exits, including the coverage exit 1. The contracts receipt records direct-source and graph coverage plus the exact execution-input SHA-256 manifest. The skip receipt retains all observed skips and the Task 18 block. The cleanup receipt records temporary resource teardown and final scope checks.

Later tasks must cite their current revision and retained red/green/real-surface evidence. If evidence changes a contract, stop dependent work and revise the accepted plan and this document through review. Do not silently reinterpret this baseline.
