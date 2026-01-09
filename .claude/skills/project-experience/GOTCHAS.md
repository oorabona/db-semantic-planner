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

---

## E2E Testing

### Testcontainers in WSL2/Podman Requires Ryuk Disabled (2026-01-07)

**Issue:** When running Testcontainers with Podman in WSL2, container cleanup via Ryuk fails with connection errors.

**Cause:** Ryuk (Testcontainers' resource reaper) has compatibility issues with Podman's Docker socket emulation in WSL2.

**Solution:** Set `TESTCONTAINERS_RYUK_DISABLED=true` in vitest config env:
```typescript
// vitest.config.e2e.ts
export default defineConfig({
  test: {
    env: {
      TESTCONTAINERS_RYUK_DISABLED: 'true',
    },
  },
});
```

**Alternative:** Explicitly stop container in globalTeardown (which we do anyway).

**Location:** `tests/e2e/vitest.config.e2e.ts`

---

### PostgreSQL EXPLAIN Cannot Use Parameterized Queries (2026-01-07)

**Issue:** Running `EXPLAIN (FORMAT JSON) SELECT ... WHERE col = $1` with parameters fails with "there is no parameter $1".

**Cause:** PostgreSQL's EXPLAIN command parses the SQL but doesn't actually prepare it, so parameter placeholders are not resolved.

**Solution:** For EXPLAIN tests, only test non-parameterized queries or inline literal values:
```typescript
// Works - no parameters
const sql = 'SELECT * FROM products WHERE active = true';
await sql.raw(`EXPLAIN (FORMAT JSON) ${sql}`).execute(db);

// Fails - parameterized
const sql = 'SELECT * FROM products WHERE active = $1';
await sql.raw(`EXPLAIN (FORMAT JSON) ${sql}`, [true]).execute(db); // ERROR
```

**Workaround:** Test EXPLAIN functionality separately from parameterized query execution.

**Location:** `tests/e2e/explain.integration.test.ts`

---

### EXISTS Subqueries Need Schema Prefix in Multi-tenant (2026-01-07) — RESOLVED

**Issue:** When using `forTenant('schema')`, EXISTS subqueries reference tables without schema prefix, causing "relation does not exist" errors.

**Cause:** The compiler adds schema prefix to main table references but not to tables inside EXISTS subqueries.

**Impact:** Multi-tenant EXISTS queries fail at runtime. Unit tests pass because they don't execute against real PostgreSQL.

**Solution (2026-01-07):** Thread `schemaName` parameter through the compiler call chain:
- `compile()` → `addWhere()` → `compileWhere()` → `compileExists()` / `compileRelationFilter()`
- Apply schema prefix in `compileExists()` using same pattern as root table: `const targetTable = schemaName ? \`${schemaName}.${relation.target}\` : relation.target`
- Forward `schemaName` to nested `compileWhere()` calls for deeply nested EXISTS

**Location:** `packages/adapter-kysely/src/compiler.ts` lines 64, 128, 144, 166, 173, 179, 183, 186, 189, 245, 307-310, 328, 351, 364, 376, 394

---

### Streaming stream() Must Throw Synchronously for Missing DB (2026-01-07)

**Issue:** When implementing `stream()` on QueryBuilder, the method returns `AsyncIterableIterator` but should throw `ExecutionError` synchronously if db is not configured.

**Cause:** Unlike `findMany()` which returns a Promise and can reject asynchronously, `stream()` returns an iterator. If we check db inside the generator, the error would only surface when `.next()` is called.

**Solution:** Check db configuration synchronously before returning the iterator:
```typescript
stream(options?: StreamOptions): AsyncIterableIterator<unknown> {
  const db = this.getConfiguredDb();  // Throws synchronously
  const dumpResult = this.dump();
  return streamQuery(db, dumpResult, options);
}
```

**Test Implication:** Tests must expect synchronous throw, not async rejection:
```typescript
// WRONG - expects async error
await expect(async () => {
  for await (const _row of orm.query('users').stream()) {}
}).rejects.toThrow(ExecutionError);

// CORRECT - expects sync throw
expect(() => orm.query('users').stream()).toThrow(ExecutionError);
```

**Location:** `packages/dx/src/orm.ts` lines 341-348, `packages/dx/src/orm-execution.test.ts`

---

### Build Order Critical When Adding New Exports (2026-01-07)

**Issue:** When adding new types to `packages/core` and using them in `packages/adapter-kysely`, TypeScript compilation fails with "Module has no exported member" errors.

**Cause:** TypeScript in a pnpm monorepo reads compiled `.d.ts` files from dist/ directories. Adding a new export to a source file doesn't make it visible to dependent packages until the package is rebuilt.

**Solution:** Always rebuild upstream packages before running typecheck on downstream:
```bash
# After adding exports to core
pnpm -C packages/core build

# Then typecheck adapter (which depends on core)
pnpm -C packages/adapter-kysely typecheck
```

**Build order for this project:**
```
packages/core → packages/adapter-kysely → packages/dx
```

**Location:** Encountered when adding `AggregateFunction`, `AggregateIntent`, `SelectAggregateIntent` to `packages/core/src/intent-ast.ts`

---

## Adapter Implementation

### NEVER Use Raw SQL Templates in Adapter Code (2026-01-08)

**Issue:** Using `sql` template literals (e.g., `` sql`COALESCE(...)` ``) instead of Kysely's native expression builder APIs.

**Cause:** Habit from writing raw SQL, or not knowing Kysely has native functions.

**Why it's wrong:**
1. **Dialect portability:** Kysely's `eb.fn('coalesce')` adapts per dialect; raw SQL doesn't
2. **Type safety:** Native APIs provide TypeScript inference; raw templates lose types
3. **Security:** Native APIs handle escaping properly
4. **Maintainability:** Expression builders are more readable and refactorable

**Solution:** Always use Kysely expression builder methods:

```typescript
// ❌ WRONG - raw SQL template
const refs = fields.map((f) => sql.ref(`${alias}.${f}`));
const coalesceExpr = sql`COALESCE(${sql.join(refs, sql`, `)})`;
return query.select(coalesceExpr.as(resultAlias));

// ✅ CORRECT - native expression builder
return query.select((eb) =>
  eb.fn('coalesce', fields.map((f) => eb.ref(`${alias}.${f}`))).as(resultAlias)
);

// ❌ WRONG - literal via sql
query.select(sql`1`)

// ✅ CORRECT - native literal
query.select((eb) => eb.lit(1).as('_exists'))
```

**Exception:** The ONLY valid use of `sql` is for:
1. `RawExpressionIntent` — the explicit user escape hatch for SQL that cannot be expressed via intents
2. PostgreSQL array operations in recursive CTEs — `ARRAY[id]::text[]` path tracking via `sql.lit()` (Kysely lacks native PG array type support)

**Location:** `packages/adapter-kysely/src/compiler.ts`, `CLAUDE.md` (Adapter Rules section)

---

### Recursive CTE: Bidirectional Edge Detection Requires edgeStorageHint (2026-01-08)

**Issue:** When implementing recursive CTEs with edge-table traversal, need to distinguish between edges stored as symmetric pairs vs single rows requiring dual lookup.

**Cause:** Two common edge storage patterns:
- **Symmetric pairs:** Each edge stored twice (A→B, B→A) - use `UNION ALL`, no self-join
- **Single row, dual lookup:** One row per edge (A↔B) - requires self-join of CTE in recursive step

**Solution:** `edgeStorageHint: 'edges_symmetric' | 'edges_bidir'` in EdgeTableTraversal:

```typescript
// 'edges_symmetric' (default): UNION ALL, edges stored as pairs
// Node 1→2 exists as: (parent_id=1, child_id=2) AND (parent_id=2, child_id=1)
// SQL: ... UNION ALL SELECT ...

// 'edges_bidir': UNION, single row with dual lookup
// Node 1↔2 exists as single row: (from_id=1, to_id=2) OR lookup via (to_id=1, from_id=2)  
// SQL: ... UNION SELECT ... (deduplicates via UNION)
```

**Key insight:** The `bidirectional-edges` decision in PlanReport triggers `UNION` instead of `UNION ALL` to prevent duplicates from dual lookup.

**Location:** `packages/core/src/intent-ast.ts` EdgeTableTraversal, `packages/adapter-kysely/src/compiler.ts` compileRecursive()

---

### TypeScript: Underscore Prefix for Reserved/Unused Parameters (2026-01-08)

**Issue:** Biome lint error `noUnusedFunctionParameters` for parameters reserved for future use.

**Cause:** Function signature includes parameter that's not used in current implementation but will be needed later.

**Solution:** Prefix with underscore and add comment explaining purpose:

```typescript
// ❌ WRONG - lint error
function compileRecursive(plan: Plan, model: ModelIR): Result {
  // model not used yet
}

// ✅ CORRECT - lint passes, intent documented
function compileRecursive(
  plan: Plan,
  _model: ModelIR, // Reserved for future use (e.g., relation metadata lookups)
): Result {
  // _model available when needed
}
```

**Location:** `packages/adapter-kysely/src/compiler.ts:126`

---

### Introspection: Don't Transform Data From Source (2026-01-08)

**Issue:** Attempted to pluralize table names for hasMany relations. `pluralize('posts')` returned `'postses'`.

**Root cause:** Over-engineering. Tried to be "smart" by transforming table names instead of using them as-is.

**Lesson learned:**
1. Introspection gives real names → use them directly
2. Don't invent data that doesn't exist
3. If manual schema definition, developer provides real names
4. Transformations are fragile and will break on edge cases

**Solution:** Use source data directly, no transformation:

```typescript
// ❌ WRONG - over-engineering
const hasManyName = pluralize(fk.sourceTable);

// ✅ CORRECT - use as-is
const hasManyName = fk.sourceTable;
```

**Location:** `packages/adapter-kysely/src/introspection.ts` - `inferRelations()`

---

### defineSchema().build() Required for Full ModelIR (2026-01-09)

**Issue:** Test using `defineSchema({...})` directly as model fails with "model.getTable is not a function".

**Cause:** `defineSchema()` returns a schema builder object, not a full ModelIR. The `.build()` method must be called to produce a ModelIR with methods like `getTable()`, `getRelationsTo()`, etc.

**Wrong pattern:**
```typescript
const testSchema = defineSchema({
  products: { id: 'integer', name: 'string' }
});
// testSchema is SchemaBuilder, NOT ModelIR
orm.query('products')  // Fails: "model.getTable is not a function"
```

**Solution:** Always call `.build()` on defineSchema:
```typescript
const testModel = defineSchema({
  products: { id: 'integer', name: 'string' }
}).build();
// testModel is now a proper ModelIR with all methods
```

**Location:** `packages/dx/src/window-functions.test.ts` line 15-35

---

### Biome: Use Helper Functions for Array Access (2026-01-09)

**Issue:** Biome's `noNonNullAssertion` rule flags `array[0]!` patterns even when logic guarantees non-empty array.

**Cause:** TypeScript's type system can't prove array access is safe. `arr[0]!` bypasses type checking, which Biome prohibits.

**Wrong pattern:**
```typescript
const pkColumns = metadata.primaryKey!.columns;
const firstCol = pkColumns[0]!;  // Biome error: noNonNullAssertion
```

**Solution:** Create helper functions with explicit checks:

```typescript
function first<T>(arr: readonly T[], fallback: T): T {
  const element = arr[0];
  return element !== undefined ? element : fallback;
}

function firstOrThrow<T>(arr: readonly T[], context: string): T {
  const element = arr[0];
  if (element === undefined) {
    throw new Error(`Expected non-empty array in ${context}`);
  }
  return element;
}

// Usage
const firstCol = first(pkColumns, 'id');  // With fallback
const required = firstOrThrow(fk.sourceColumns, 'FK source columns');  // Throws if empty
```

**Key insight:** The `element !== undefined` check satisfies both TypeScript and Biome because it proves the element exists at runtime.

**Location:** `packages/adapter-kysely/src/introspection.ts` lines 16-31
