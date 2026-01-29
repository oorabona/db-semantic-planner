# ADAPTER-PGSQL Phase 2: Parity Validation + DDL Generation

**Status:** 🟡 IN PROGRESS
**Goal:** Validate adapter-pgsql produces identical results to adapter-kysely, add full DDL support

## Overview

Phase 2 prepares for the sunset of adapter-kysely by:
1. Wiring PgsqlAdapter to core's Adapter interface
2. Running E2E tests in dual-adapter comparison mode
3. Fixing any result mismatches
4. Implementing full DDL generation (CREATE/ALTER/DROP)

## Requirements

| Aspect | Decision |
|--------|----------|
| Parity level | **Result-based comparison** (execute both, compare DB results) |
| DDL scope | Full (CREATE TABLE, ALTER TABLE, DROP TABLE, indexes) |
| Activation | `DBSP_COMPARISON_MODE` env var (compare/strict) |
| Mutations | Execute both in transaction + rollback after comparison |
| Temporary | ComparisonAdapter + env var removed in Phase 3 (Sunset) |
| Out of scope | Migrations (deferred to post-sunset like Kysely) |

---

## Block 1: Wire PgsqlAdapter to Adapter Interface

### Goal
Create `PgsqlAdapter` class implementing core's `Adapter<DB>` interface.

### Required Adapter Methods (explicit checklist)

| Interface | Methods |
|-----------|---------|
| `CompilingAdapter` | `compile`, `compileWithIncludes`, `compileRecursive`, `compileInsert`, `compileInsertFrom`, `compileUpdate`, `compileDelete`, `compileUpsert`, `compileSubqueryInclude` |
| `ExecutingAdapter` | `execute`, `executeOne`, `executeOneOrThrow` |
| `StreamingAdapter` | `stream` |
| `TransactionalAdapter` | `transaction`, `withSchema` |
| `RawSqlAdapter` | `executeRaw` |
| `IntrospectingAdapter` | `introspect` (stub → Phase 4) |
| `DDLGeneratingAdapter` | `generateDDL` (Block 3) |
| `BaseAdapter` | `validateIdentifier`, `capabilities` |
| Properties | `namingConvention: NamingConvention` |

### Tasks
- [ ] Create `packages/adapter-pgsql/src/pgsql-adapter.ts`
- [ ] Implement all `CompilingAdapter` methods (see checklist above)
- [ ] Implement `ExecutingAdapter` methods (execute, executeOne, executeOneOrThrow)
- [ ] Implement `StreamingAdapter.stream()` with backpressure handling
- [ ] Implement `TransactionalAdapter` (transaction with savepoint support, withSchema)
- [ ] Implement `RawSqlAdapter.executeRaw()` with positional parameters ($1, $2)
- [ ] Stub `IntrospectingAdapter.introspect()` (throws "Not implemented - Phase 4")
- [ ] Implement `validateIdentifier()` and `capabilities` property
- [ ] Set `namingConvention` property from constructor options
- [ ] Export from `packages/adapter-pgsql/src/index.ts`

### Interface Reference
```typescript
// packages/core/src/adapter.ts line 354
export interface Adapter<DB = unknown>
  extends CompilingAdapter,
    ExecutingAdapter,
    StreamingAdapter,
    IntrospectingAdapter,
    TransactionalAdapter<DB>,
    RawSqlAdapter,
    DDLGeneratingAdapter {
  readonly namingConvention: NamingConvention;
}
```

---

## Block 2: E2E Comparison Mode

### Goal
Enable dual-adapter comparison in E2E tests via environment variable.
**Strategy: Result-based comparison** - execute both adapters, compare actual DB results.

### Tasks
- [ ] Update `tests/e2e/testkit/db.ts`:
  - Add `getPgsqlAdapter()` factory
  - Add `createComparisonAdapter()` returning dual-mode adapter
- [ ] Create comparison utilities in testkit:
  - `compareResults(results1, results2)` - deep equality with type coercion
  - `compareSql(sql1, sql2)` - optional SQL logging (not for parity decision)
- [ ] Implement `ComparisonExecutor`:
  - Execute query on both adapters
  - Wrap mutations in transaction + rollback
  - Compare results, log SQL diff for debugging
- [ ] Environment variable behavior:
  - `DBSP_COMPARISON_MODE=compare` → log mismatches, don't fail
  - `DBSP_COMPARISON_MODE=strict` → fail on any result mismatch
  - Not set → use KyselyAdapter only (current behavior)

