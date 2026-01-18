# TODO: Developer Experience (DX)

> Feedback from real-world usage and code review
> Source: E2E implementation (REPL, CLI, query-executor) + architecture audit

## Status: 🟡 BACKLOG

---

## DX-100: Schema Type Unification ✅ COMPLETED (2026-01-11)

**Problem:** Two schema types that look similar but required manual conversion.

```typescript
// BEFORE: Forced conversion
import { assertResolvedSchemaToGeneratedSchema } from '@dbsp/core';
const generatedSchema = assertResolvedSchemaToGeneratedSchema(schema);
const orm = createOrm<any>({ schema: generatedSchema, adapter });

// AFTER: Just works with either type
const orm = createOrm({ schema, adapter }); // Works with ResolvedSchema OR GeneratedSchema
```

**Investigation Results:**

| Question | Answer |
|----------|--------|
| Why both types? | Different stages: ResolvedSchema (user DSL, PostgreSQL-specific types like `time`, `jsonb`) vs GeneratedSchema (runtime, dialect-agnostic types like `datetime`, `number`) |
| Necessary separation? | YES - column type differences serve different purposes |
| Can simplify to single type? | NO - would lose PostgreSQL-specific or dialect-agnostic capabilities |
| Hide conversion? | YES - implemented via `normalizeSchema()` |

**Type Differences:**
- `ResolvedSchema` column types: `uuid | string | text | integer | bigint | decimal | boolean | timestamp | date | time | json | jsonb`
- `GeneratedSchema` column types: `string | text | number | integer | bigint | decimal | boolean | date | timestamp | datetime | json | uuid`
- Key differences: ResolvedSchema has `time`, `jsonb` (PostgreSQL); GeneratedSchema has `number`, `datetime` (generic)

**Solution Implemented (Option B):**
1. Added `isResolvedSchema()` type guard - detects ResolvedSchema by checking for `time`/`jsonb` column types
2. Added `normalizeSchema()` helper - auto-converts ResolvedSchema to GeneratedSchema if needed
3. Updated `createOrm()` to call `normalizeSchema()` internally on schema input
4. Both schema types now work seamlessly with `createOrm()`

**Completed Tasks:**
- [x] Investigate ResolvedSchema type (packages/schema/src/types.ts)
- [x] Investigate GeneratedSchema type (packages/core/src/dx/schema-bridge.ts)
- [x] Document differences between the two types
- [x] Answer: Why do we have both types? (necessary separation)
- [x] Propose solutions (A: unify, B: hide conversion, C: document)
- [x] Implement Option B: auto-convert in createOrm
- [x] Add `isResolvedSchema()` type guard
- [x] Add `normalizeSchema()` helper function
- [x] Update createOrm to use normalizeSchema internally
- [x] Export new functions from dx/index.ts
- [x] Add tests for isResolvedSchema (6 tests)
- [x] Add tests for normalizeSchema (5 tests)
- [x] All 41 tests passing

**New Public API:**
```typescript
import { isResolvedSchema, normalizeSchema } from '@dbsp/core';

// Type detection
isResolvedSchema(schema); // true if has time/jsonb types

// Manual normalization (if needed)
const generated = normalizeSchema(resolvedOrGenerated);

// Auto-normalization (preferred - just use createOrm directly)
const orm = createOrm({ schema, adapter }); // Works with either type!
```

**Limitation:** If a ResolvedSchema has no `time` or `jsonb` columns, it cannot be distinguished from GeneratedSchema. In this case, it's treated as GeneratedSchema (which works because the types are structurally compatible for common types).

---

## DX-101: Nested Include Syntax Clarification

**Status:** ✅ DONE (2025-01-11)

**Problem:** Unclear syntax for nested includes.

```typescript
// Which one is correct?
.include('posts.author')                          // A: dot notation ✅ PRIMARY
.include('posts', { include: ['author'] })        // B: options object (internal)
.include({ posts: { include: 'author' } })        // C: nested object ❌ NOT SUPPORTED
```

