# TYPES

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Hand-written domain types. **Not inferred from `schema.ts`.** Normalizer fills schema-optional fields; these types are post-normalize.

## FILES

```
types/
├── tool.ts           # Tool, ToolRecommendation, JsonSchema
├── skill.ts          # Skill, SkillRecommendation
├── disposable.ts     # IDisposable
└── server-config.ts  # ServerConfig — NAME COLLISION
```

## CRITICAL: `ServerConfig` COLLISION

`types/server-config.ts` `ServerConfig` is `{ available_tools, available_skills }` maps.
**Not** a re-export of `src/ServerConfig.ts` (validated config + 7 flags).
Do not import one when you mean the other.

## REQUIRED AFTER NORMALIZE

Schema-optional, **required** here (normalizer fills defaults):

| Type | Required fields |
|------|-----------------|
| `ToolRecommendation` | `tool_name`, `confidence`, `rationale`, **`priority`** |
| `SkillRecommendation` | `skill_name`, **`confidence`**, **`rationale`**, **`priority`** |

**Do not infer these from `schema.ts`.** Optionality mismatch breaks call sites.

## DISPOSABLE

`IDisposable`: `{ dispose(): Promise<void> }`.
Used by `Container.registerDisposable`. Implement on anything with timers, DB, handles.

## NOTES

- `JsonSchema` is `Record<string, unknown>` for `Tool.inputSchema`.
- `Tool` / `Skill` are registry item shapes. No barrel.
