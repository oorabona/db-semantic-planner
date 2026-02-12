---
doc-meta:
  status: canonical
  scope: adapter
  type: specification
  created: 2026-02-12
  updated: 2026-02-12
---

# E15 — FOR UPDATE SKIP LOCKED + E15b Atomic Lock+Update

## Overview

Row-level locking for job queue patterns. Adds `FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE` with `SKIP LOCKED` and `NOWAIT` wait policies to the full stack: types, planner (pass-through), AST helper, compiler, DX QueryBuilder, and NQL grammar.

## 1. Types — `LockIntent`

### 1.1 New Type: `LockIntent`

```typescript
// packages/types/src/intent/lock-intent.ts

/** Row-level lock strength for SELECT queries. */
export type LockStrength =
  | 'forUpdate'
  | 'forNoKeyUpdate'
  | 'forShare'
  | 'forKeyShare';

/** Wait policy when a lock conflict is encountered. */
export type LockWaitPolicy =
  | 'block'       // Default: wait indefinitely
  | 'skipLocked'  // Skip already-locked rows
  | 'noWait';     // Error immediately if row is locked

/** Declarative lock intent for SELECT queries. */
export interface LockIntent {
  readonly strength: LockStrength;
  readonly waitPolicy: LockWaitPolicy;
}
```

### 1.2 Extend `QueryIntent`

```typescript
// packages/types/src/intent/query-intent.ts
export interface QueryIntent {
  // ... existing fields ...

  /**
   * Row-level lock for SELECT queries (e.g., FOR UPDATE SKIP LOCKED).
   * Only valid in SELECT context — incompatible with DISTINCT, GROUP BY, EXISTS wrap, set operations.
   */
  readonly lock?: LockIntent;
}
```

### 1.3 Barrel Export

Add `lock-intent.ts` to `packages/types/src/intent/index.ts` barrel.

## 2. Planner — Pass-through

No planner changes needed. The `lock` field on `QueryIntent` passes through `PlanReport.intent` unchanged. The planner makes no decisions about locking — it's a user directive.

**Lock scoping for JOINs (INV-E15-06):** When the query has includes (JOINs), the compiler automatically scopes the lock to the root table only by emitting `FOR UPDATE OF "root_table"`. This prevents accidental locking of related/joined tables (lock amplification). The `lockedRels` field on the `LockingClause` AST node carries the root table's `RangeVar`.

## 3. AST Helper — `selectStmt()` Extension

### 3.1 Extend `SelectOptions`

```typescript
// packages/adapter-pgsql/src/ast-helpers.ts
export interface SelectOptions {
  // ... existing fields ...

  /** Row-level locking clause (FOR UPDATE/SHARE/etc.) */
  lockingClause?: {
    strength: LockClauseStrength;
    waitPolicy?: LockWaitPolicy;
  };
}
```

### 3.2 Extend `selectStmt()`

After the `withClause` block, add:

```typescript
if (options.lockingClause) {
  stmt.lockingClause = [{
    LockingClause: {
      strength: options.lockingClause.strength,
      waitPolicy: options.lockingClause.waitPolicy ?? LockWaitPolicy.LockWaitBlock,
    },
  }];
}
```

### 3.3 Mapping Helper

```typescript
// packages/adapter-pgsql/src/ast-helpers.ts (or new lock-helpers.ts)
import { LockClauseStrength, LockWaitPolicy } from '@pgsql/types';
import type { LockIntent } from '@dbsp/types';

export function mapLockToAst(lock: LockIntent): {
  strength: LockClauseStrength;
  waitPolicy: LockWaitPolicy;
} {
  const strengthMap: Record<LockStrength, LockClauseStrength> = {
    forUpdate: LockClauseStrength.LCS_FORUPDATE,
    forNoKeyUpdate: LockClauseStrength.LCS_FORNOKEYUPDATE,
    forShare: LockClauseStrength.LCS_FORSHARE,
    forKeyShare: LockClauseStrength.LCS_FORKEYSHARE,
  };
  const policyMap: Record<LockWaitPolicy, PgLockWaitPolicy> = {
    block: LockWaitPolicy.LockWaitBlock,
    skipLocked: LockWaitPolicy.LockWaitSkip,
    noWait: LockWaitPolicy.LockWaitError,
  };
  return {
    strength: strengthMap[lock.strength],
    waitPolicy: policyMap[lock.waitPolicy],
  };
}
```

