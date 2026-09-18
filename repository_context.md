# Repository Context

## Scope and Method

This analysis covers the working tree at commit `7e9c74c7e59c4c18015656877bda29cd85eca015`, inspected on 2026-09-18. The initial working tree was clean. An inventory of all 325 tracked files preceded delegation; all 26 tracked `AGENTS.md` files and the applicable global guidance were read. Counts below include guidance files and distinguish executable tests from support assets.

Five parallel, read-only reviews covered architecture (A), runtime behavior (B), quality/security/performance (C), build/delivery (D), and developer/project use (E). A replacement quality review recovered an inaccessible report. The coordinator reconciled their findings against source, tests, and configuration, then obtained independent Librarian and Oracle reviews of uncertain interpretations, external contracts, and proposal boundaries. Only the coordinator wrote these four artifacts. The humanizer workflow was applied separately to this evidence context and each proposal, preserving the required structure and technical meaning.

Structural discovery used graph project `Volumes-Data-oss-oc-TraceLattice`, generation `2026-09-18T01:43:46Z`, with exact-path coverage checks and direct source fallback. Clean coverage metadata is not proof of complete indexing: an interface-mediated `compressBranch` caller was missing from a graph trace but present in `ThoughtProcessor`. Tests, configuration, guidance, and release scripts were inspected directly where graph evidence was insufficient. Coverage here means every inventoried area received review, not that every line was dynamically exercised.

Statements tied to paths or symbols below are source observations unless marked **Inference**, **Decision**, or **Unresolved**. No product tests, builds, installations, benchmarks, or release commands were run, because those can change generated artifacts outside the permitted four files. Test names establish intended coverage, not passing results. Final artifact checks are separate from product verification.

## Repository Map

TraceLattice is an MIT-licensed MCP sequential-thinking server and reusable ESM library, published as `@iworkforces/tracelattice` version `2.0.6` (`package.json`). It accepts reasoning steps and returns structured reasoning signals, strategy decisions, tool/skill recommendations, and optional graph/compression data. The stack is strict TypeScript, Valibot, `tmcp`, a custom typed DI container, Node HTTP primitives, Chokidar discovery, and file/SQLite/memory persistence. Rslib builds the library; Rsbuild builds a Bun-entry CLI; Vitest supplies tests and coverage.

| Area | Responsibility and evidence |
| --- | --- |
| `src/lib.ts`, `src/di/` | Public factories and server lifecycle; `_createContainerCore` wires the 20 keys in `ServiceRegistry`. |
| `src/cli.ts`, `src/CliLifecycle.ts` | Executable startup, stdio or Streamable HTTP selection, signals, stdin end, and bounded shutdown. |
| `src/schema.ts`, `src/ServerConfig.ts`, `src/contracts/`, `src/types/` | Input/configuration schemas, branded identifiers, shared contracts, discovery metadata. |
| `src/core/` | Admission, live history ownership, session coordination, persistence scheduling, references, graph, evaluation, strategies, suspension, compression. |
| `src/persistence/` | File and SQLite v2 codecs/snapshots, strict restore, scoped sinks, explicit legacy import, memory implementation. |
| `src/transport/`, `src/context/` | HTTP adapters, accepted-work tracking, response finalization, request/owner async context. |
| `src/registry/`, `src/watchers/`, `src/cache/`, `src/config/` | Tool/skill discovery, refresh serialization, snapshots/cache, configuration loading. |
| `src/logger/`, `src/metrics/`, `src/health/`, `src/pool/` | Stderr logging, metrics, health checks, optional connection pool. The pool is not on the CLI path. |
| `src/__tests__/`, `src/metrics/__tests__/` | Unit, type, integration, lifecycle, persistence, evaluation, and release checks. |
| `scripts/`, `.github/workflows/` | Packed-artifact verification and publication of that same verified tarball. |

**Inference:** This is a disciplined but transitional repository: typed contracts, lifecycle integration tests, and release gates are substantial, while several documents describe older behavior. Neither the test inventory nor the package version establishes deployment maturity or current CI health.

## Architecture and Key Flows

`createServer()` and `ToolAwareSequentialThinkingServer.create()` in `src/lib.ts` build the container, arrange watcher readiness and persistence restoration, and expose the server API. `initializeServer()` is the CLI convenience seam. `src/cli.ts` remains separate from the published `src/lib.ts`; importing the library must not start the CLI.

