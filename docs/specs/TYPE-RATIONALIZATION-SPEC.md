---
doc-meta:
  status: canonical
  scope: types, core, adapter, nql
  type: spec
  created: 2026-01-24
  updated: 2026-01-24
---

# ARCH-004: Type Rationalization Specification

**Status:** ✅ implemented
**Created:** 2026-01-24
**Priority:** HIGH
**Effort:** L (~2h actual)
**Decision:** Option A with subpaths, NQL imports @dbsp/types

## Problem Statement

The codebase has accumulated type and logic duplications that cause:
1. **Bugs from drift** - CompilerState shadowing caused SPEC-001 bug
2. **Maintenance burden** - Same code in 2+ places
3. **Inconsistent APIs** - CompileOptions has different shapes

## Analysis Results

### 1. CRITICAL Type Duplications (Must Fix)

| Type | Locations | Issue |
|------|-----------|-------|
| **CompilerState** | compiler.ts:72, compiler/types.ts:24 | Shadowing caused JOIN bug |
| **CompileOptions** | core/adapter.ts:79, adapter-kysely/types.ts:66, core/dx/query-executor.ts:66 | Different properties |
| **DialectCapabilities** | core/dialects/index.ts:101, adapter-kysely/dialect.ts:23 | Incompatible property names |

### 2. HIGH Type Duplications (Should Fix)

| Type | Locations | Issue |
|------|-----------|-------|
| **Dump, DumpMeta** | core/adapter.ts:141,151 + adapter-kysely/types.ts:15,33 | Identical - just re-export |
| **SeparateIncludeInfo** | core/adapter.ts:99, adapter-kysely/compiler.ts:143 | Readonly vs mutable |
| **RangeValue** | core/intent-ast.ts:419, core/dx/filters.ts:220, adapter-kysely/compiler.ts:321 | 3 identical definitions |
| **SortDirection** | core/dx/types.ts:208, nql/compiler/index.ts:299 | Identical |

### 3. CRITICAL Logic Duplications (Must Fix)

| Function | Locations | Issue |
|----------|-----------|-------|
| **Schema loading** | cli/schema-loader.ts, mcp-server/schema-loader.ts | ~95% identical, 150-220 LOC |
| **Pseudo-column extraction** | core/schema-builder.ts:485-523, core/dx/schema-bridge.ts:355-387 | ~90% identical |
| **Table building** | core/schema-builder.ts:320-550, core/dx/schema-bridge.ts:281-410 | ~80% similar |

### 4. MEDIUM Logic Duplications

| Function | Locations | Issue |
|----------|-----------|-------|
| **getTableFromAlias()** | compiler.ts:2924, compiler/helpers.ts:47 | Same package, use export |
| **camelToSnake()** | compiler/helpers.ts:27, cli/assertion-runner.ts:411 | Identical |
| **exists/not-exists handlers** | where/exists.ts, where/not-exists.ts | 98% identical |
| **Type conversion** | schema-bridge.ts:232-262, schema-bridge.ts:867-904 | Similar pattern |

## Architecture Analysis

### Current Package Dependencies
```
@dbsp/core (no dependencies) ← SOURCE OF TRUTH
   ↑
   ├── @dbsp/adapter-kysely (imports 50+ types from core)
   ├── @dbsp/cli (imports 4 types from core)
   ├── @dbsp/mcp-server (imports 1 type from core)
   └── @dbsp/nql (independent - no @dbsp imports)
```

### Type Categories

| Category | Count | Examples | Export Strategy |
|----------|-------|----------|-----------------|
| **Public API** | ~30 | createOrm, plan, eq, Dump | Stable, documented |
| **Intent Types** | 50+ | WhereIntent, SelectIntent | Internal, for adapters |
| **Implementation** | ~20 | CompilerState, SeparateIncludeInfo | Internal, not exported |
| **Schema Types** | ~25 | ResolvedSchema, TableIR | Stable, documented |

