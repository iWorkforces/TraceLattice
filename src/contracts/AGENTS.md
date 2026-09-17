# CONTRACTS MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Cross-module type hub. No barrel. Import the specific file.

## FILES

| File | Exports |
|------|---------|
| `interfaces.ts` | `IMetrics`, `IDiscoveryCache`, `IEdgeStore` (+ `pruneSession`/`clearAll`), `IOutcomeRecorder`, `IToolRegistry`, `ISessionLock` (`withLock`/`isActive`/`size`) |
| `strategy.ts` | `IReasoningStrategy.decide` (not `decideNext`), `shouldBranch`, `shouldTerminate` |
| `summary.ts` | `ISummaryStore` (`add`/`get`/`forSession`/`forBranch`/`clearSession`); re-exports `Summary` from core |
| `calibrator.ts` | `ICalibrator`, metrics/result types |
| `suspension.ts` | `ISuspensionStore` (`suspend`/`resume`→null/`compareAndAdmit`/`peek`/`expireOlderThan`) |
| `ids.ts` | branded IDs. Only `asSessionId()` validates. `asBranchId()` does **not**. |
| `reasoning-types.ts` | `ThoughtType` (11), `PatternName` (6) |
| `features.ts` | `FeatureFlags`, `DEFAULT_FLAGS`. **No `hasFeature()`**. |
| `transport.ts` | `ITransport` |
| `PersistenceBackend.ts` | 13-method + scoped extras |
| `persistence-work.ts` | buffer job/token types |

## RULES

- Cross-module types go through here.
- Stay in `core/`: `IHistoryManager`, `ThoughtData`, `ConfidenceSignals`/`ReasoningStats`, `Edge`/`EdgeKind`, `Summary` value type.
- Define interface here, implement in the owning module. Do not import implementations across modules.
