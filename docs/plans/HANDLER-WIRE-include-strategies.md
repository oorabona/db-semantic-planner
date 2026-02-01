# HANDLER-WIRE: Wire ALL Include Strategy Handlers

## Summary

Wire the existing handler system (`handlers/include/`) into the compilation
flow for ALL include strategies (json_agg, join, lateral, cte, subquery).
Replace the compiler switch cases with handler dispatch.
Fix the `| flat` bug where includes are silently dropped.

## Current State

```
pgsql-adapter.ts
  → plan-decision-extractor.ts (extracts json_agg, join, exists)
    → compiler.ts switch:
        - selectJsonAgg → compileJsonAggDecision (recursive nesting, __t__ aliases)
        - selectLeftJoinInclude → inline LEFT JOIN code
        - (lateral, cte, subquery → NOT HANDLED → silent drop)
```

Handler system (`handlers/include/`) exists with 4 handlers but is NOT wired:
- `json-agg.ts` — flat only (no nesting support)
- `join.ts` — LEFT JOIN
- `lateral.ts` — LEFT JOIN LATERAL
- `cte.ts` — WITH clause

## Target State

```
pgsql-adapter.ts
  → plan-decision-extractor.ts (extracts ALL strategies into typed decisions)
    → compiler.ts:
        - All include decisions dispatched via handler registry
        - compileIncludeDecision(decision) → getIncludeHandler(strategy).compile(...)
        - Type bridge: PlanDecision → Decision, CompilerOptions → CompilerContext
        - Old switch cases for includes REMOVED
```

## Design Decision: Full Wiring

User explicitly requested: "je veux que tu wires tout" — no half-measures.

Key work items:
1. **json_agg handler**: Enhance with recursive nesting support (children, intentPath, depth aliases)
2. **join handler**: Already works for flat includes; verify compatibility
3. **lateral handler**: Already implemented; wire through type bridge
4. **cte handler**: Already implemented; wire through type bridge
5. **subquery**: Create thin handler that delegates to json_agg handler

## Type Bridge

### PlanDecision → Decision mapping:
```typescript
function toHandlerDecision(pd: PlanDecision): Decision {
  return {
    type: pd.type,
    relation: pd.relationName,
    targetTable: pd.targetTable,
    sourceColumn: pd.parentKey,       // PK in source table
    targetColumn: pd.foreignKey,      // FK in target table
    columns: pd.columns,
    strategy: pd.choice,
    include: pd.children?.map(toHandlerDecision),
    // ... other mappings
  };
}
```

### Compiler → CompilerContext mapping:
```typescript
function toCompilerContext(compiler: PlanCompiler): CompilerContext {
  return {
    naming: compiler.naming,
    schema: compiler.schema,
    rootTable: compiler.currentRootTable,
    maxRecursiveDepth: 100,
  };
}
```

### Compiler → CompilerState mapping:
```typescript
function toCompilerState(compiler: PlanCompiler): CompilerState {
  return {
    parameters: compiler.state.parameters,
    paramIndex: compiler.state.paramIndex,
    ctes: new Map(),
    aliases: new Map(),
    joins: [],
  };
}
```

## BDD Scenarios

### Scenario 1: json_agg with nesting via handler
```
Given a query: users | select *, userRoles.role.permissions.*
When the handler receives a json_agg decision with children
Then it produces nested json_agg with jsonb_build_object
And depth-based aliases (__t__, __t1__, __t2__) are used
And the output matches the previous compileJsonAggDecision output
```

### Scenario 2: Lateral include (| flat) produces correct SQL
```
Given a query: users | select *, userRoles.* | flat
When the planner emits choice: 'lateral'
Then the lateral handler produces LEFT JOIN LATERAL SQL
And the related columns appear in the result
```

### Scenario 3: JOIN include via handler
```
Given a query: posts | select *, author.*
When the planner emits choice: 'join'
Then the join handler produces LEFT JOIN SQL
And relation columns are aliased correctly
```

### Scenario 4: Subquery fallback
```
Given a planner decision with choice: 'subquery'
When dispatched to the handler system
Then it delegates to the json_agg handler
And produces correct correlated subquery SQL
```

### Scenario 5: CTE include
```
Given a recursive relation with choice: 'cte'
When dispatched to the handler system
Then the cte handler produces WITH RECURSIVE SQL
And the CTE is registered in compiler state
```

### Scenario 6: Existing tests pass (regression)
```
Given all existing unit and E2E tests
When the handler wiring is complete
Then all 2191 tests pass
And iam query 27 (nested json_agg) still produces correct SQL
```

## Implementation Blocks

### Block 1: Enhance json_agg handler with nesting support
**Files:**
- `packages/adapter-pgsql/src/handlers/include/json-agg.ts`
  - Add `children` support to Decision type usage
  - Add recursive compilation (depth aliases: __t__, __t1__, etc.)
  - Add `to_jsonb(__t__)` pattern (instead of json_build_object for wildcard)
  - Add `jsonb_build_object` merging for nested children

**Tests:**
- Handler unit tests for single-level, 2-level, 3-level nesting
- Output must match existing compileJsonAggDecision for same inputs

**Exit criteria:** json_agg handler produces identical SQL to compileJsonAggDecision

### Block 2: Type bridge + dispatch in compiler
**Files:**
- `packages/adapter-pgsql/src/compiler.ts`
  - Add `compileIncludeViaHandler(decision)` method
  - Add type bridge functions (PlanDecision → Decision, etc.)
  - Replace selectJsonAgg/selectLeftJoinInclude cases with handler dispatch
  - Add selectLateralInclude and selectCteInclude routing
  - Remove old inline code

**Tests:**
- All existing compiler tests still pass
- New tests for lateral and cte dispatch

**Exit criteria:** Compiler dispatches ALL includes via handlers, no inline include code

### Block 3: Extractors for lateral/subquery + adapter wiring
**Files:**
- `packages/adapter-pgsql/src/plan-decision-extractor.ts`
  - Add `extractLateralIncludeDecisions` (with tree building)
  - Add `extractSubqueryIncludeDecisions` (maps to json_agg)
- `packages/adapter-pgsql/src/pgsql-adapter.ts`
  - Wire new extractors into allDecisions array
  - Ensure handler registry is initialized

**Tests:**
- Extractor unit tests for lateral/subquery decisions
- E2E: iam.assert.dbsp query 28 with correct SQL

**Exit criteria:** `| flat` works end-to-end, all strategies routed

### Block 4: Cleanup + regression validation
**Files:**
- Remove dead code from compiler.ts (old inline include handling)
- Update handler registry if needed
- Run full test suite

**Tests:**
- Full pnpm test (2191 tests)
- iam query 27 (nested json_agg) unchanged
- iam query 28 (| flat) produces LATERAL SQL

**Exit criteria:** Clean codebase, 0 test failures