## Proposed Solutions

### Option A: `@dbsp/types` Package (Recommended)

Create a dedicated types package:

```
packages/types/
├── src/
│   ├── index.ts           # Public re-exports
│   ├── public/            # Stable API types
│   │   ├── schema.ts      # ResolvedSchema, TableIR, etc.
│   │   ├── query.ts       # QueryIntent, SelectIntent, etc.
│   │   ├── adapter.ts     # Dump, CompiledQuery, etc.
│   │   └── dx.ts          # OrmInstance, filter helpers
│   ├── internal/          # Internal types (not re-exported from index)
│   │   ├── compiler.ts    # CompilerState, CompilerContext
│   │   ├── planner.ts     # PlanReport internals
│   │   └── intent.ts      # All WhereIntent variants
│   └── shared/            # Shared across packages
│       ├── utils.ts       # SortDirection, RangeValue
│       └── options.ts     # CompileOptions base
```

**Pros:**
- Clear separation public vs internal
- Single source of truth
- Types can evolve independently from implementations
- Better tree-shaking

**Cons:**
- More packages to maintain
- Migration effort

### Option B: Consolidated in Core (Alternative)

Keep types in core but reorganize:

```
packages/core/src/
├── types/
│   ├── public.ts          # @public exports
│   ├── internal.ts        # @internal exports
│   └── shared.ts          # @shared exports
├── index.ts               # Only re-export public.ts
└── internal.ts            # Export internal.ts (for adapter-kysely only)
```

**Pros:**
- Less migration
- Fewer packages

**Cons:**
- Harder to enforce public/internal boundary
- Core grows larger

### Option C: JSDoc Tags Only (Minimal)

Keep current structure, add JSDoc tags:

```typescript
/** @public */
export interface Dump { ... }

/** @internal - for adapter-kysely only */
export interface CompilerState { ... }
```

**Pros:**
- No structural changes
- Quick to implement

**Cons:**
- No enforcement
- Documentation only

## Recommendation: Option A with Phased Approach

### Phase 1: Fix Critical Bugs (1h)
1. Remove duplicate CompilerState from compiler.ts
2. Align CompileOptions between packages
3. Fix DialectCapabilities naming

### Phase 2: Create @dbsp/types (2h)
1. Create new package with proper structure
2. Move shared types (Dump, RangeValue, SortDirection)
3. Update imports across packages

### Phase 3: Consolidate Logic (2h)
1. Extract shared schema-loader.ts
2. Extract pseudo-column extraction function
3. Merge exists/not-exists handlers

### Phase 4: Documentation (1h)
1. Add JSDoc @public/@internal tags
2. Update DOCUMENTATION_INDEX.md
3. Add architecture diagram

## Acceptance Criteria

- [ ] No type defined in more than one file
- [ ] Public vs internal types clearly separated
- [ ] All packages import from designated source
- [ ] Tests pass
- [ ] Documentation updated

## Risks

| Risk | Mitigation |
|------|------------|
| Breaking API changes | Keep re-exports for backward compat |
| Import path changes | Use barrel exports |
| Build order | @dbsp/types has no deps, builds first |

## Resolved Questions

1. ✅ **NQL imports @dbsp/types** - NQL will depend on @dbsp/types for shared types
2. ✅ **Kysely-specific types stay in adapter** - Types like KyselyAdapter internals remain in adapter-kysely
3. ✅ **Subpaths for access control** - `@dbsp/types` (public) and `@dbsp/types/internal` (implementation)

## Implementation Plan (Blocks)

### Block 1: Create @dbsp/types Package Structure (30 min)
**Files to create:**
- `packages/types/package.json` - with exports for public and internal subpaths
- `packages/types/tsconfig.json`
- `packages/types/src/index.ts` - public exports only
- `packages/types/src/internal.ts` - internal exports

