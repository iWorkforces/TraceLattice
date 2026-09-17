# TEST SUITE

**Parent:** ../AGENTS.md

## OVERVIEW

Vitest 4.1.x suite colocated under `src/__tests__/` (non-standard, kept inside `src/` for path alias parity). Coverage gates: branches 90%, functions 60%, lines 65%, statements 65%.

## STRUCTURE

Test files mirror the `src/` tree. `src/__tests__/core/graph/EdgeStore.test.ts` covers `src/core/graph/EdgeStore.ts`, etc. Ownership tests in `core/HistoryManager.ownership.test.ts` cover all owner-enforced methods including `clear()`.

```
helpers/         factories.ts, timers.ts
core/graph/      EdgeStore, GraphView, Edge
core/reasoning/strategies/   TreeOfThought.newTypes
strategies/      TreeOfThoughtStrategy (538L), totScoring, StrategyContract
integration/     Cross-module flows
compression/     CompressionAutoTrigger
calibrator/      Calibrator regression suite: Beta(2,2), Brier, ECE, temperature scaling, ALL_THOUGHT_TYPES coverage
eval/fixtures/   scenarios.ts (10 canonical eval scenarios)
```

`eval/totVsSequential.eval.ts` is not CI-gated; run it explicitly with `RUN_EVAL=1 npm test`.

## CONVENTIONS

- **Mirror layout**: new test file path = source path with `__tests__/` inserted after `src/`.
- **No barrels** in test dirs. Import other test files directly.
- **Feature flags via constructor**, never env vars in tests:
  ```ts
  const proc = new ThoughtProcessor({ historyManager: mock, dagEdges: true, calibration: true });
  ```
- **Spread overrides** for fixtures: `createTestThought({ thought_type: 'hypothesis', confidence: 0.8 })`. Only specify what the test asserts on.
- **One concern per `it`**. Group by behavior, not by method name.
- **Skipped tests** (`it.skip`) need a comment explaining the gap.
- **Async cleanup**: `await` shutdowns in `afterEach` to avoid leaking timers across files.

## SKIPS / KNOWN GAPS

- `integration/dag-edges.test.ts`: conditional SQLite/persistence restart cases skip when SQLite is unavailable.
- `integration/CompressionPersistence.test.ts`: compression persistence variants use `skipIf` for unavailable backend combinations.
- Keep skip comments local to the skipped `it`/`describe`; do not add silent `skipIf` gates.

## HELPERS

`helpers/factories.ts`:
- `createTestThought(overrides?: ThoughtOverrides)`: 11 typed variants covering every `ThoughtType`. `ThoughtOverrides` accepts plain `string` for `id`/`session_id`/`continuation_token` and brands them internally. Returns a fully-valid `ThoughtData`.
- Branded ID constructors (accept plain `string`, return branded type): `createTestSessionId()`, `createTestThoughtId()`, `createTestEdgeId()`, `createTestSuspensionToken()`. Use these whenever a test needs a typed ID without going through `generateUlid`.
- `MockHistoryManager`: in-memory `Map`-backed `IHistoryManager`. `getBranches()` returns `Record<BranchId, ThoughtData[]>` (keyed by branded `BranchId`, not raw string). Use it instead of stubbing the real one when persistence isn't under test.
- `createMockFormatter()`: capture-only formatter for assertions on display output.

`helpers/timers.ts` wraps Vitest timer APIs:
- `useFakeTimers()` / `useRealTimers()`: pair them in `beforeEach` / `afterEach`.
- `advanceTime(ms)`: thin wrapper over `vi.advanceTimersByTime` (synchronous), keeping suspension TTL and persistence buffer flush tests deterministic.