`ThoughtProcessor.process()` is the admission boundary: normalize and validate input, apply feature-type restrictions, enter `SessionLifecycleCoordinator`, take the per-session lock, resolve cross-references, and admit a thought or tool-continuation operation. Accepted verification outcomes feed calibration; ordinary admitted thoughts then pass through formatting, evaluation, hint selection, and pure strategy `decide()` calls. A terminating branch can invoke compression (`src/core/ThoughtProcessor.ts:612`, `:639`). Tool calls suspend instead of running the ordinary evaluate/strategy tail; observations use `InMemorySuspensionStore.compareAndAdmit` so token consumption follows successful admission.

`HistoryManager` owns live history, branches, ownership, and retention. Branch thoughts appear in both main history and their branch; retention can remove the main copy while retaining the branch copy. `ThoughtReferenceIndex` and `inspectSession()` account for retained state across those views (`src/core/HistoryManager.ts:620`, `:705`). Backtracking is append-only retraction, not deletion. `SessionManager` chooses retention/eviction policy; lifecycle coordinators perform exclusive mutations. A network owner comes from `RequestContext`; restored sessions reject owner-aware access rather than inventing a durable principal.

Persistence sinks do not own the scheduling loop. `PersistenceBuffer`, `PersistenceWorkQueue`, and `PersistenceWriter` coordinate queued work, barriers, retry/drain behavior, and failure quarantine. Reset freezes admission, joins relevant work, clears durable and auxiliary state, and only then permits replacement state (`src/core/SessionResetCoordinator.ts`, `src/core/SessionLifecycleCoordinator.ts`). A successful thought response means live admission, not an fsync acknowledgment. A request timeout does not roll back already accepted work.

Graph writes belong to `EdgeEmitter`; `GraphView` derives nodes from edges and traverses descendants across edge kinds. Isolated thoughts therefore need explicit treatment outside edge-derived node views. Strategies consume snapshots and must not mutate graph/history or perform I/O (`src/contracts/strategy.ts`, `src/core/reasoning/strategies/`). The calibration implementation uses per-type empirical means and temperature scaling, not maintained Beta alpha/beta counters (`src/core/evaluator/Calibrator.ts:53`, `:179`). Outcome admission is specifically `verification` plus `verification_result`, with a retained, unretracted target having confidence (`src/core/VerificationOutcomeAdmission.ts:16`).

Shared contracts live in `src/contracts/`, except the established `IHistoryManager` and thought types in `core/`. Keep ESM `.js` specifiers, typed DI resolution, branded session construction through `asSessionId`, and `GLOBAL_SESSION_ID`. Do not add barrels or type-error suppressions. `.sentrux/rules.toml` defines nine layers, a cycle budget of 1, cyclomatic complexity 25, function length 100, and explicit forbidden edges: transport to core/registry, watchers to persistence, persistence to transport, registry to `HistoryManager`, and the reserved cluster-to-registry rule. The known `BaseTransport` session-pattern import does not authorize more transport-to-core dependencies; `cluster/` is absent.

## Product and Runtime Behavior

The tool schema supports numbered thoughts, hypotheses/verification, branching/revision, recommendations, richer thought types, session selection, reset, and continuation metadata (`src/schema.ts`, `src/core/thought.ts`). Feature writes are controlled by seven settings in `src/contracts/features.ts`; production validation defaults booleans on, unlike the processor's off-by-default constructor flags. Stores generally remain wired when writes are disabled; suspension storage is the exception. Evaluation is heuristic and labels are supplied through the input contract, not independently proven ground truth.

The CLI uses stdio by default and supports Streamable HTTP through `TRANSPORT_TYPE`. `HttpTransport` is a separate library JSON-RPC adapter, not the CLI HTTP path. Streamable HTTP stores transport sessions with timestamps and SSE response sets (`src/transport/StreamableHttpTransport.ts:99`, `:160`). Headerless valid POST admission creates a session; it is not restricted to an initialize method by `_resolveSession`. Existing POST and GET paths update activity, but there is no session expiry loop or map capacity limit. Closing an SSE response removes that response, not the transport session (`:516`, `:591`). Core session limits do not bound this separate map.

HTTP defaults include a 10 MB body bound and a 30-second request timeout; host, CORS, and rate-limit checks live in the transport helpers/base class. `AcceptedWorkTracker` retains actual handler promises after a response closes or times out (`src/transport/HttpRequestLifecycle.ts:76`). `StreamableHttpTransport.stop()` closes streams, clears sessions, closes the server, and joins accepted work; repeated calls share shutdown state (`src/transport/StreamableHttpTransport.ts:752`). `CliLifecycle` orders transport shutdown before server shutdown and applies the outer shutdown budget. Session counts, notification-stream gauges, health responses, and `clientCount` are observable lifecycle surfaces.

