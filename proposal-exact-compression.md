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