## 4. Compiler — Emit `lockingClause`

The compiler reads `plan.intent.lock` and passes it to `selectStmt()` via the new `lockingClause` option.

**Location:** The main `compile()` method in `packages/adapter-pgsql/src/compiler/index.ts` (or the appropriate file that builds the final SelectStmt).

**Logic:**
```typescript
// When building selectStmt options:
if (intent.lock) {
  selectOptions.lockingClause = mapLockToAst(intent.lock);
}
```

## 5. DX — QueryBuilder Methods

### 5.1 New Properties on `QueryBuilderImpl`

```typescript
private lockIntent?: LockIntent;
```

### 5.2 New Chainable Methods

```typescript
forUpdate(): this {
  this.lockIntent = { strength: 'forUpdate', waitPolicy: this.lockIntent?.waitPolicy ?? 'block' };
  return this;
}

forShare(): this {
  this.lockIntent = { strength: 'forShare', waitPolicy: this.lockIntent?.waitPolicy ?? 'block' };
  return this;
}

forNoKeyUpdate(): this {
  this.lockIntent = { strength: 'forNoKeyUpdate', waitPolicy: this.lockIntent?.waitPolicy ?? 'block' };
  return this;
}

forKeyShare(): this {
  this.lockIntent = { strength: 'forKeyShare', waitPolicy: this.lockIntent?.waitPolicy ?? 'block' };
  return this;
}

/** Convenience: set lock with explicit strength and optional wait policy. */
lock(strength: LockStrength, waitPolicy?: LockWaitPolicy): this {
  this.lockIntent = { strength, waitPolicy: waitPolicy ?? 'block' };
  return this;
}

skipLocked(): this {
  if (!this.lockIntent) throw new Error('skipLocked() requires a preceding lock method (forUpdate, forShare, etc.)');
  this.lockIntent = { ...this.lockIntent, waitPolicy: 'skipLocked' };
  return this;
}

noWait(): this {
  if (!this.lockIntent) throw new Error('noWait() requires a preceding lock method (forUpdate, forShare, etc.)');
  this.lockIntent = { ...this.lockIntent, waitPolicy: 'noWait' };
  return this;
}
```

### 5.3 Validation in `buildIntent()`

```typescript
if (this.lockIntent) {
  // Core validates ONLY universal SQL standard restrictions:
  if (this.groupByFields.length > 0) throw new Error('FOR UPDATE/SHARE is incompatible with GROUP BY');
  // existsWrap check handled separately
  // Note: DISTINCT + FOR UPDATE is dialect-specific. Core does NOT restrict it.
  // The adapter compiler is responsible for throwing if its dialect doesn't support a combo.
  intent.lock = this.lockIntent;
}
```

### 5.4 Warning at `execute()` Time

When `lockIntent` is set and `inTransaction === false`, emit a console warning:
```
⚠ Warning: forUpdate()/forShare() used outside a transaction context. Lock may not be effective.
```

### 5.5 Clone Support

The `clone()` method must copy `lockIntent`.

### 5.6 TypedQueryBuilder Interface

Add methods to the public type interface in `orm-instance-types.ts`.

## 6. NQL Grammar

### 6.1 New Tokens

```
For       = 'for'
// 'update' already exists as Update token
Share     = 'share'
Skip      = 'skip'
Locked    = 'locked'
NoWait    = 'nowait'
NoKey     = 'no'  // context: 'no key'
Key       = 'key'
```

**Note:** `for`, `share`, `skip`, `locked`, `nowait`, `no`, `key` are context keywords — only reserved after `| for`.

### 6.2 Grammar Rule

```
lockClause
  : For lockStrength lockWaitPolicy?
  ;

lockStrength
  : Update                          // FOR UPDATE
  | Share                           // FOR SHARE
  | NoKey Update                    // FOR NO KEY UPDATE (2-token lookahead)
  | Key Share                       // FOR KEY SHARE
  ;

lockWaitPolicy
  : Skip Locked                     // SKIP LOCKED
  | NoWait                          // NOWAIT
  ;
```

### 6.3 Parser Integration