File v2 uses validated snapshots and canonical single-writer ownership, with no lock stealing (`src/persistence/FilePersistence.ts`, `FileWriter.ts`, `FileSnapshotValidation.ts`). SQLite v2 uses its driver seam and transactional scoped operations (`SqlitePersistence.ts`, `SqliteSnapshotWriter.ts`, `SqliteSchemaV2.ts`). Legacy import is explicit and targets a separate destination; startup is not a migration path. Custom scoped persistence must satisfy the full capability contract, never emulate a named-session clear through a global clear. Memory persistence preserves scope semantics without durability.

## Quality, Security, and Performance

Valibot schemas bound identifiers, numbers, envelopes, and structured input. Normalization separately transforms free text. `sanitizeString()` strips selected tag tokens and C0 controls, not arbitrary HTML or tag contents (`src/sanitize.ts:17`, `:84`); its script example overstates removal. `enforceJsonShape()` defaults to depth 8 and 16,384 serialized UTF-8 bytes, rejects dangerous object keys and unsupported values, and uses a traversal-wide `WeakSet` (`:139`). Repeated noncyclic object identity is consequently rejected too; that concerns direct in-memory callers rather than ordinary parsed JSON.

`StructuredLogger.format()` can throw during JSON serialization in either mode; caller impact is unverified (`src/logger/StructuredLogger.ts:241`). Concrete loggers expose `createChild`, but the shared `Logger` interface does not (`:27`, `:374`). The logger guidance explicitly says not to widen that interface merely for watcher no-op loggers. Metrics retain distinct name/label tuples until reset and do not impose a cardinality budget or validate all insertion arguments (`src/metrics/metrics.impl.ts:105`, `:152`, `:220`, `:318`). Low-cardinality labels are a governing convention, not an enforced limit.

**Inference:** Unbounded transport sessions can accumulate under repeated new-session admission. SSE writes ignore the writable backpressure result (`src/transport/StreamableHttpTransport.ts:644`), so slow consumers deserve separate investigation. `BaseTransport.getClientIp` trusts the first forwarded address; the relevance to rate-limit bypass depends on proxy reachability and header rewriting. None of these observations establishes an exploit, operational incident, or measured performance regression. Logger metadata and metric argument trust were not traced into a demonstrated hostile-input path.

Compression has two connected source-level correctness gaps: reducers resolve only main history while `coveredIds` retains unresolved graph IDs (`src/core/compression/CompressionService.ts:75`, `:127`), and dehydration chooses by numeric range rather than stable identity (`DehydrationPolicy.ts:99`, `:124`). Repeated thought numbers and retained branch-only entries make a range-based result unreliable. Existing tests explicitly preserve ghost/orphan IDs (`src/__tests__/compression/CompressionService.test.ts:242`, `:271`); a repair must replace those characterizations with stronger identity assertions rather than delete coverage.

Tests cover ownership, retained references, reset races, continuation tokens, file ownership, persistence conformance, native SQLite, watcher shutdown, transport disconnects, and child-process shutdown. Helpers and fixtures are not independent executable suites. Type-only `*.test-d.ts` files run through TypeScript; `*.eval.ts` entry points are opt-in through `RUN_EVAL=1`. Battle-test unit tests still run normally. Their baseline/gate machinery is distinct from release coverage (`src/__tests__/eval/battleTest/`). **Unresolved:** Current pass rates, real resource limits under load, and deployment-specific trust boundaries require execution or deployment information not collected here.

## Build, Test, Packaging, and Release

`package.json:23` is the command authority. `npm run verify:library` runs `npm run type-check`, `npm run lint`, `npm run build`, and `npm run test:coverage`. `vitest.config.ts:17` enforces branches 90%, functions 60%, lines 65%, and statements 65%; test/hook/teardown defaults are 30 seconds. Focused suites use `npm test -- <test-path>`. `npm run format:check` exists but is not a hard release gate. Sentrux limits are configured architecture constraints, not a claimed passing CI result.

`npm run verify:native` requires `better-sqlite3@13.0.3` and runs `npm run test:native`. The native test imports the driver directly, rather than silently skipping missing provisioning (`src/__tests__/integration/NativeSqliteConformance.test.ts:4`). `npm run verify:packed` runs `scripts/verify-packed-cli.mjs`. `npm run verify:release` runs library, native, and packed gates; `prepublishOnly` delegates to it. Optional reasoning evaluations are not mandatory release gates.

Rslib emits ESM library files and declarations; Rsbuild emits the CLI bundle with external dependencies (`rslib.config.ts`, `rsbuild.config.ts`, `tsconfig.build.json`). `scripts/postbuild-cli.mjs` alone writes the Bun shebang and executable mode. Published contents are `dist`, `README.md`, and `LICENSE`; the export map permits only the package root and `./package.json` (`package.json:8`). Generated `dist` is not source to edit.