**Given/When/Then:**
- Given the types package doesn't exist
- When I create the package structure with proper exports
- Then `@dbsp/types` resolves to public types and `@dbsp/types/internal` resolves to internal types

### Block 2: Move Public Types from Core (45 min)
**Types to move:**
- `Dump`, `DumpMeta` → `types/src/public/adapter.ts`
- `ResolvedSchema`, `TableIR`, `RelationIR` → `types/src/public/schema.ts`
- `SortDirection`, `RangeValue` → `types/src/shared/utils.ts`

**Given/When/Then:**
- Given types are duplicated in core/adapter
- When I move them to @dbsp/types and update imports
- Then each type exists in exactly one location

### Block 3: Move Internal Types (45 min)
**Types to move:**
- `CompilerState`, `CompilerContext` → `types/src/internal/compiler.ts`
- `SeparateIncludeInfo` → `types/src/internal/compiler.ts`
- `CompileOptions` (unified) → `types/src/shared/options.ts`

**Given/When/Then:**
- Given CompilerState is duplicated and caused bugs
- When I consolidate to single definition in @dbsp/types/internal
- Then adapter-kysely imports from @dbsp/types/internal with no duplication

### Block 4: Update Core Imports (30 min)
**Packages to update:**
- `packages/core/src/*.ts` - import from @dbsp/types

**Given/When/Then:**
- Given core defines some types locally
- When I update to import from @dbsp/types
- Then core has no type definitions, only imports

### Block 5: Update Adapter-Kysely Imports (45 min)
**Packages to update:**
- `packages/adapter-kysely/src/**/*.ts` - import from @dbsp/types and @dbsp/types/internal
- Remove local type definitions

**Given/When/Then:**
- Given adapter-kysely has duplicated types
- When I update imports and remove duplicates
- Then adapter-kysely imports all shared types from @dbsp/types

### Block 6: Update NQL Imports (30 min)
**Packages to update:**
- `packages/nql/src/**/*.ts` - import SortDirection from @dbsp/types
- Add @dbsp/types as dependency

**Given/When/Then:**
- Given NQL defines SortDirection locally
- When I add @dbsp/types dependency and update imports
- Then NQL uses shared type definition

### Block 7: Consolidate Logic Duplications (1h)
**Functions to extract:**
- `extractPseudoColumns()` → core/src/schema/pseudo-columns.ts (shared by schema-builder and schema-bridge)
- Merge exists/not-exists handlers → single parameterized handler

**Given/When/Then:**
- Given pseudo-column extraction is duplicated
- When I extract to shared function
- Then both schema-builder and schema-bridge use the same implementation

### Block 8: Cleanup and Tests (30 min)
- Remove all backup re-exports after migration confirmed
- Run full test suite
- Update documentation

**Given/When/Then:**
- Given migration is complete
- When all tests pass
- Then no type is defined in more than one file

---

## Phase 2: Deep Audit Findings (2026-01-24)