**Resolution:** 
- Option A (dot notation) is the **canonical and recommended syntax**
- Options apply to the deepest level: `.include('posts.author', { via: 'commentAuthor' })`
- Multiple includes via chaining: `.include('posts').include('profile')`
- This was a **documentation issue**, not an API design issue

**Completed Tasks:**
- [x] Determined canonical syntax: dot notation (e.g., `'posts.comments.author'`)
- [x] Evaluated: documentation issue (API already supports dot notation well)
- [x] Added "Common Patterns" section to README.md with comprehensive examples
- [x] Documented all include options (via, where, select, recursive, etc.)

---

## DX-102: Remove `<any>` from createOrm ✅ COMPLETED (2026-01-11)

**Problem:** Type inference doesn't work, forcing `<any>`.

```typescript
// Before: Required explicit generic
const orm = createOrm<any>({ schema, adapter });

// After: Full inference from schema
const schema = { tables: { users: { id: { type: 'uuid' } } } } as const satisfies GeneratedSchema;
const orm = createOrm({ schema, adapter });
orm.select('users');  // ← Autocomplete on table names works!
```

**Solution:**
1. Made `GeneratedSchema<TTables>` generic to preserve table name types
2. Added type utilities: `InferDBFromSchema<S>`, `InferRowType<T>`, `ColumnTypeToTS<T>`
3. Updated `createOrm` overloads to infer DB type from schema
4. Added comprehensive type tests in `type-inference.test.ts`

**Completed Tasks:**
- [x] Investigate why type inference fails
- [x] Fix generic constraints on `createOrm`
- [x] Ensure table names autocomplete in `select()`
- [x] Ensure column names autocomplete (object filter syntax: `where({ fieldName: value })`)
- [x] Add type tests to prevent regression

**Limitation:** Standalone filter helpers like `eq('field', value)` cannot provide column autocomplete
because they don't have table context. Use object filter syntax for type-safe column names:
```typescript
// Object filter (typed): where({ name: 'John' })  ✅ autocomplete works
// Filter helper: where(eq('name', 'John'))        ❌ no autocomplete (accepts any string)
```

---

## DX-103: QueryBuilder God Object (SRP Violation) ✅ COMPLETED (2026-01-11)

**Problem:** `QueryBuilderImpl` handles too many responsibilities:
- Intent construction
- Planning
- Compilation
- Execution
- Hydration
- Pagination
- Recursive queries

**Impact:** Difficult to evolve without side effects.

**File:** `packages/core/src/dx/orm.ts`

**Solution:**
Extracted three focused classes to separate concerns:
1. `IntentBuilder` - builds QueryIntent AST from builder state
2. `ResultHydrator` - handles result hydration and recursive include processing
3. `QueryExecutor` - handles query execution via adapter

**Completed Tasks:**
- [x] Identify separable concerns
- [x] Extract `IntentBuilder` class (`packages/core/src/dx/intent-builder.ts`)
- [x] Extract `ResultHydrator` class (`packages/core/src/dx/result-hydrator.ts`)
- [x] Extract `QueryExecutor` class (`packages/core/src/dx/query-executor.ts`)
- [x] Export new classes from `packages/core/src/dx/index.ts`
- [x] All 1293 tests passing (no regressions)

**New Public API:**
```typescript
import {
  IntentBuilder,
  ResultHydrator,
  QueryExecutor,
  type IntentBuilderState,
  type RecursiveIncludeConfig,
  type ExecutionContext,
  type HydrateOptions,
} from '@dbsp/core';
```

**Note:** QueryBuilderImpl still exists and functions as before. The extracted classes
are available for gradual migration or for building custom query builders. This is
phase 1 of the refactoring - QueryBuilderImpl can be progressively updated to
delegate to these extracted classes in future iterations.

---

## DX-104: Adapter Interface Too Large (ISP Violation) ✅ COMPLETED (2026-01-11)

**Problem:** `Adapter` interface requires implementing everything:
- `compile()` / `execute()` / `stream()`
- `introspect()`
- `executeRaw()`
- `transaction()`
- `validate()`