CI runs library verification on Node 24 and 26, native verification on Node 26, and packed verification with an exact Bun 1.4.2 assertion (`.github/workflows/ci.yml`). All three are hard requirements; npm audit is advisory. CI currently invokes `npm install`; reproducibility concerns are not evidence that lock drift occurred. CD validates checksums and the schema-version-1 receipt, then publishes the verified tarball without rebuilding (`.github/workflows/cd.yml`). Packed cleanup errors retain primary failures (`scripts/packed-cli-cleanup.mjs`).

The packed checker verifies library file presence but exercises the CLI runtime, not an external library/type consumer (`scripts/packed-cli-package.mjs:14`, `:142`, `scripts/packed-cli-runtime.mjs`). `install.sh` is an ancillary local installer with a Node >=18 check, whereas README says Node 22+ and CI targets 24/26; it should not be treated as the release support matrix. **Unresolved:** Actual local/native installation, Bun 1.4.2 availability, and current CI success were not established by this analysis.

## Developer Experience and Real-Project Use

The reusable server exposes processing, configuration, registries, history, metrics, reset, stop/dispose, and advanced container access (`src/lib.ts`). Configuration and dependency injection provide useful integration seams, but a type appearing in a signature is not necessarily a supported root constructor export. README's root import of `HttpTransport` is currently unsupported: the implementation exists in `src/transport/HttpTransport.ts:99`, its factory at `:418`, but `src/lib.ts` does not export them and the package export map blocks deep imports. The factory example mentioning `Container` has the same accessibility problem (`src/lib.ts:784`).

Discovery separates passive registry state from filesystem watchers. `BaseRegistry` coalesces refresh, atomically replaces discovered snapshots, retains last-known-good data on refresh failure, and gives manual entries precedence. Watchers serialize refresh and join it during stop. `DiscoveryCache` copies snapshots and supports TTL/LRU behavior; explicit empty tool/skill directory settings disable those roots (`src/registry/BaseRegistry.ts`, `src/watchers/`, `src/cache/DiscoveryCache.ts`, `src/config/ConfigLoader.ts`, `src/lib.ts`). This is already a substantial extension seam, so a generic discovery rewrite is not one of the selected challenges.

Documentation needs source-aware maintenance. README's 18-service count differs from the 20-key registry; calibration prose describes Beta priors more strongly than the implementation supports; tool-result outcome descriptions differ from verification-only admission. `.example.env` and some comments show defaults that differ from `ServerConfig.validateFeatures`. Both consultants reviewed these discrepancies; source resolves them, despite the Librarian's initial conservative unresolved classification. `docs/reliability-contract.md` explicitly preserves a September 9 baseline and prior decisions, not proof of current repairs or current test results. Its historical native-provisioning and test-configuration observations must not override current scripts and CI.

**Inference:** The codebase is a plausible foundation for a local coding assistant or a controlled reasoning service, particularly where retained history and deterministic strategy decisions matter. An internet-facing service would still need an explicit identity/proxy policy and a protocol-version decision; neither is supplied by a transport session identifier.

## Constraints, Risks, and Opportunities

The three challenges below are proposed changes, not implemented behavior. They target different owners: transport resource lifetime, core summary identity, and the published library/release boundary. Each requires interacting behavior and negative tests across existing seams, rather than boilerplate or unrelated cleanup.

External reconciliation used versioned primary sources. The [2025-11-25 MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) describes session headers, GET streams, and 404 after termination; the retrieved [2026-07-28 Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) removes protocol sessions and changes streaming/cancellation behavior. **Decision:** Proposal 1 preserves the repository's existing stateful model, not a partial upgrade or a claim of full conformance. Authentication, DELETE, cancellation modernization, and backpressure are separate work.

