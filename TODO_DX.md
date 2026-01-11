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

**Problem:** Unclear syntax for nested includes.

```typescript
// Which one is correct?
.include('posts.author')                          // A: dot notation
.include('posts', { include: ['author'] })        // B: options object
.include({ posts: { include: 'author' } })        // C: nested object
```

**Owner note:** "I would have said option C but I'm not even sure myself!"

**Tasks:**
- [ ] Determine the canonical syntax (one primary way)
- [ ] Evaluate if this is a documentation issue OR an API design issue
- [ ] If API issue: consider supporting multiple syntaxes with clear docs
- [ ] If doc issue: add "Common Patterns" section to README with examples
- [ ] Add TypeScript overloads to guide users via autocomplete

---

## DX-102: Remove `<any>` from createOrm

**Problem:** Type inference doesn't work, forcing `<any>`.

```typescript
// Current: Absurd
const orm = createOrm<any>({ schema, adapter });

// Expected: Full inference
const orm = createOrm({ schema, adapter });
orm.select('users');  // ← Autocomplete on table names
```

**Priority:** HIGH - This is fundamental for a TypeScript-first ORM.

**Tasks:**
- [ ] Investigate why type inference fails
- [ ] Fix generic constraints on `createOrm`
- [ ] Ensure table names autocomplete
- [ ] Ensure column names autocomplete in `where()`, `orderBy()`, etc.
- [ ] Add type tests to prevent regression

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

## DX-106: Brittle Dialect Detection

**Problem:** Detection based on Kysely internals (constructor name).

```typescript
// Current approach - fragile
const dialectName = dialect.constructor.name; // "PostgresDialect"
```

**Risk:** Breaks on Kysely updates, minification, or custom dialects.

**File:** `packages/adapter-kysely/src/dialect.ts`

**Tasks:**
- [ ] Find stable detection method (Kysely config? explicit option?)
- [ ] Add fallback for unknown dialects
- [ ] Add test with mocked/custom dialect to catch regressions

---

## DX-107: Raw SQL Escape Hatches (OWASP Vigilance)

**Problem:** `raw()` and `executeRaw()` bypass SQL injection protections.

**Current status:** Assumed risk, reserved for experts.

**Files:** `packages/core/src/dx/filters.ts`, `packages/core/src/adapter.ts`

**Tasks:**
- [ ] Add prominent JSDoc warnings on these functions
- [ ] Consider `dangerouslyExecuteRaw()` naming to signal risk
- [ ] Log usage in dump() plan for audit trail
- [ ] Document in security section of README

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

| ID | Task | Effort |
|----|------|--------|
| DX-102 | Fix `createOrm` type inference | Medium |
| DX-101 | Document nested include syntax | Low |
| DX-107 | Add JSDoc warnings on raw() | Low |
| DX-106 | Add dialect detection fallback | Low |

---

## Future Considerations

- [ ] CLI `dbsp init` wizard (like Prisma)
- [ ] Single unified export: `import { createOrm, eq, createMockAdapter } from '@db-semantic-planner'`
- [ ] "Common Patterns" documentation section
- [ ] Type-safe schema definition with full inference chain