### Result Comparison Strategy
```typescript
interface ComparisonResult {
  match: boolean;
  kyselyResult: unknown;
  pgsqlResult: unknown;
  kyselySql: string;
  pgsqlSql: string;
  diff?: ResultDiff;
}

async function compareExecution<T>(
  kysely: Adapter,
  pgsql: Adapter,
  query: CompiledQuery
): Promise<ComparisonResult> {
  // For SELECT: execute both, compare results
  // For mutations: wrap in transaction, execute both, compare, rollback
  const [kyselyResult, pgsqlResult] = await Promise.all([
    kysely.execute(query),
    pgsql.execute(query)
  ]);

  return {
    match: deepEqual(kyselyResult, pgsqlResult),
    kyselyResult,
    pgsqlResult,
    kyselySql: kysely.compile(query).sql,
    pgsqlSql: pgsql.compile(query).sql,
    diff: match ? undefined : computeDiff(kyselyResult, pgsqlResult)
  };
}
```

### Mutation Safety (Transaction Rollback)
```typescript
async function compareMutation<T>(
  kysely: Adapter,
  pgsql: Adapter,
  mutation: CompiledMutation
): Promise<ComparisonResult> {
  // Run in parallel transactions, both rollback
  const [kyselyResult, pgsqlResult] = await Promise.all([
    kysely.transaction(async (tx) => {
      const result = await tx.execute(mutation);
      throw new RollbackSignal(result); // Force rollback
    }).catch(e => e instanceof RollbackSignal ? e.result : throw e),
    pgsql.transaction(async (tx) => {
      const result = await tx.execute(mutation);
      throw new RollbackSignal(result);
    }).catch(e => e instanceof RollbackSignal ? e.result : throw e)
  ]);

  return { match: deepEqual(kyselyResult, pgsqlResult), ... };
}
```

---

## Block 3: DDL Generation

### Goal
Implement full DDL generation: CREATE TABLE, ALTER TABLE, DROP TABLE.

### Scope
| IN Scope (Phase 2) | OUT of Scope (Post-Sunset) |
|--------------------|---------------------------|
| CREATE TABLE | Migrations (diff-based ALTER) |
| ALTER TABLE (add column, add FK) | Schema versioning |
| DROP TABLE | Rollback scripts |
| CREATE INDEX | |
| All PostgreSQL types (SERIAL, UUID, JSONB, TIMESTAMPTZ, etc.) | |
| Constraints (PK, FK, UNIQUE, NOT NULL) | CHECK constraints (if not in ModelIR) |
| ON DELETE/UPDATE actions | DEFERRABLE constraints |

### Tasks
- [ ] Create `packages/adapter-pgsql/src/ddl/` module
- [ ] Implement `generateCreateTable(table: TableDefinition)`
- [ ] Implement `generateAlterTable(changes: TableChanges)`
- [ ] Implement `generateDropTable(tableName: string, options?: { cascade?: boolean })`
- [ ] Implement `generateCreateIndex(index: IndexDefinition)`
- [ ] Implement `generateDDL(schema: ModelIR)` - full schema DDL with dependency ordering
- [ ] PostgreSQL type mapping:
  - `string` → `TEXT` or `VARCHAR(n)`
  - `number` → `INTEGER`, `BIGINT`, `NUMERIC`, `DOUBLE PRECISION`
  - `boolean` → `BOOLEAN`
  - `Date` → `TIMESTAMP` or `TIMESTAMPTZ`
  - `uuid` → `UUID`
  - `json` → `JSONB`
  - `autoIncrement` → `SERIAL` / `BIGSERIAL`
- [ ] Handle constraints (PK, FK with ON DELETE/UPDATE, UNIQUE, NOT NULL)
- [ ] Handle index types (BTREE default, GIN for JSONB, UNIQUE)
- [ ] Topological sort for FK dependencies
- [ ] Tests for DDL generation

### DDL Examples
```sql
-- CREATE TABLE
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "email" VARCHAR(255) NOT NULL UNIQUE,
  "name" VARCHAR(100),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- CREATE INDEX
CREATE INDEX "idx_users_email" ON "users" ("email");
CREATE INDEX "idx_users_metadata" ON "users" USING GIN ("metadata");

-- ALTER TABLE (add column)
ALTER TABLE "users" ADD COLUMN "avatar_url" TEXT;

-- ALTER TABLE (add FK)
ALTER TABLE "posts"
  ADD CONSTRAINT "fk_posts_author"
  FOREIGN KEY ("author_id") REFERENCES "users"("id")
  ON DELETE CASCADE;

-- DROP TABLE
DROP TABLE IF EXISTS "users" CASCADE;
```

---