Add `lockClause` as an optional tail clause in the query pipeline (after `limit`/`offset`):

```
queryPipeline
  : tableName (Pipe operator)*
  ;

operator
  : whereClause | selectClause | orderByClause | groupByClause
  | limitClause | offsetClause | distinctClause | lockClause
  | includeClause | ...
  ;
```

### 6.4 NQL Compiler

In `packages/nql/src/compiler/`, the lock clause visitor sets `QueryIntent.lock`:

```typescript
if (ctx.lockClause) {
  intent.lock = {
    strength: parseLockStrength(ctx.lockClause),
    waitPolicy: parseLockWaitPolicy(ctx.lockClause) ?? 'block',
  };
}
```

## 7. BDD Scenarios

### Scenario 1: Basic FOR UPDATE compilation
```
Given NQL: jobs | where status = 'pending' | limit 1 | for update
When compiled to SQL
Then SQL ends with: FOR UPDATE
And parameters: ['pending', 1]
```

### Scenario 2: FOR UPDATE SKIP LOCKED compilation
```
Given NQL: jobs | where status = 'pending' | limit 1 | for update skip locked
When compiled to SQL
Then SQL ends with: FOR UPDATE SKIP LOCKED
```

### Scenario 3: FOR SHARE NOWAIT compilation
```
Given NQL: jobs | select id, title | for share nowait
When compiled to SQL
Then SQL ends with: FOR SHARE NOWAIT
```

### Scenario 4: FOR NO KEY UPDATE compilation
```
Given NQL: jobs | for no key update
When compiled to SQL
Then SQL ends with: FOR NO KEY UPDATE
```

### Scenario 5: FOR KEY SHARE compilation
```
Given NQL: jobs | for key share skip locked
When compiled to SQL
Then SQL ends with: FOR KEY SHARE SKIP LOCKED
```

### Scenario 6: DX QueryBuilder API
```
Given: orm.select('jobs').where(eq('status','pending')).limit(1).forUpdate().skipLocked()
When dumped
Then SQL contains: FOR UPDATE SKIP LOCKED
```

### Scenario 7: Lock convenience method
```
Given: orm.select('jobs').lock('forUpdate', 'skipLocked')
When dumped
Then SQL contains: FOR UPDATE SKIP LOCKED
```

### Scenario 8: skipLocked without lock strength
```
Given: orm.select('jobs').skipLocked()
When called
Then throws: 'skipLocked() requires a preceding lock method'
```

### Scenario 9: Warning outside transaction
```
Given: orm.select('jobs').forUpdate().all() (not in transaction)
When executed
Then console warning emitted about lock outside transaction
And query still executes (warning, not error)
```

### Scenario 10: Lock scoped to root table with includes
```
Given: orm.select('orders').include('customer').forUpdate()
When compiled
Then SQL contains: FOR UPDATE OF "orders"
And SQL does NOT lock customer table
```

### Scenario 11: E15b — Job queue pattern (E2E)
```
Given: 2 jobs with status = 'pending' in database
And 2 concurrent transactions each running:
  SELECT * FROM jobs WHERE status = 'pending' LIMIT 1 FOR UPDATE SKIP LOCKED
When both transactions execute simultaneously
Then each transaction gets a different job
And no row is returned to both
```

## 8. Implementation Plan — Blocks

### Block 1: Types + AST Helper (foundation)

**Files:**
- `packages/types/src/intent/lock-intent.ts` (NEW)
- `packages/types/src/intent/query-intent.ts` (MODIFY — add `lock?: LockIntent`)
- `packages/types/src/intent/index.ts` (MODIFY — re-export)
- `packages/adapter-pgsql/src/ast-helpers.ts` (MODIFY — `SelectOptions.lockingClause`, `selectStmt()` extension, `mapLockToAst()`)

**Tests:**
- `packages/adapter-pgsql/src/__tests__/ast-helpers-lock.test.ts` (NEW — selectStmt with lockingClause deparse tests)

**Exit criteria:**
- `selectStmt({ ..., lockingClause: { strength, waitPolicy } })` produces correct AST
- Deparse produces `SELECT ... FOR UPDATE SKIP LOCKED`
- tsc clean

**Dependencies:** None

### Block 2: Compiler Integration

