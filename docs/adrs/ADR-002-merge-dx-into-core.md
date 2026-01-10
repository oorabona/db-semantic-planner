# ADR-002: Merge dx Package into core for Adapter-Agnostic Architecture

---
doc-meta:
  status: accepted
  scope: core, dx, adapter-kysely
  type: adr
  created: 2026-01-10
  decision-date: 2026-01-10
---

## Status

**ACCEPTED** (2026-01-10)

## Context

### Problem Statement

The current architecture has three packages with problematic coupling:

```
┌─────────────────────────────────────────────────────────────────┐
│  packages/core (adapter-agnostic)                               │
│  - ModelIR, IntentAST, Planner                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↑
┌─────────────────────────────────────────────────────────────────┐
│  packages/dx (COUPLED TO KYSELY)                                │
│  - QueryBuilder, Filters, ORM facade                            │
│  - Imports directly from adapter-kysely                         │
│  - Imports Kysely types                                         │
└─────────────────────────────────────────────────────────────────┘
                              ↑
┌─────────────────────────────────────────────────────────────────┐
│  packages/adapter-kysely                                        │
│  - Compiler, Execution, Stream                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Evidence of coupling in `packages/dx/src/orm.ts`:**

```typescript
import { compile, ... } from '@db-semantic-planner/adapter-kysely';
import { Kysely } from 'kysely';

// Transaction uses Kysely API directly
async transaction<T>(fn) {
  return db.transaction().execute(async (trx) => { ... });
}
```

### Consequences of Current Architecture

1. **No multi-adapter support**: To support Drizzle, we'd need `dx-drizzle` with 90% duplicated code
2. **Tight coupling**: `dx` cannot function without `adapter-kysely`
3. **Unclear boundaries**: Both `core` and `dx` are "abstractions" but `dx` isn't truly abstract
4. **User confusion**: Which package to import from?

### Options Considered

#### Option A: Merge dx + core (Selected)

```
┌─────────────────────────────────────────────────────────────────┐
│  packages/core (adapter-agnostic, ALL abstractions)             │
│  - ModelIR, IntentAST, Planner (existing)                       │
│  - QueryBuilder, Filters, ORM facade (from dx)                  │
│  - AdapterInterface (NEW)                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↑
┌─────────────────────────────────────────────────────────────────┐
│  packages/adapter-kysely                                        │
│  implements AdapterInterface                                    │
│  - Compiler, Execution, Transaction, Stream                     │
└─────────────────────────────────────────────────────────────────┘
                              ↑
┌─────────────────────────────────────────────────────────────────┐
│  packages/adapter-drizzle (future)                              │
│  implements AdapterInterface                                    │
└─────────────────────────────────────────────────────────────────┘
```

**Pros:**
- Single adapter-agnostic package
- Clear separation: core = abstractions, adapter-* = implementations
- No code duplication for multi-adapter support
- Simpler user mental model

**Cons:**
- Larger core package
- Migration effort required

#### Option B: Keep dx separate, abstract execution

Keep three packages but make dx adapter-agnostic by injecting adapter.

**Rejected because:**
- Two adapter-agnostic packages (`core` + `dx`) is redundant
- Would still need AdapterInterface somewhere
- More complex dependency graph

#### Option C: One dx per adapter

Create `dx-kysely`, `dx-drizzle`, etc.

**Rejected because:**
- Massive code duplication (QueryBuilder, Filters, etc.)
- Maintenance nightmare
- API inconsistencies between adapters

## Decision

**Merge `packages/dx` into `packages/core` and introduce `AdapterInterface`.**

### New Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  @db-semantic-planner/core                                      │
├─────────────────────────────────────────────────────────────────┤
│  Schema Layer:                                                  │
│    - ModelIR, ModelIRImpl                                       │
│    - defineSchema, defineModel (lightweight)                    │
│    - hasMany, belongsTo, belongsToMany, hasOne                  │
├─────────────────────────────────────────────────────────────────┤
│  Intent Layer:                                                  │
│    - IntentAST (all intent types)                               │
│    - Type guards (isWhereComparison, etc.)                      │
├─────────────────────────────────────────────────────────────────┤
│  Planning Layer:                                                │
│    - plan(), planRecursive()                                    │
│    - PlanReport, PlanDecision, PlanWarning                      │
├─────────────────────────────────────────────────────────────────┤
│  DX Layer (from dx package):                                    │
│    - Filters: eq, gt, and, or, exists, etc.                     │
│    - QueryBuilder interface + implementation                    │
│    - OrmInstance interface                                      │
│    - MutationBuilders (Insert, Update, Delete)                  │
│    - SubqueryBuilder, WindowBuilder                             │
│    - Errors                                                     │
├─────────────────────────────────────────────────────────────────┤
│  Adapter Contract (NEW):                                        │
│    - AdapterInterface                                           │
│    - AdapterCapabilities                                        │
└─────────────────────────────────────────────────────────────────┘
                              ↑
┌─────────────────────────────────────────────────────────────────┐
│  @db-semantic-planner/adapter-kysely                            │
│  implements AdapterInterface                                    │
├─────────────────────────────────────────────────────────────────┤
│  - createKyselyAdapter(db: Kysely<DB>): Adapter                 │
│  - compile(), compileRecursive()                                │
│  - execute(), stream()                                          │
│  - transaction()                                                │
│  - introspect()                                                 │
│  - Dialect detection & capabilities                             │
└─────────────────────────────────────────────────────────────────┘
```