**Impact:** Implementing a new adapter (e.g., Drizzle) is costly even if only basic features are needed.

**File:** `packages/core/src/adapter.ts`

**Solution:**
Split into focused interfaces with composition:

**Completed Tasks:**
- [x] Split into smaller interfaces: `BaseAdapter`, `CompilingAdapter`, `ExecutingAdapter`, `StreamingAdapter`, `IntrospectingAdapter`, `TransactionalAdapter`, `RawSqlAdapter`
- [x] Use interface composition: `type Adapter = ExecutingAdapter & StreamingAdapter & IntrospectingAdapter & TransactionalAdapter & RawSqlAdapter`
- [x] Allow partial implementations with runtime feature detection helpers
- [x] Added convenience types: `CompileOnlyAdapter`, `BasicAdapter`

**New Public API:**
```typescript
import {
  // Split interfaces
  BaseAdapter,
  CompilingAdapter,
  ExecutingAdapter,
  StreamingAdapter,
  IntrospectingAdapter,
  TransactionalAdapter,
  RawSqlAdapter,
  // Composed types
  Adapter,           // Full adapter (all features)
  CompileOnlyAdapter, // Just compile, no execute
  BasicAdapter,       // Compile + execute only
  // Feature detection helpers
  supportsStreaming,
  supportsIntrospection,
  supportsTransactions,
  supportsRawSql,
  supportsExecution,
} from '@dbsp/core';

// Example: Feature detection
if (supportsStreaming(adapter)) {
  // TypeScript knows adapter has stream() method
  const iterator = adapter.stream(query);
}
```

---

## DX-105: Dialect Capabilities Duplication (OCP Risk) ✅ COMPLETED (2026-01-12)

**Problem:** Dialect capabilities were maintained in TWO places:
- `packages/core/src/dialects/index.ts` - SQL syntax variations
- `packages/adapter-kysely/src/dialect.ts` - Runtime feature detection

**Risk:** Divergence between core's assumptions and adapter's actual behavior.

**Analysis:**
After investigation, the two systems serve **different purposes** that justify their separation:

| System | Purpose | Examples |
|--------|---------|----------|
| Core `DialectCapabilities` | SQL syntax generation | `recursivePathStyle`, `stringConcatStyle`, `identifierQuote`, `parameterStyle` |
| Adapter `DialectCapabilities` | Runtime feature detection | `supportsStreaming`, `supportsWithSchema`, `supportsCycleDetection` |
| Core `AdapterCapabilities` | Interface contract | Subset that adapters must expose |

**Overlap:** Both had `supportsArrayType`, `supportsReturning`, `supportsWindowFunctions`.

**Solution Implemented:**
1. Created `MergedCapabilities` interface in compiler that combines both
2. Adapter capabilities are **authoritative** for feature flags (e.g., `supportsArrayType`)
3. Core capabilities provide **SQL syntax info** only (e.g., `recursivePathStyle`, `stringConcatStyle`)
4. Added `getMergedCapabilities()` function that merges appropriately
5. Updated path tracking functions to use merged capabilities

**Key Changes:**
- `packages/adapter-kysely/src/compiler.ts`:
  - Added `MergedCapabilities` interface
  - Added `getMergedCapabilities()` function
  - Updated `compilePathTrackingBaseCase()` to use `MergedCapabilities`
  - Updated `compilePathTrackingRecursive()` to use `MergedCapabilities`
  - Updated all call sites to use `getMergedCapabilities()` instead of `getCoreCapabilitiesForDialect()`

**Result:** Adapter is now authoritative for feature detection. Core provides SQL syntax info.
All 657 adapter-kysely tests passing.

**Completed Tasks:**
- [x] Analyze what each system provides
- [x] Determine single source of truth (adapter for features, core for syntax)
- [x] Implemented merged capabilities with adapter as authoritative for features
- [x] No duplication removal needed - systems serve different purposes
- [x] All tests passing

---

## DX-106: Brittle Dialect Detection ✅ COMPLETED (2026-01-11)

