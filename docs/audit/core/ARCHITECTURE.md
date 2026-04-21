# packages/core — Architecture snapshot (2026-04-21)

## Layer map

```mermaid
flowchart LR
    subgraph DSL["Schema DSL (schema.ts / schema-bridge.ts)"]
        A[schema() call] --> B[SchemaDefinition]
        B --> C[schema-bridge: ResolvedSchema → ModelIR]
    end

    subgraph IR["Intermediate Representations"]
        C --> D[ModelIR\n(tables, relations, enums, hints)]
        E[IntentAST\n(IntentBuilder / QueryBuilderImpl)] --> F[PlanReport\n(decisions, warnings, ctes)]
    end

    subgraph Core["Core DX Layer (core/src/dx/)"]
        G[createOrm / OrmInstance] -->|dispatches| E
        G -->|negotiateFeatures| H[DialectCapabilities check]
        H -.->|warns/throws| G
    end

    subgraph Planner["Semantic Planner (planner.ts)"]
        E --> F
        F --> I[PlanState\n(decisions[], warnings[], ctes[])]
    end

    subgraph Boundary["Adapter Boundary"]
        F -->|PlanReport| J[Adapter.execute / compile]
        K[result-hydrator.ts] -->|post-execution| L[Hydrated rows]
    end

    D --> G
    D --> E
    D -.->|ModelIR| J
```

## God objects flagged

| Class / Factory | LoC | Fields | Methods | Refactor candidate |
|-----------------|-----|--------|---------|-------------------|
| `QueryBuilderImpl` (`query-builder.ts:89`) | 1957 | 30 | 40 | Extract PaginationMixin (~200 LoC), StreamMixin (~104 LoC), HookExecutor (~165 LoC); replace 13 positional ctor params with QueryBuilderContext struct |
| `createOrmInstance` (`orm-instance.ts:402`) | ~494 | — | 25 (returned obj) | Introduce QueryContext value-object (13 params → 1); extract HierarchyApi mixin |
| `negotiateFeatures` (`negotiate-features.ts:59`) | 131 | — | 1 (15 hard-coded checks) | Replace body with FeatureChecker[] registry; each DDL feature = one entry |

## Dependency graph observations

### `createOrmInstance` fan-in (13 positional params, 6 call sites)

`createOrmInstance(model, strictMode, relationHints, adapter, schemaName, dialectCapabilities, globalPlanOptions, defaultFilters, hookStore, onHookError, inTransaction, schemaNamespace, pluginRegistry)` — 13 positional parameters propagated identically to:

1. `QueryBuilderImpl` constructor (all 13)
2. `createOrmInstance` recursive call in `withSchema()` (all 13, schemaName changed)
3. `createOrmInstance` recursive call in `transaction()` (all 13, inTransaction=true)
4. `QueryBuilderImpl` × 5 inside `listAncestors` / `listDescendants` (all 13)

Any parameter reorder silently breaks all 6 call sites at runtime. **SOLID-1** proposes a `QueryContext` struct.

### `QueryBuilderImpl` positional-param bomb (12 params via clone())

`clone()` at line 1898 reconstructs the builder with all 12 constructor args positionally. Every fluent method call triggers a full clone. This makes adding a new builder field a 3-file change: constructor, clone(), and the QueryBuilderContext struct (once introduced).

### `negotiateFeatures` OCP violation (15 hard-coded checks)

The 131-LoC function has 15 sequential `if (model.hasX && !caps.supportsX)` blocks. The last 5 DDL features (RLS, HNSW index, expression index, partial index, indexOpclass) were each added as manual if-blocks. Adding the 16th requires editing this function. **SOLID-2** proposes a FeatureChecker[] registry.

## Planner execution flow (high level)

The planner runs 3 traversals per `plan()` call:

### Traversal 1 — Intent optimization (`optimizeInToExists`, `planner.ts:636`)

Rewrites IN-subquery expressions to EXISTS for potential query plan improvement. Runs a `conditions.map(recurse)` followed by `optimized.every((c,i) => c === conditions[i])` — **two passes over every AND/OR node** (PERF-5).

**Critical bug**: The NOT wrapper converts an optimized IN-subquery to `notExists` without proving the FK column is non-nullable, silently changing three-valued SQL NULL semantics (CODEX-1).

### Traversal 2 — Include strategy selection (`processInclude`, `planner.ts:881`)

Processes each include declaration: resolves relations, detects circular includes, selects strategy (join/cte/subquery/flat), emits `decisions[]`. This is the largest single function in core (219 LoC, CC=42, 75 callees) with recursive self-calls for nested includes (SOLID-10).

Key strategy gaps:
- Recursive includes bypass `selectSmartStrategy` and force `cte` before checking `dialectCapabilities.supportsRecursiveCTE` (CODEX-2).
- `include.limit` is silently dropped when strategy falls back to join (CODEX-3).
- Lenient ambiguity resolution picks `error.options[0]` — schema insertion order determines query semantics (CODEX-10).

### Traversal 3 — CTE deduplication (`extractCTEs`, `planner.ts:1452`)

Scans `state.relationAccessCounts` and emits CTE definitions for repeated relations. Calls `state.decisions.find()` and `state.ctes.some()` in a loop — **O(R × D) complexity** (PERF-3). Fixable with a single Map<string, PlanDecision> pre-built from decisions.

### Post-plan state freeze

`plan()` exits with three `Object.freeze([...spread])` calls on decisions, warnings, and ctes. The spread is unnecessary (local arrays, no external reference) — 3 avoidable allocations per query (PERF-1).

An `state.decisions.find()` call at plan exit scans for ambiguity decisions — redundant with Traversal 2; replaceable with a boolean flag set during processInclude (PERF-2).

## Public API surface

| Metric | Value |
|--------|-------|
| Exports from `index.ts` | ~240 symbols |
| `@internal` classes currently exported publicly | 3 (OrmInstanceInternal, SetOperationBuilderImpl, IntentBuilder) |
| Wildcard re-exports | 1 risk: `intent-ast.ts` does `export * from '@dbsp/types'` re-exposing all types pkg |
| Mutation entry types that lose TableRef types | 4 (into, modify, removeFrom, upsertInto return unparameterized builders) |
| Dead exports confirmed by astix | 2 (NegotiationResult, FromBuilder/TypedOrm/RecursiveQueryBuilder) |

### @internal leak details (API-6, API-7, API-15)

- `OrmInstanceInternal<DB>` — exported from `dx/index.ts`, re-exported via root `index.ts` wildcard. JSDoc says "External consumers should NOT use this type" but it is public.
- `SetOperationBuilderImpl<TResult>` — exported from `dx/index.ts`. Callers can import the concrete class and depend on construction internals.
- `IntentBuilder` — exported from `dx/index.ts` with no `@internal` tag. Should be marked internal and removed from public surface.

### Wildcard re-export risk (API-14)

`intent-ast.ts:12` does `export * from '@dbsp/types'` which re-exports ALL of `@dbsp/types` (adapter, dialect, model-ir, planner types) — not only intent-AST types. Any new type added to `@dbsp/types` silently becomes part of `@dbsp/core`'s public API via this path.

### Mutation entry types (API-2)

All four TableRef-based mutation entry points (`into`, `modify`, `removeFrom`, `upsertInto`) accept `TTable extends TableRef<any, any, any>` but return unparameterized builders (`InsertBuilder`, `UpdateBuilder`, etc.), discarding the table name and column types. The entire point of the TableRef API is type propagation — this is the single highest-impact type-safety gap in core.