### AdapterInterface Definition

```typescript
// packages/core/src/adapter.ts

export interface AdapterCapabilities {
  supportsReturning: boolean;
  supportsSchemas: boolean;
  supportsStreaming: boolean;
  supportsRecursiveCTE: boolean;
  supportsWindowFunctions: boolean;
  // ... extensible
}

export interface CompiledQuery<T = unknown> {
  sql: string;
  parameters: readonly unknown[];
  _phantom?: T;  // For type inference
}

export interface Adapter<DB = unknown> {
  /** Adapter capabilities */
  readonly capabilities: AdapterCapabilities;
  
  /** Compile a plan to SQL */
  compile(plan: PlanReport, options?: CompileOptions): CompiledQuery;
  
  /** Execute a compiled query */
  execute<T>(query: CompiledQuery<T>): Promise<T[]>;
  
  /** Execute and return single result */
  executeOne<T>(query: CompiledQuery<T>): Promise<T | null>;
  
  /** Stream results */
  stream<T>(query: CompiledQuery<T>, options?: StreamOptions): AsyncIterable<T>;
  
  /** Run transaction */
  transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T>;
  
  /** Create schema-scoped adapter (multi-tenant) */
  withSchema(schemaName: string): Adapter<DB>;
  
  /** Create dump for observability */
  dump(plan: PlanReport, query: CompiledQuery): Dump;
}
```

### New ORM Factory Signature

```typescript
// Before (dx package, Kysely-coupled)
const orm = createOrm({ model, db: kyselyInstance });

// After (core package, adapter-agnostic)
import { createOrm } from '@db-semantic-planner/core';
import { createKyselyAdapter } from '@db-semantic-planner/adapter-kysely';

const adapter = createKyselyAdapter(kyselyInstance);
const orm = createOrm({ model, adapter });

// Or with Drizzle (future)
import { createDrizzleAdapter } from '@db-semantic-planner/adapter-drizzle';
const adapter = createDrizzleAdapter(drizzleInstance);
const orm = createOrm({ model, adapter });
```

## Consequences

### Positive

1. **True multi-adapter support**: Add Drizzle/Prisma adapters without code duplication
2. **Clear architecture**: core = abstractions, adapter-* = implementations
3. **Single import source**: Users import everything from `@db-semantic-planner/core`
4. **Testability**: Core can be unit tested without any adapter
5. **Type safety preserved**: Generic Adapter<DB> carries database schema

### Negative

1. **Breaking change**: Import paths change from `@db-semantic-planner/dx` to `@db-semantic-planner/core`
2. **Migration effort**: Move ~15 files, update all imports
3. **Larger core package**: Tree-shaking mitigates this

### Migration Path

1. **Phase 1**: Create AdapterInterface in core
2. **Phase 2**: Move dx files to core (preserving exports)
3. **Phase 3**: Refactor adapter-kysely to implement AdapterInterface
4. **Phase 4**: Update createOrm to use adapter injection
5. **Phase 5**: Delete dx package entirely
6. **Phase 6**: Update all imports and verify tests

### Backward Compatibility

**None** - This is a breaking change. Users must update imports from `@db-semantic-planner/dx` to `@db-semantic-planner/core`.

Since the project is pre-1.0, breaking changes are acceptable.

## Implementation Notes

### Files to Move (dx → core)

| Source (dx) | Target (core) |
|-------------|---------------|
| `filters.ts` | `src/dx/filters.ts` |
| `types.ts` | `src/dx/types.ts` |
| `orm.ts` | `src/dx/orm.ts` |
| `errors.ts` | `src/dx/errors.ts` |
| `mutation-builders.ts` | `src/dx/mutation-builders.ts` |
| `subquery-builder.ts` | `src/dx/subquery-builder.ts` |
| `recursive-query-builder.ts` | `src/dx/recursive-query-builder.ts` |
| `object-filter.ts` | `src/dx/object-filter.ts` |
| `lightweight-model.ts` | `src/dx/lightweight-model.ts` |
| All test files | `src/dx/*.test.ts` |

### New Files in core

| File | Purpose |
|------|---------|
| `src/adapter.ts` | AdapterInterface + AdapterCapabilities |
| `src/dx/index.ts` | Re-export all dx modules |

### Files to Modify in adapter-kysely

| File | Changes |
|------|---------|
| `index.ts` | Export createKyselyAdapter |
| `adapter.ts` (new) | Implement AdapterInterface |
| `compiler.ts` | Remove ORM-specific code |

## References

- ADR-001: Typed Intents for Advanced Features (establishes multi-adapter vision)
- CLAUDE.md: Architecture documentation
- TODO_DX.md: DX-025 transaction implementation revealed coupling issue
