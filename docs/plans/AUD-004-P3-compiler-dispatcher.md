# AUD-004 Phase 3: Compiler Handler/Dispatcher Architecture

**Status:** ✅ Complete (2026-01-20)
**Complexity:** COMPLEX (Enterprise-level refactoring)
**Estimated Effort:** 2-3 days (actual: ~1.5 days)

---

## Overview

Refactor `compiler.ts` from a monolithic switch-based dispatcher to a modular handler registry pattern for improved testability, extensibility, and maintainability.

### Current State
- `compiler.ts`: 3301 lines
- `mutation-compiler.ts`: 349 lines (extracted in Phase 1)
- `recursive-compiler.ts`: 1155 lines (extracted in Phase 2)
- Dispatch via switch statements in `compileWhere()` and `addExpressionSelect()`
- Include strategies hardcoded in `compile()`

### Target State
```
packages/adapter-kysely/src/
├── compiler.ts              # Orchestrator (~500 lines)
├── compiler/
│   ├── types.ts             # CompilerContext, Handler types
│   ├── registry.ts          # Handler registries
│   ├── handlers/
│   │   ├── where/           # WHERE handlers (12 files)
│   │   │   ├── index.ts     # Re-exports + registration
│   │   │   ├── comparison.ts
│   │   │   ├── like.ts
│   │   │   ├── in.ts
│   │   │   ├── null.ts
│   │   │   ├── range.ts
│   │   │   ├── and.ts
│   │   │   ├── or.ts
│   │   │   ├── not.ts
│   │   │   ├── exists.ts
│   │   │   ├── not-exists.ts
│   │   │   ├── relation-filter.ts
│   │   │   └── subquery.ts
│   │   ├── expression/      # Expression handlers (3 files)
│   │   │   ├── index.ts
│   │   │   ├── coalesce.ts
│   │   │   ├── raw.ts
│   │   │   └── window.ts
│   │   └── include/         # Include strategy handlers (4 files)
│   │       ├── index.ts
│   │       ├── join.ts
│   │       ├── lateral.ts
│   │       ├── json-agg.ts
│   │       └── cte.ts
│   └── builders/            # Query builders
│       ├── index.ts
│       ├── base-query.ts
│       ├── aggregate.ts
│       └── cte.ts
├── mutation-compiler.ts     # (already extracted)
└── recursive-compiler.ts    # (already extracted)
```

---

## Type Definitions

### CompilerContext

```typescript
// compiler/types.ts
import type { ModelIR, PlanReport, WhereIntent, ExpressionIntent } from '@dbsp/core';
import type { Kysely, SelectQueryBuilder, ExpressionBuilder } from 'kysely';

export interface CompilerContext {
  /** Kysely database instance */
  db: Kysely<any>;
  /** Model IR for schema information */
  model: ModelIR;
  /** Plan report with decisions */
  plan: PlanReport;
  /** Current compiler state */
  state: CompilerState;
  /** Optional schema name for multi-tenant */
  schemaName?: string;
}

export interface CompilerState {
  aliasCounter: number;
  tableAliases: Map<string, string>;
  parameters: unknown[];
  joinedFilterRelations: Map<string, string>;
  joinedIncludeRelations: Map<string, string>;
  coreCapabilities?: DialectCapabilities;
  dialect?: DialectName;
}
```

### Handler Types

```typescript
// compiler/types.ts

/** WHERE clause handler - takes ExpressionBuilder, returns expression */
export type WhereHandler<T extends WhereIntent = WhereIntent> = (
  ctx: CompilerContext,
  eb: ExpressionBuilder<any, any>,
  intent: T,
  alias: string,
) => any; // Kysely expression

/** SELECT expression handler - takes query, returns modified query */
export type ExpressionHandler<T extends ExpressionIntent = ExpressionIntent> = (
  ctx: CompilerContext,
  query: SelectQueryBuilder<any, any, any>,
  intent: T,
  alias: string,
) => SelectQueryBuilder<any, any, any>;

/** Include strategy handler - applies include to query */
export type IncludeHandler = (
  ctx: CompilerContext,
  query: SelectQueryBuilder<any, any, any>,
  includes: IncludeIntent[],
  rootTable: string,
  rootAlias: string,
) => SelectQueryBuilder<any, any, any>;
```

### Registry