### Architecture Problem: Duplicate Paths to ModelIR

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CURRENT ARCHITECTURE (PROBLEMATIC)              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  PATH 1 (CLI DDL only):                                             │
│  defineSchemaBuilder() → buildTables() (~210 LOC) → ModelIR        │
│                                                                     │
│  PATH 2 (Runtime ORM):                                              │
│  defineSchema() → ResolvedSchema                                    │
│       ↓                                                             │
│  assertResolvedToGeneratedSchema()                                  │
│       ↓                                                             │
│  GeneratedSchema                                                    │
│       ↓                                                             │
│  buildModelFromSchema() → buildTableIRFromDef (~220 LOC) → ModelIR │
│                                                                     │
│  DUPLICATION: ~430 LOC of TableIR construction logic                │
└─────────────────────────────────────────────────────────────────────┘
```

### Finding 1: MAJOR - defineSchemaBuilder is redundant (628 LOC)

**Problem:** `defineSchemaBuilder()` in schema-builder.ts duplicates logic from `buildModelFromSchema()` in schema-bridge.ts.

**Evidence:**
- `defineSchemaBuilder` used only in ONE place: `cli/commands/generate.ts:148`
- Both functions build `TableIR` with ~200+ lines of nearly identical logic

**Solution:** Replace usage in generate.ts with:
```typescript
const generatedSchema = assertResolvedSchemaToGeneratedSchema(schema);
const model = buildModelFromSchema(generatedSchema);
```
Then deprecate/remove `defineSchemaBuilder()`.

**Impact:** -628 LOC, single path to ModelIR

### Finding 2: MAJOR - Pseudo-column extraction duplicated (~140 LOC)

**Problem:** Pseudo-column extraction logic exists in two places:
- `schema-builder.ts:485-523` (~40 LOC)
- `schema-bridge.ts:355-387` (~35 LOC)

**Solution:** Extract to `core/src/schema/pseudo-columns.ts` and import from both.

### Finding 3: MEDIUM - CompileOptions not unified (3 definitions)

**Locations:**
- `core/src/adapter.ts:79` - Base interface
- `adapter-kysely/src/types.ts:66` - Extends with Kysely-specific
- `core/src/dx/query-executor.ts:66` - Different subset

**Solution:** Define base in @dbsp/types, extend in adapter-kysely.

### Finding 4: MEDIUM - DialectCapabilities not unified (2 definitions)

**Locations:**
- `core/src/dialects/index.ts:101` - Core definition
- `adapter-kysely/src/dialect.ts:23` - Different property names

**Solution:** Single source in core, adapter imports.

### Finding 5: LOW - Three schema formats (ResolvedSchema → GeneratedSchema → ModelIR)

**Assessment:** After removing defineSchemaBuilder, the flow becomes:
```
defineSchema() → ResolvedSchema → GeneratedSchema → ModelIR
```

**Justification for keeping all three:**
- `ResolvedSchema`: User-facing DSL output (simple Records)
- `GeneratedSchema`: Codegen output format (typed for validation)
- `ModelIR`: Runtime format (Maps + helper methods for performance)

**Verdict:** Keep all three, but ensure single conversion path.

## Phase 2 Implementation Plan

### Block P2-1: Remove defineSchemaBuilder (~1h)

1. Update `cli/commands/generate.ts` to use `buildModelFromSchema`
2. Add `assertResolvedSchemaToGeneratedSchema` import
3. Test DDL generation still works
4. Mark `defineSchemaBuilder` as `@deprecated`
5. Remove after confirming no other usage

### Block P2-2: Extract pseudo-column logic (~30min)

1. Create `core/src/schema/pseudo-columns.ts`
2. Move extraction logic from schema-bridge.ts
3. Update schema-bridge.ts to import
4. Update schema-builder.ts to import (if still exists)
5. Test all pseudo-column scenarios

### Block P2-3: Unify CompileOptions (~30min)

1. Define `CompileOptionsBase` in @dbsp/types
2. Extend in adapter-kysely for Kysely-specific options
3. Update all imports
4. Remove duplicate definitions

### Block P2-4: Unify DialectCapabilities (~20min)

1. Consolidate to single definition in core/dialects
2. Update adapter-kysely to import
3. Align property names

### Block P2-5: Final cleanup and tests (~30min)

1. Run full test suite
2. Verify no regressions
3. Update documentation
4. Final line count comparison

## Expected Outcome

| Metric | Before | After Phase 1 | After Phase 2 |
|--------|--------|---------------|---------------|
| Total schema LOC | 2242 | 2242 | ~1600 |
| Duplicate TableIR builders | 2 | 2 | 1 |
| Duplicate pseudo-column extraction | 2 | 2 | 1 |
| CompileOptions definitions | 3 | 3 | 1 base + 1 ext |
| DialectCapabilities definitions | 2 | 2 | 1 |
| Net LOC change | - | +13 | ~-650 |