Other consultation references were [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices), [Node HTTP documentation](https://nodejs.org/docs/latest-v26.x/api/http.html), [Node backpressure guidance](https://nodejs.org/learn/modules/backpressuring-in-streams), [JSON.stringify semantics](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify), and [Prometheus naming/cardinality guidance](https://prometheus.io/docs/practices/naming/). These qualify source observations; they do not prove deployment exploitability. Both consultants reviewed all retained risk interpretations. A review claim that the native driver was unapproved was rejected against `package.json:94`, `:102`, CI, and the native suite. Remaining uncertainty concerns execution, deployment topology, intended future protocol support, and whether broader logger/metrics hardening is wanted.

**Rubric trace for proposal 1.** Criterion 1 follows `StreamableHttpTransportOptions`, `_resolveSession`, and the session map (`src/transport/StreamableHttpTransport.ts:46`, `:160`, `:591`): constructor limits must act before new allocation and leave reuse intact. All-or-none positive options and HTTP 503 are explicit challenge policy choices, not existing defaults or protocol mandates. Criterion 2 spans `_handleMcpPost`, `_receiveAndFinalize`, `_handleMcpGet`, `AcceptedWorkTracker`, SSE close callbacks, `clientCount`, health, and session/stream gauges (`:384`, `:485`, `:516`, `:688`, `:727`; `src/transport/HttpRequestLifecycle.ts:76`). Inbound acceptance sets activity; completion only unpins, so a long request may expire on the next sweep. Criterion 3 follows `stop()` and `CliLifecycle`: one disposal path, timer cleanup, repeated-stop joining, and no core/durable eviction. Criterion 4 uses the existing transport unit suites, request-lifecycle tests, and integration transport/shutdown harnesses; release commands and coverage limits above remain unchanged. The constructor-only scope deliberately leaves CLI/environment configuration and stateless behavior unchanged.

**Rubric trace for proposal 2.** Criterion 1 follows `CompressionService.compressBranch` and `HistoryManager.inspectSession`: one retained snapshot, main-first ID precedence, then branch-only entries, resolved in existing graph order; ghost IDs must not enter reducers or coverage. Retained descendants still count when the root is missing; only zero resolved candidates produce empty coverage/topics, confidence 0, and range `[0, 0]`. Criterion 2 follows `DehydrationPolicy.apply` and `InMemorySummaryStore.forSession`: ID membership replaces range authority while first-match order, consecutive-reference collapse, hot suffix 50, and nonmutation remain. Criterion 3 spans `ThoughtProcessor._runStrategy`, `HistoryManager.getHistoryHydrated`, `src/lib.ts:391` summary buffering, `SummarySchema`, scoped stores, file/SQLite persistence, restore, and reset; the existing stored shape already contains `coveredIds`, so no migration or startup rewrite is justified. Criterion 4 draws on `src/__tests__/compression/` and `CompressionAutoTrigger`, `CompressionPersistence`, and `CompressionCoordinatorPersistence` integration tests, including replacement of the ghost/orphan characterizations. Existing reducers, feature gates, session isolation, and root/branch idempotency remain contracts.

**Rubric trace for proposal 3.** Criterion 1 connects `src/lib.ts`, `src/transport/HttpTransport.ts`, `src/transport/BaseTransport.ts:58` (`TransportOptions`), `src/contracts/transport.ts` (`ITransport`, `TransportKind`), and `package.json` exports: add only the named transport surface while preserving existing server exports and blocked deep imports. Criterion 2 follows the temp consumer in `scripts/packed-cli-package.mjs:168`: root runtime imports and external TypeScript declaration resolution must come from the installed tarball, without source aliases or exporting DI internals. Criterion 3 extends `scripts/verify-packed-cli.mjs` before successful completion, using the runtime/cleanup helpers; corrupt runtime exports or declarations must fail even when files exist, and all consumers/processes/temp roots must be cleaned up without hiding primary errors. Receipt schema, checksums, CD's no-rebuild publication, and Bun CLI verification remain intact. Criterion 4 covers `typing.test-d.ts`, release artifact/script tests, README and factory examples, and all release gates; positive package consumers and deliberately broken artifacts exercise different failure surfaces. No new dependency is required by this scope.

## Coverage Ledger

Assignments below were made from the initial inventory. A = architecture/dependency boundaries; B = product/runtime; C = quality/security/performance; D = build/delivery; E = developer/project use. Every row is covered by returned findings and coordinator reconciliation. Counts are disjoint, include nested files, and sum to 325.

| Inventoried area | Files | Review coverage and retained result |
| --- | ---: | --- |
| Root files | 17 | D/E/A: package/lock, build and TypeScript configs, ESLint/Prettier configs, environment/ignore files, installer, README, LICENSE, `opencode.json`, root guidance. |
| `.github/` | 2 | D: CI hard/advisory gates and immutable-artifact CD. |
| `.sentrux/` | 1 | A/D: configured layers, limits, forbidden dependencies; coordinator read closed the initial report omission. |
| `.vscode/` | 2 | E: editor settings/extensions, development metadata rather than runtime. |
| `docs/` | 1 | B/E: historical reliability contract, reconciled with current code. |
| `scripts/` | 6 | D: guidance, postbuild, package/runtime/cleanup helpers and verification orchestrator. |
| `src/` direct files | 9 | A/B/C/E: entry points, lifecycle, configuration, schemas/errors/sanitization/utilities and guidance. |
| `src/cache/` | 2 | E: snapshot cache, TTL/LRU and guidance. |
| `src/config/` | 2 | E: configuration loading and guidance. |
| `src/context/` | 1 | B: async request identity/ownership. |
| `src/contracts/` | 12 | A/E: persistence, IDs, features, strategy, summaries, suspension, transport and common interfaces. |
| `src/core/` | 52 | A/B/C: admission/history/session/persistence coordination plus graph, evaluator, reasoning/strategies, tools and compression; all nested guidance included. |
| `src/di/` | 3 | A/E: typed container and registry. |
| `src/health/` | 2 | B/C: health checks and guidance. |
| `src/logger/` | 3 | C: logger implementations, interface and stderr boundary. |
| `src/metrics/` | 3 | C: collector, guidance and the sole colocated test suite. |
| `src/persistence/` | 21 | B/C: memory/file/SQLite sinks, codecs, schemas, writers, imports, native declaration and guidance. |
| `src/pool/` | 4 | B: optional pool contracts, implementation, errors and guidance. |
| `src/registry/` | 4 | E: base/tool/skill registries and guidance. |
| `src/transport/` | 6 | B/C: base/helpers/lifecycle, JSON-RPC and Streamable adapters and guidance. |
| `src/types/` | 5 | A/E: discovery/configuration/disposal types and guidance. |
| `src/watchers/` | 3 | E: tool/skill refresh lifecycle and guidance. |
| `src/__tests__/` direct files | 50 | C plus A/B/E: legacy unit/integration suites, guidance and type-only tests. |
| `src/__tests__/calibrator/` | 1 | C/A: calibration behavior. |
| `src/__tests__/compression/` | 4 | C/A: service, callbacks, identity/range policy and summary store. |
| `src/__tests__/config/` | 1 | C/E: effective feature configuration. |
| `src/__tests__/core/` | 23 | C/A/B: graph/reference/ownership/lifecycle/buffer/suspension/outcome/retraction suites. |
| `src/__tests__/eval/` | 33 | C/D: opt-in eval entry points, executable battle-test units, scenario fixtures, baseline/override JSON, support types and guidance. |
| `src/__tests__/evaluator/` | 1 | C/A: scoring compatibility. |
| `src/__tests__/helpers/` | 4 | C: reusable doubles/factories/timers, not standalone suites. |
| `src/__tests__/integration/` | 35 | B/C/E: persistence/native/ownership/reset/discovery/strategy/compression/transport/shutdown suites, harnesses, child fixtures and guidance. |
| `src/__tests__/release/` | 6 | D/C: workflow, scripts, artifact, single-Vitest-config and legacy-SSE-removal contracts. |
| `src/__tests__/strategies/` | 5 | A/C: strategy purity, determinism, scoring and plateau behavior. |
| `src/__tests__/transport/` | 1 | B/C: accepted-work and response lifecycle. |

The 17 root files are `.example.env`, `.gitignore`, `.prettierignore`, `.prettierrc.json`, `AGENTS.md`, `LICENSE`, `README.md`, `eslint.config.js`, `install.sh`, `opencode.json`, `package-lock.json`, `package.json`, `rsbuild.config.ts`, `rslib.config.ts`, `tsconfig.build.json`, `tsconfig.json`, and `vitest.config.ts`. The lockfile is generated dependency metadata: versions and relevant provisioning were checked, not every transitive record. Tracked evaluation JSON and process fixtures are test inputs, not generated output to skip.

No tracked vendored dependency tree, binary payload, or build-output tree was found. Local `node_modules/`, `dist/`, `coverage/`, `.DS_Store`, and ignored `.omo/` content are dependencies, generated output, OS metadata, or prior agent work; they were classified rather than audited as shipped source. `.git/` is version-control metadata. The local `.mnemonics/` directory has no tracked entries and is auxiliary context, not product behavior. These exclusions do not omit any tracked area. Existing documentation and guidance remained unchanged.

## Proposed Coding Challenges

### Proposal 1: Bound Streamable HTTP session retention

#### Coding Prompt

Add opt-in session capacity and idle expiry to `StreamableHttpTransport` so a long-running host can reclaim abandoned clients without dropping accepted work. Add constructor options `maxSessions`, `sessionIdleTimeoutMs`, and `sessionSweepIntervalMs`; require all three positive integers together, or omit all three to preserve existing behavior without a sweep timer. Reject new sessions with HTTP 503 at capacity while allowing existing sessions to continue.

Refresh activity when an inbound POST or GET is accepted, not when output is sent. Pin a session until its accepted POST handler settles, even after a response timeout or disconnect. Completion releases the pin without refreshing activity, so the next sweep may expire a long-running request's session. An attached SSE stream alone must not prevent expiry.

Close expired streams, remove transport state, and update counts consistently; later requests using that session must receive 404. Reuse cleanup during shutdown and retain accepted-work joining. Keep this constructor-only change out of core history, durable persistence, CLI configuration, and protocol modernization. Add deterministic lifecycle tests, including timeout and shutdown races, and pass the existing release gates.

#### How I Would Use This Codebase

I would embed the HTTP transport in an internal coding-assistant host where clients reconnect throughout the day. I need abandoned connections to release transport resources while slow reasoning requests finish, and I want session counts to describe what the host can still serve.

#### Why This Is Challenging

The response lifetime is shorter than the accepted handler lifetime, and SSE streams have a third lifetime of their own. Expiring a map entry on socket close or request timeout would miss that distinction. Cleanup must also agree with health reporting, metrics, reuse at capacity, and repeated shutdown calls.

#### Evaluation Rubric

1. Validate the all-or-none positive-integer option triplet before starting resources, preserving omitted-option and stateless behavior. At capacity, new-session requests receive 503 without allocation while valid existing sessions remain usable, including concurrent admission attempts.
2. POST and GET acceptance update activity once, while outgoing events and POST completion do not; accepted POST work prevents expiry until actual settlement despite timeout or disconnect. Expiry closes SSE responses, removes the session, makes subsequent use return 404, and updates `clientCount`, health counts, `streamable_http_active_sessions`, and `streamable_http_notification_streams` consistently.
3. `stop()` disables and clears the sweep, shares session disposal with expiry, and retains idempotent shutdown and accepted-work joining through `HttpRequestLifecycle`. Do not invoke core eviction, delete persisted history, add transport-to-core imports, repurpose `ConnectionPool`, change CLI settings, or introduce authentication, DELETE, protocol-version, or backpressure changes; do not relax `.sentrux/rules.toml` limits of complexity 25, function length 100, and cycle budget 1.
4. Add focused cases in the existing Streamable HTTP unit suites and `src/__tests__/integration/TransportLifecycle.test.ts`, exercising held handlers, stale SSE, reuse, expiry boundaries, and repeated stop with awaited cleanup; run `npm test -- src/__tests__/streamable-http-transport.test.ts src/__tests__/streamable-http-cov.test.ts src/__tests__/transport/HttpRequestLifecycle.test.ts src/__tests__/integration/TransportLifecycle.test.ts src/__tests__/integration/TransportContract.test.ts src/__tests__/integration/ShutdownContract.test.ts`. Pass `npm run verify:release`, which includes `npm run verify:library` for type-check/lint/build/coverage, `npm run verify:native`, and `npm run verify:packed`, without reducing coverage thresholds of branches 90%, functions 60%, lines 65%, and statements 65%.

### Proposal 2: Make compression coverage identity-exact

#### Coding Prompt

Fix branch compression so summaries replace only the thoughts they actually summarize. `CompressionService` currently resolves graph coverage through main history, while `DehydrationPolicy` replaces thoughts by number range. Retained branch thoughts and repeated thought numbers must not cause omitted content or unrelated thoughts to disappear.

Resolve graph candidates against one `HistoryManager.inspectSession()` snapshot, preferring main-history entries and adding branch-only entries by stable ID. Build `coveredIds` and all reducers from the same resolved candidates in graph order. A missing root must still allow retained descendants to contribute; when nothing resolves, return empty coverage and topics, zero confidence, and `[0, 0]` range. Keep root identity and existing idempotency.

Use ID membership for dehydration, leaving idless or uncovered thoughts untouched. Preserve the hot suffix, deterministic summary selection, nonmutation, and existing summary storage shape; `coveredRange` remains descriptive metadata rather than replacement authority. Exercise automatic branch termination, persisted summary restore, and session reset as well as unit cases. Replace ghost-ID characterizations with stronger regressions, without weakening unrelated tests, and pass the repository's release gates.

#### How I Would Use This Codebase

I would use TraceLattice to retain branching investigations in a coding assistant, then present compact history when a branch finishes. Different attempts can reuse thought numbers, and older main-history entries can be trimmed. I need the compact view to preserve unrelated reasoning and survive a restart.

#### Why This Is Challenging

Graph reachability, main-history retention, and branch retention do not describe the same set of thoughts. A range can look correct while hiding an unrelated entry, and a summary can list IDs its reducers never saw. The fix must preserve deterministic rollups and persisted contracts while changing replacement semantics.

#### Evaluation Rubric

1. `CompressionService.compressBranch` resolves root-plus-descendant candidates across one retained snapshot, deduplicates IDs with main-history precedence, and derives coverage, topics, confidence, and range from the identical resolved set in graph order. Ghosts are excluded, retained descendants survive a missing root, and only an empty resolved set produces empty IDs/topics, zero confidence, and `[0, 0]`, without changing root/branch idempotency or all-edge-kind traversal.
2. `DehydrationPolicy.apply` replaces cold thoughts only through exact `coveredIds` membership, never numeric-range fallback, leaving idless entries and unrelated duplicate thought numbers intact. Preserve first-match summary order, consecutive-reference collapse, the default last-50 hot suffix, configurable `keepLastK`, descriptive ranges, and nonmutation of input thoughts and arrays.
3. Automatic termination in `ThoughtProcessor`, `HistoryManager.getHistoryHydrated`, summary buffering in `src/lib.ts`, scoped stores, file/SQLite restore, and reset must expose the same identity-correct result without cross-session leakage. Keep feature gates and existing `Summary`/`SummarySchema` persistence shapes, require no migration or startup rewrite, and do not relax `.sentrux/rules.toml` limits of complexity 25, function length 100, and cycle budget 1.
4. Add regressions for retained branch-only entries, conflicting IDs, missing roots with descendants, graph ghosts, overlapping summaries, duplicate numbers, and restart/reset in the existing compression suites; run `npm test -- src/__tests__/compression src/__tests__/integration/CompressionAutoTrigger.test.ts src/__tests__/integration/CompressionPersistence.test.ts src/__tests__/integration/CompressionCoordinatorPersistence.test.ts`. Pass `npm run verify:release`, including `npm run verify:library` for type-check/lint/build/coverage, `npm run verify:native`, and `npm run verify:packed`, preserving coverage thresholds of branches 90%, functions 60%, lines 65%, and statements 65%.

### Proposal 3: Verify the packaged HTTP library API

#### Coding Prompt

Make the documented HTTP library integration usable from the installed package, and make packed verification catch broken JavaScript exports or declarations. Add `HttpTransport`, `createHttpTransport`, `HttpTransportOptions`, `ITransport`, `TransportOptions`, and `TransportKind` to the package-root API through `src/lib.ts`, preserving existing server exports. Do not expose `Container`, `ServerConfig`, registries, wildcard exports, or new deep-import paths to make examples compile.

Extend the existing packed verification pipeline with an external consumer that imports `@iworkforces/tracelattice` from the installed tarball. Check side-effect-free library import, transport construction and message handling, shutdown, and TypeScript consumption of the public transport types. Use the current toolchain without source aliases or new dependencies; merely checking that declaration files exist is insufficient.

Make incorrect runtime exports and invalid declarations fail verification even when packaging succeeds. Clean up consumer processes and temporary directories on success and failure without hiding the original error. Keep the receipt format, CD publication path, and Bun CLI checks unchanged. Update README and factory examples to use the supported root API, then pass focused release tests and all release gates.

#### How I Would Use This Codebase

I would install the package in a TypeScript service that embeds the existing JSON-RPC HTTP adapter alongside other internal tools. I want the documented imports to compile and run without reaching into build directories, and I want publication checks to catch broken consumer contracts before release.

#### Why This Is Challenging

Source tests can pass through local resolution even when a published export or declaration is unusable. This repository also ships a separate Bun executable, so strengthening library verification must not accidentally run CLI startup during import or change the verified tarball that CD publishes. Failure cleanup is part of that boundary.

#### Evaluation Rubric

1. Add exactly the requested transport values and types through `src/lib.ts`, sourcing `TransportOptions` from `src/transport/BaseTransport.ts` and `ITransport`/`TransportKind` from `src/contracts/transport.ts`, while retaining existing server exports. Assert that named DI/configuration internals remain unexported and deep imports remain blocked, without freezing the entire root export-key set or relaxing `.sentrux/rules.toml` limits of complexity 25, function length 100, and cycle budget 1.
2. An isolated installed-tarball consumer must import the package root without CLI startup or stdout noise, construct the HTTP adapter, exchange a request, and await shutdown. A separate TypeScript consumer must compile against installed declarations using the requested public types and existing server API, with no source aliases, direct `src/` or `dist/` imports, type suppressions, or new dependencies.
3. Integrate both consumer checks into `scripts/verify-packed-cli.mjs` before verification succeeds, with negative artifacts proving that missing runtime exports and broken declarations fail despite existing files. Preserve primary-error diagnostics, process/temp-root cleanup, receipt schema version 1, checksum identity, CD's no-rebuild publication, and all existing Bun CLI protocol/shutdown checks.
4. Update README and `src/lib.ts` examples to use supported root imports, and extend `src/__tests__/typing.test-d.ts` plus release artifact/script cases; run `npm test -- src/__tests__/release` and `npm run type-check`. Pass `npm run verify:release`, including `npm run verify:library` for type-check/lint/build/coverage, `npm run verify:native`, and `npm run verify:packed`, preserving coverage thresholds of branches 90%, functions 60%, lines 65%, and statements 65%.