**Problem:** Detection based on Kysely internals (constructor name).

```typescript
// Before: Fragile - breaks on minification
const dialectName = dialect.constructor.name; // "PostgresDialect"

// After: Explicit dialect option + graceful fallback
const adapter = createKyselyAdapter(db, undefined, 'postgresql');
```

**Solution:**
1. Added optional `dialect` parameter to `createKyselyAdapter()` and `KyselyAdapter` constructor
2. Explicit dialect always takes precedence (recommended for production builds)
3. Added `tryDetectByBehavior()` fallback when constructor.name is mangled
4. Graceful fallback to 'unknown' with safe default capabilities

**Completed Tasks:**
- [x] Find stable detection method → explicit `dialect` option
- [x] Add fallback for unknown dialects → `UNKNOWN_CAPABILITIES` with safe defaults
- [x] Add test with mocked/custom dialect to catch regressions → 6 new tests

---

## DX-107: Raw SQL Escape Hatches (OWASP Vigilance)

**Status:** ✅ DONE (2025-01-11)

**Problem:** `raw()` and `executeRaw()` bypass SQL injection protections.

**Resolution:** Added prominent JSDoc warnings with OWASP references.

**Files updated:**
- `packages/core/src/dx/filters.ts` - `raw()` function
- `packages/core/src/adapter.ts` - `executeRaw` interface method
- `packages/core/src/dx/orm.ts` - `orm.raw()` method

**Completed Tasks:**
- [x] Added prominent JSDoc warnings with **SECURITY RISK** headers
- [x] Added safe vs dangerous usage examples in each JSDoc
- [x] Added OWASP reference links (SQL Injection + Parameterization Cheat Sheet)
- [x] ⏭️ `dangerouslyExecuteRaw()` naming - SKIPPED (breaking change, JSDoc warnings suffisent)
- [x] ✅ Log raw() usage in dump() plan warnings (observabilité sécurité) (2026-01-15)
- [x] ⏭️ Document in README security section - SKIPPED (JSDoc auto-generated dans API docs)

---

## DX-108: Introspection Type Mapping Lossy ✅ COMPLETED (2026-01-12)

**Problem:** DB types → ModelIR mapping loses precision.

```typescript
// Example: decimal → number loses precision info
// PostgreSQL DECIMAL(10,2) becomes just "number"
```

**File:** `packages/adapter-kysely/src/introspection.ts`

**Solution Implemented:**

1. **Fixed type mappings that already had support in ColumnType:**
   - `uuid` → `uuid` (was incorrectly mapping to `string`)
   - `bigint` → `bigint` (was incorrectly mapping to `number`)
   - `timestamp/timestamptz` → `datetime` (more accurate than `date`)

2. **Added `originalDbType` field to ColumnIR:**
   - Preserves full database type string (e.g., `varchar(255)`, `numeric(10,2)`)
   - Available via introspection for consumers who need precision info
   - Optional field - manually defined schemas don't require it

3. **Added lossy conversion warnings:**
   - Introspection now adds warnings for lossy type conversions
   - Examples: `"Column 'prices.amount': decimal precision (10,2) is not preserved"`
   - Warnings in `IntrospectedModelIR.warnings` array

**Type Mapping Summary:**

| DB Type | ModelIR Type | Lossy? | Reason |
|---------|--------------|--------|--------|
| `uuid` | `uuid` | No | Exact mapping |
| `varchar(N)`, `char(N)` | `string` | Yes | Length lost |
| `text` | `string` | No | No precision |
| `bigint`, `bigserial` | `bigint` | No | Exact mapping for JS BigInt |
| `int`, `smallint`, `serial` | `number` | No | Exact mapping |
| `numeric(P,S)`, `decimal(P,S)` | `number` | Yes | Precision/scale lost |
| `float`, `double`, `real` | `number` | No | Exact mapping |
| `boolean` | `boolean` | No | Exact mapping |
| `timestamp` | `datetime` | No | Exact mapping |
| `timestamptz` | `datetime` | Yes | Timezone info lost |
| `date` | `date` | No | Exact mapping |
| `time`, `timetz` | `date` | Yes | Time-only not supported |
| `json` | `json` | No | Exact mapping |
| `jsonb` | `json` | Yes | jsonb vs json distinction lost |
| Unknown types | `string` | Yes | Type info lost |