```typescript
// compiler/registry.ts
import type { WhereHandler, ExpressionHandler, IncludeHandler } from './types.js';

// WHERE handlers registry
const whereHandlers = new Map<string, WhereHandler>();

export function registerWhereHandler<K extends string>(
  kind: K,
  handler: WhereHandler
): void {
  whereHandlers.set(kind, handler);
}

export function getWhereHandler(kind: string): WhereHandler | undefined {
  return whereHandlers.get(kind);
}

// Expression handlers registry
const expressionHandlers = new Map<string, ExpressionHandler>();

export function registerExpressionHandler<K extends string>(
  kind: K,
  handler: ExpressionHandler
): void {
  expressionHandlers.set(kind, handler);
}

export function getExpressionHandler(kind: string): ExpressionHandler | undefined {
  return expressionHandlers.get(kind);
}

// Include strategy handlers registry
const includeHandlers = new Map<string, IncludeHandler>();

export function registerIncludeHandler(
  strategy: string,
  handler: IncludeHandler
): void {
  includeHandlers.set(strategy, handler);
}

export function getIncludeHandler(strategy: string): IncludeHandler | undefined {
  return includeHandlers.get(strategy);
}
```

---

## Implementation Blocks

### Block 1: Foundation (types + registry + first handler)
**Goal:** Prove the pattern works with one handler

1. Create `compiler/types.ts` with `CompilerContext`, `CompilerState`
2. Create `compiler/registry.ts` with handler registration
3. Extract `comparison` handler to `compiler/handlers/where/comparison.ts`
4. Update `compileWhere()` to use registry for `comparison`
5. Run tests - must pass

### Block 2: Simple WHERE handlers
**Goal:** Extract all simple WHERE handlers

1. Extract `like.ts`, `in.ts`, `null.ts`, `range.ts`
2. Extract `and.ts`, `or.ts`, `not.ts` (recursive handlers)
3. Update `compileWhere()` to use registry
4. Run tests

### Block 3: Complex WHERE handlers
**Goal:** Extract EXISTS and relation handlers

1. Extract `exists.ts` (317 lines - the big one)
2. Extract `not-exists.ts`
3. Extract `relation-filter.ts`
4. Extract `subquery.ts`
5. `compileWhere()` now fully dispatches via registry
6. Run tests

### Block 4: Expression handlers
**Goal:** Extract all expression handlers

1. Extract `coalesce.ts`
2. Extract `raw.ts`
3. Extract `window.ts`
4. Update `addExpressionSelect()` to use registry
5. Run tests

### Block 5: Include strategy handlers
**Goal:** Extract include strategies

1. Extract `join.ts` (from `applyIncludeJoins`)
2. Extract `lateral.ts` (from `applyLateralIncludes`)
3. Extract `json-agg.ts` (from `applyJsonAggIncludes`)
4. Extract `cte.ts` (from `applyCteIncludes`)
5. Update `compile()` to use include registry
6. Run tests

### Block 6: Query builders + cleanup
**Goal:** Extract builders and clean up main compiler

1. Extract `base-query.ts`
2. Extract `aggregate.ts`
3. Clean up `compiler.ts` - should be ~500 lines orchestrator
4. Add index.ts re-exports for backwards compatibility
5. Run full test suite
6. Update BACKLOG.md

---

## Acceptance Criteria

### Functional
- [ ] All 1672 tests pass without modification
- [ ] `compile()` API unchanged
- [ ] SQL output identical (verified by golden tests)

### Architectural
- [ ] `compiler.ts` reduced to ~500 lines (orchestrator only)
- [ ] Each handler in separate file
- [ ] Handler registration is explicit
- [ ] Context passed through, no global state

### Quality
- [ ] Each handler can be unit tested in isolation
- [ ] Adding new handler = add file + register
- [ ] No circular dependencies between handlers

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Recursive handlers (`and`, `or`, `not`) | Pass `compileWhere` dispatcher to context |
| Shared utilities | Keep in `compiler.ts` or create `compiler/utils.ts` |
| Performance regression | Benchmark before/after (Map lookup is O(1)) |
| Circular imports | Strict dependency direction: handlers → types ← registry |

---

## Test Strategy

1. **No new tests** - existing 1672 tests validate behavior
2. **Golden tests** verify SQL output unchanged
3. **Run tests after each block** - catch regressions early
4. **If test fails** - revert and debug before continuing