**Files:**
- `packages/adapter-pgsql/src/compiler/compile-query.ts` (MODIFY — read `intent.lock`, pass to selectStmt)

**Tests:**
- `packages/adapter-pgsql/src/__tests__/nql-to-sql.test.ts` (ADD — lock clause compilation tests with all 4 strengths × 3 policies)

**Exit criteria:**
- `QueryIntent` with `lock` compiles to correct SQL via compile-only adapter
- All 4 lock strengths produce correct SQL
- All 3 wait policies produce correct SQL
- tsc clean, all existing tests pass

**Dependencies:** Block 1

### Block 3: DX QueryBuilder

**Files:**
- `packages/core/src/dx/query-builder.ts` (MODIFY — add lock methods, validation, warning)
- `packages/core/src/dx/orm-instance-types.ts` (MODIFY — add methods to TypedQueryBuilder interface)

**Tests:**
- `packages/core/src/dx/query-builder.test.ts` (ADD — lock method tests: chaining, validation, dump output, clone)

**Exit criteria:**
- `.forUpdate().skipLocked()` produces correct intent
- Validation throws on incompatible combinations
- Warning emitted outside transaction
- Clone preserves lock state
- tsc clean

**Dependencies:** Block 1 (types), Block 2 (for integration dump tests)

### Block 4: NQL Grammar + Compiler

**Files:**
- `packages/nql/src/lexer.ts` (MODIFY — add tokens)
- `packages/nql/src/parser.ts` (MODIFY — add lockClause rule)
- `packages/nql/src/visitor.ts` (MODIFY — visit lockClause)
- `packages/nql/src/compiler/compile-query.ts` (MODIFY — emit lock on intent)

**Tests:**
- `packages/nql/src/__tests__/lock-clause.test.ts` (NEW — parse + compile tests for all lock combinations)

**Exit criteria:**
- `jobs | for update skip locked` parses and compiles to correct QueryIntent
- All 4 strengths × 3 policies parse correctly
- `for update` does not conflict with `update table` mutation
- tsc clean

**Dependencies:** Block 1 (types)

### Block 5: NQL → SQL Integration + E2E

**Files:**
- `packages/adapter-pgsql/src/__tests__/nql-to-sql.test.ts` (ADD — full NQL→SQL lock tests)
- `examples/test-locking.schema.ts` (NEW — job queue schema)
- `examples/test-locking.dbsp` (NEW — NQL lock queries)
- `examples/test-locking.assert.dbsp` (NEW — assertions)

**Tests:**
- Full pipeline NQL → parse → plan → compile → SQL
- E2E assertion file validation

**Exit criteria:**
- NQL lock clauses produce correct SQL through full pipeline
- Example files work with batch mode
- tsc clean, all tests pass

**Dependencies:** Block 2, Block 4

### Block 6: E15b — Concurrent Lock+Update E2E

**Files:**
- `tests/e2e/locking.test.ts` (NEW — concurrent job queue test)

**Tests:**
- Two concurrent workers claiming jobs with FOR UPDATE SKIP LOCKED
- Verify each gets different row
- Verify lock prevents double-processing

**Exit criteria:**
- Concurrent test passes reliably
- Pattern documented

**Dependencies:** Block 5

## 9. Invariants

- **INV-E15-01**: Lock strength is a closed enum — no arbitrary strings
- **INV-E15-02**: Wait policy is a closed enum, default `block`
- **INV-E15-03**: Lock validation split — Core validates SQL-standard restrictions (GROUP BY, set ops); Adapter validates dialect-specific restrictions (DISTINCT etc.)
- **INV-E15-04**: Warning (not error) when lock used without transaction
- **INV-E15-05**: `lockedRels` used automatically: compiler scopes lock to root table when query has JOINs/includes
- **INV-E15-06**: DISTINCT + FOR UPDATE is allowed (PostgreSQL supports it); only GROUP BY is rejected

## 10. Out of Scope (Deferred)

- `FOR UPDATE OF custom_table_name` — user-specified table-scoped locking (auto-scoping to root table IS included)
- Advisory locks (`pg_advisory_lock`)
- Multiple lock clauses per query
- Lock on mutations (SQL standard: SELECT only)
- Lock timeout configuration