**Usage:**
```typescript
const model = await introspect(db);

// Access original DB type for precision info
const col = model.getTable('prices')?.columns.find(c => c.name === 'amount');
console.log(col.type);          // 'number'
console.log(col.originalDbType); // 'numeric(10,2)'

// Check for lossy conversion warnings
for (const warning of model.warnings) {
  console.log(warning); // "Column 'prices.amount': decimal precision (10,2) is not preserved"
}
```

**Completed Tasks:**
- [x] Audit current type mappings
- [x] Fix uuid → uuid mapping (was incorrectly mapping to string)
- [x] Fix bigint → bigint mapping (was incorrectly mapping to number)
- [x] Fix timestamp → datetime mapping (more accurate than date)
- [x] Add `originalDbType` field to ColumnIR interface
- [x] Implement `mapColumnTypeDetailed()` with lossy conversion detection
- [x] Add warnings for lossy conversions in introspection output
- [x] Add tests for originalDbType preservation
- [x] Add tests for lossy conversion warnings
- [x] All 50 introspection tests passing

---

## DX-109: Core Package Mixed Concerns ✅ COMPLETED (2026-01-12)

**Problem:** `packages/core` mixes domain (ModelIR, IntentAST, Planner) with infrastructure (DX execution, hydration).

**Assessment:** After thorough analysis, the current structure is actually a **proper Hexagonal Architecture** implementation, not a violation.

**Resolution:** Documented in [ADR-004: Core Package Layered Structure](docs/adrs/ADR-004-core-package-layered-structure.md)

**Key Findings:**
1. **Domain layer** (model-ir, intent-ast, planner): Pure, no adapter/dx imports
2. **Port** (adapter.ts): Interface contract, imports domain types only
3. **Application layer** (dx/): Orchestrates domain + port, depends on both
4. Dependencies flow correctly: Domain ← Port ← Application ← Adapters

**Decision:** Keep current structure. The dx/ subdirectory is the "application layer" in hexagonal terms - orchestrating domain logic through the port interface. This is intentional, not a violation.

**Completed Tasks:**
- [x] Analyzed current structure and dependency flow (2026-01-12)
- [x] Verified domain layer has no dx/ imports (2026-01-12)
- [x] Evaluated separation options (A: separate package, B: keep with docs, C: rename)
- [x] Selected Option B: Keep in core with documented layering
- [x] Created ADR-004 documenting the architectural decision
- [x] Added dependency-cruiser rule recommendation for enforcement

---

## Quick Wins (High Value, Low Effort)

| ID | Task | Effort | Status |
|----|------|--------|--------|
| DX-102 | Fix `createOrm` type inference | Medium | ✅ DONE (2026-01-11) |
| DX-101 | Document nested include syntax | Low | ✅ DONE |
| DX-107 | Add JSDoc warnings on raw() | Low | ✅ DONE |
| DX-106 | Add dialect detection fallback | Low | ✅ DONE (2026-01-11) |

---

## Future Considerations

- [ ] CLI `dbsp init` wizard (like Prisma)
- [x] ✅ CLI: Add unit tests for `generateSchemaFile()` in schema-codegen.ts (2026-01-18)
- [x] ✅ CLI: Add E2E round-trip test for DDL generation (2026-01-18)
- [x] ✅ Unified export from @dbsp/core: createOrm, eq, gt, like, and, or, raw, etc. (2026-01-15)
  - Note: createMockAdapter reste dans @dbsp/adapter-kysely (architecture Ports & Adapters)
- [x] "Common Patterns" documentation section (DONE - added to README.md)
- [x] ✅ Type-safe schema definition with full inference chain (DX-110) (2026-01-15)
