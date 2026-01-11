# TODO: Developer Experience (DX)

> Feedback from real-world usage and code review
> Source: E2E implementation (REPL, CLI, query-executor) + architecture audit

## Status: 🟡 BACKLOG

---

## DX-100: Schema Type Unification

**Problem:** Two schema types that look similar but require conversion.

```typescript
// Current: Forced conversion
import { assertResolvedSchemaToGeneratedSchema } from '@db-semantic-planner/core';
const generatedSchema = assertResolvedSchemaToGeneratedSchema(schema);
const orm = createOrm<any>({ schema: generatedSchema, adapter });
```

**Questions to answer:**
- [ ] Why do we have `ResolvedSchema` AND `GeneratedSchema`?
- [ ] What motivates this separation?
- [ ] Can we simplify to a single schema type?
- [ ] If separation is necessary, can the conversion be hidden from users?

**Expected outcome:** User should only deal with ONE schema type.

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

## DX-103: QueryBuilder God Object (SRP Violation)

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

**Tasks:**
- [ ] Identify separable concerns
- [ ] Consider extracting: `IntentBuilder`, `QueryExecutor`, `ResultHydrator`
- [ ] Evaluate impact on public API (should remain unchanged)
- [ ] Refactor incrementally with tests as safety net

---

## DX-104: Adapter Interface Too Large (ISP Violation)

**Problem:** `Adapter` interface requires implementing everything:
- `compile()` / `execute()` / `stream()`
- `introspect()`
- `executeRaw()`
- `transaction()`
- `validate()`

**Impact:** Implementing a new adapter (e.g., Drizzle) is costly even if only basic features are needed.

**File:** `packages/core/src/adapter.ts`

**Tasks:**
- [ ] Split into smaller interfaces: `CompilingAdapter`, `StreamingAdapter`, `IntrospectingAdapter`
- [ ] Use interface composition: `type FullAdapter = CompilingAdapter & StreamingAdapter & ...`
- [ ] Allow partial implementations with runtime feature detection
- [ ] Update `createOrm` to accept partial adapters gracefully

---

## DX-105: Dialect Capabilities Duplication (OCP Risk)

**Problem:** Dialect capabilities are maintained in TWO places:
- `packages/core/src/dialects/index.ts`
- `packages/adapter-kysely/src/dialect.ts`

**Risk:** Divergence between core's assumptions and adapter's actual behavior.

**Tasks:**
- [ ] Analyze what each system provides
- [ ] Determine single source of truth (likely adapter, core queries it)
- [ ] Core should ask adapter "what can you do?" not assume
- [ ] Remove duplication

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
- [ ] Consider `dangerouslyExecuteRaw()` naming - DEFERRED (too breaking)
- [ ] Log usage in dump() plan - DEFERRED (separate task)
- [ ] Document in security section of README - DEFERRED (separate task)

---

## DX-108: Introspection Type Mapping Lossy

**Problem:** DB types → ModelIR mapping loses precision.

```typescript
// Example: decimal → number loses precision info
// PostgreSQL DECIMAL(10,2) becomes just "number"
```

**File:** `packages/adapter-kysely/src/introspection.ts`

**Tasks:**
- [ ] Audit current type mappings
- [ ] Consider richer type representation (e.g., `{ type: 'decimal', precision: 10, scale: 2 }`)
- [ ] Document known limitations
- [ ] Add warnings for lossy conversions in introspection output

---

## DX-109: Core Package Mixed Concerns

**Problem:** `packages/core` mixes domain (ModelIR, IntentAST, Planner) with infrastructure (DX execution, hydration).

**Assessment:** Pragmatic trade-off, but reduces strict clean architecture.

**File:** `packages/core/src/dx/orm.ts`

**Tasks:**
- [ ] Evaluate if `dx/` should be a separate package (`@db-semantic-planner/dx`)
- [ ] Consider: core = pure domain, dx = execution layer
- [ ] Weigh against "too many packages" fatigue
- [ ] Document architectural decision if keeping as-is

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
- [ ] Single unified export: `import { createOrm, eq, createMockAdapter } from '@db-semantic-planner'`
- [x] "Common Patterns" documentation section (DONE - added to README.md)
- [ ] Type-safe schema definition with full inference chain