## Block 4: Fix Mismatches

### Goal
Run E2E with comparison mode and fix any result differences.

### Tasks
- [ ] Run `DBSP_COMPARISON_MODE=compare pnpm test:e2e`
- [ ] Collect all result mismatches (with SQL diff for debugging)
- [ ] Categorize:
  - **Bug**: Different results → fix in adapter-pgsql
  - **Type coercion**: Same value, different JS type → add to compareResults normalization
  - **Ordering**: Unordered results in different order → acceptable (document)
- [ ] Fix bugs in adapter-pgsql
- [ ] Document intentional divergences in `DIVERGENCES.md`
- [ ] Run `DBSP_COMPARISON_MODE=strict pnpm test:e2e` (must pass)

---

## Block 5: Documentation & Cleanup

### Goal
Finalize Phase 2 with documentation updates.

### Tasks
- [ ] Update TODO_ADAPTER_PGSQL.md marking Phase 2 complete
- [ ] Document any divergences in `DIVERGENCES.md` (if any)
- [ ] Clean up temporary comparison infrastructure notes

**Note:** CI integration deferred - no workflows exist yet, purely local development.

---

## BDD Scenarios

### SC-01: PgsqlAdapter produces same results as KyselyAdapter
```gherkin
Given a schema with users table
When I execute SELECT * FROM users via both adapters
Then the result sets are identical
```

### SC-02: Comparison mode logs mismatches
```gherkin
Given DBSP_COMPARISON_MODE=compare
And adapter-pgsql produces different results
When E2E test runs
Then mismatch is logged with SQL diff
And test does NOT fail
```

### SC-03: Strict mode fails on mismatch
```gherkin
Given DBSP_COMPARISON_MODE=strict
And adapter-pgsql produces different results
When E2E test runs
Then test fails with comparison error
And diff is shown for debugging
```

### SC-04: Mutations compared safely with rollback
```gherkin
Given DBSP_COMPARISON_MODE=strict
When I execute INSERT via comparison adapter
Then both adapters execute in separate transactions
And both transactions are rolled back
And results are compared
And no data is persisted
```

### SC-05: DDL generates CREATE TABLE
```gherkin
Given a ModelIR with users table definition
When I call generateDDL(schema)
Then output includes valid CREATE TABLE statement
And all columns have correct PostgreSQL types
And PK/FK constraints are included
And tables are ordered by FK dependencies
```

### SC-06: DDL generates ALTER TABLE
```gherkin
Given an existing table and a column to add
When I call generateAlterTable(changes)
Then output includes ALTER TABLE ADD COLUMN
```

---

## Definition of Done

- [ ] PgsqlAdapter implements full Adapter interface (all methods from checklist)
- [ ] E2E tests run with `DBSP_COMPARISON_MODE=strict` passing (local)
- [ ] Result-based comparison working (not just SQL string comparison)
- [ ] Mutations safely compared via transaction rollback
- [ ] DDL generation for CREATE/ALTER/DROP working
- [ ] Zero result mismatches between adapters (or documented divergences)
- [ ] Documentation updated

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `packages/adapter-pgsql/src/pgsql-adapter.ts` | CREATE |
| `packages/adapter-pgsql/src/ddl/index.ts` | CREATE |
| `packages/adapter-pgsql/src/ddl/create-table.ts` | CREATE |
| `packages/adapter-pgsql/src/ddl/alter-table.ts` | CREATE |
| `packages/adapter-pgsql/src/ddl/drop-table.ts` | CREATE |
| `packages/adapter-pgsql/src/ddl/create-index.ts` | CREATE |
| `packages/adapter-pgsql/src/ddl/types.ts` | CREATE |
| `packages/adapter-pgsql/src/ddl/dependency-sort.ts` | CREATE |
| `packages/adapter-pgsql/src/index.ts` | MODIFY (exports) |
| `tests/e2e/testkit/db.ts` | MODIFY (comparison) |
| `tests/e2e/testkit/comparison.ts` | CREATE |
| `tests/e2e/testkit/result-diff.ts` | CREATE |
| `docs/DIVERGENCES.md` | CREATE (if needed) |

---

## LLM Review Notes (2026-01-29)

**Reviewed by:** Codex, LM Studio
**Agreement:** HIGH on all gaps

Key improvements incorporated:
1. ✅ Explicit Adapter method checklist (no more "etc.")
2. ✅ Result-based comparison instead of naive SQL normalization
3. ✅ Transaction rollback for mutation safety
4. ✅ Clear DDL scope (full except migrations)
5. ✅ Type coercion handling in result comparison
