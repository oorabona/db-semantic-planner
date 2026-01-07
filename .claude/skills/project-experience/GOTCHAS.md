# Project Gotchas - db-semantic-planner

## TypeScript

### exactOptionalPropertyTypes Requires Conditional Assignment (2026-01-07)

**Issue:** When building objects with optional properties under `exactOptionalPropertyTypes`, assigning `undefined` explicitly fails type checking.

**Cause:** TypeScript distinguishes between "property is missing" and "property is undefined".

**Solution:** Use conditional property assignment:
```typescript
// WRONG - fails exactOptionalPropertyTypes
const intent: QueryIntent = {
  type: 'select',
  from: this.from,
  where: this.whereIntent,  // Error if whereIntent is undefined
};

// CORRECT - only add property if defined
const intent: QueryIntent = {
  type: 'select',
  from: this.from,
};
if (this.whereIntent !== undefined) {
  (intent as { where: WhereIntent }).where = this.whereIntent;
}
```

**Location:** `packages/dx/src/orm.ts` lines 54-79, 156-173

---

## Planner Behavior

### Via Hint Uses Relation Name Lookup (2026-01-07)

**Issue:** When `via` option is provided, the planner uses it as the relation name to look up directly.

**Cause:** The planner treats `via` as a relation name, not just a disambiguation hint. If the relation doesn't exist, it adds a warning and skips the include rather than throwing an error.

**Implication:** Invalid `via` hints don't throw - they result in warnings in `PlanReport.warnings`.

**Location:** `packages/dx/src/strict-mode.test.ts` Scenario 7

---

### Relation Hints Must Clone Object for Immutability (2026-01-07)

**Issue:** When implementing per-query relation hints with an immutable builder pattern, the hints object must be cloned on each `clone()` call.

**Cause:** If the same object reference is shared, calling `withRelationHint()` on one builder modifies all clones.

**Solution:** Clone the hints object in the builder's `clone()` method:
```typescript
private clone(): QueryBuilderImpl {
  const builder = new QueryBuilderImpl(
    this.model,
    this.strictMode,
    this.from,
    { ...this.relationHints }  // <-- Clone here
  );
  // ... copy other fields
  return builder;
}
```

**Location:** `packages/dx/src/orm.ts` line 313

---

## Kysely

### CompiledQuery.raw() for EXPLAIN Prefix (2026-01-07)

**Issue:** Need to execute EXPLAIN on an already-compiled Kysely query without re-building from scratch.

**Solution:** Use `CompiledQuery.raw(sql, params)` factory method to create a new CompiledQuery with modified SQL while preserving the original parameters.

```typescript
import { CompiledQuery } from 'kysely';

const compiled = query.compile(); // Original query
const explainSql = `EXPLAIN (FORMAT JSON) ${compiled.sql}`;
const explainQuery = CompiledQuery.raw(explainSql, compiled.parameters as unknown[]);
const result = await db.executeQuery(explainQuery);
```

**Key insight:** `CompiledQuery.raw()` is the proper way to construct arbitrary SQL that Kysely can execute while maintaining type safety at the execution layer.

**Location:** `packages/adapter-kysely/src/explain.ts` lines 35-45

---

## Architecture

### Ports and Adapters Strict Dependency Order (2026-01-07)

**Rule:** packages/core MUST NOT import from packages/adapter-* or packages/dx

**Order:** core -> adapter-kysely -> dx

**Enforcement:** Use tsconfig project references or ESLint no-restricted-imports

**Location:** CLAUDE.md, Architecture section
