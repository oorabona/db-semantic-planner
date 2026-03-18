---
doc-meta:
  status: draft
  scope: types + core + adapter-pgsql + nql
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-03-18
  updated: 2026-03-18
  complexity: ENTERPRISE
  time-budget: 3h
  adversarial_applied: true
---

# Specification: BATCH-001 — Batch Unnest API

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | types, core, adapter-pgsql, nql |
| Complexity | ENTERPRISE |
| Time budget | ~4h |
| Blocks | 5 |
| BDD scenarios | 19 |
| Risk level | MEDIUM |
| Adversarial | 5/5 perspectives, 9 challenges, 8 resolved, 1 deferred |
| Origin | astix ORM migration — 17 batch/unnest patterns |

## 1. Problem Statement

dbsp's current bulk insert compiles to `VALUES ($1,$2),($3,$4),...` which hits PostgreSQL's 65535 parameter limit at ~5000 rows with 12 columns. astix routinely inserts 1000+ rows per batch.

PostgreSQL's `INSERT ... SELECT unnest($1::int[]), unnest($2::text[])` pattern uses only N parameters (one per column) regardless of row count — enabling million-row batches.

Additionally, astix needs:
- Batch UPDATE via `UPDATE ... FROM unnest() AS t(...)` (4 patterns, not supported)
- `ANY($1::type[])` operator in WHERE for membership tests (3 patterns, no filter helper)
- CTE with unnest inputs for batch correlation queries (5 patterns)

## 2. User Stories

### US-1: Batch INSERT
AS A developer using dbsp for bulk data ingestion
I WANT to insert thousands of rows efficiently via unnest
SO THAT I avoid the 65535 parameter limit and get better performance

### US-2: Batch UPDATE
AS A developer maintaining data integrity
I WANT to update multiple rows by ID in a single query
SO THAT batch operations are atomic and efficient

### US-3: Array membership in WHERE
AS A developer writing queries
I WANT to use `any('col', arrayParam)` in WHERE conditions
SO THAT I can filter by array membership without subqueries

## 3. Business Rules

### 3.1 Invariants
- INV-01: All array parameters MUST be parameterized ($N::type[]) — never interpolated
- INV-02: Parallel unnest arrays MUST have equal length — validated at build time
- INV-03: Existing `.values([...])` API MUST continue to work (backward compat)
- INV-04: Type casting MUST be explicit in SQL (`$1::int[]`, `$2::text[]`)
- INV-05: Array type inference MUST only produce whitelisted PG types: int, int8, float8, text, bool, jsonb, or explicit dbType (DX-050)
- INV-06: NULL values in arrays MUST be preserved positionally (unnest with NULLs keeps alignment)
- INV-07: Optional `maxBatchSize` in CompileOptions — if set and rows exceed limit, throw InvalidOperationError. Default: no limit.

### 3.2 Preconditions
- PRE-01: Batch insert requires at least 1 row
- PRE-02: Batch update requires at least 1 update object with an ID column
- PRE-03: Array parameter for ANY() must not be empty (PostgreSQL returns no rows)

### 3.3 Effects
- EFF-01: Batch insert compiles to `INSERT INTO "t" SELECT unnest($1::int[]), unnest($2::text[])`
- EFF-02: Batch update compiles to `UPDATE "t" SET "col" = t."col" FROM unnest($1::int[], $2::int[]) AS t("id", "col") WHERE "t"."id" = t."id"`
- EFF-03: ANY() compiles to `"col" = ANY($1::type[])`
- EFF-04: RETURNING clause works with batch operations

### 3.4 Error Handling
- ERR-01: Empty values array → InvalidOperationError('No values provided')
- ERR-02: Mismatched array lengths (if detectable) → InvalidOperationError('Array length mismatch')
- ERR-03: Unknown column type for casting → fall back to `text[]` (only if type not in whitelist)
- ERR-04: Empty batchSet array → InvalidOperationError('No updates provided')
- ERR-05: batchSet columns not in table schema → InvalidOperationError('Unknown column: X')

## 4. Technical Design

### 4.1 Architecture Decision

**Strategy: Compilation-level switch, not API-level.**

The existing `.values([...])` API stays unchanged. The adapter switches compilation strategy based on batch size:
- **Small batches (≤ threshold)**: Current `VALUES ($1,$2),($3,$4)` (fewer round-trips for small data)
- **Large batches (> threshold)**: `INSERT ... SELECT unnest($1::type[]), unnest($2::type[])` (avoids param limit)

Default threshold: **50 rows** (configurable via `CompileOptions.batchThreshold`). Set to 0 to force unnest always. Rationale: unnest has slight overhead for tiny batches but dominates at scale.

For batch UPDATE: new `.batchSet()` method on UpdateBuilder since the SQL pattern is fundamentally different from single-row SET.

### 4.2 Type Mapping (Schema-Driven — from /llm consensus)

**Primary strategy:** Derive array type from target column's ModelIR type (schema-driven).
**Fallback:** Runtime inspection only when schema unavailable (e.g. raw queries).

| Column Type (ModelIR) | PostgreSQL Array | Notes |
|----------------------|-----------------|-------|
| `integer` | `int[]` | Schema-driven |
| `decimal` / `float` | `float8[]` | Schema-driven |
| `text` / `string` | `text[]` | Schema-driven |
| `boolean` | `bool[]` | Schema-driven |
| Custom (`dbType`) | `dbType[]` | DX-050 integration |
| `null` in array | Same type, NULL value | Preserves position in unnest |

**Runtime fallback** (no schema): `Number.isInteger(sample)` → int[], typeof → text[]/bool[].

### 4.2b Sparse Batch Handling (from /llm consensus)

- Rows with **missing keys** → those columns omitted from the INSERT column list for that batch
- If ALL rows share same shape → single INSERT with unnest (optimal)
- If shapes differ → **group by shape, emit one INSERT per shape group**
- Missing **required** (non-nullable, no default) column → ERR at build time

### 4.2c Array Cardinality Validation (from /llm consensus)

- Before SQL generation: validate all column arrays have equal length
- On mismatch → InvalidOperationError('Array length mismatch: col1=N, col2=M')
- PostgreSQL's `unnest(a, b)` silently NULL-pads shorter arrays — we MUST NOT rely on this

### 4.3 API Surface

#### Batch INSERT (enhanced existing)
```typescript
// Existing API — no changes, just smarter compilation
orm.insert('embeddings')
  .values([
    { symbol_id: 1, vector: '...', chunk_text: 'hello' },
    { symbol_id: 2, vector: '...', chunk_text: 'world' },
  ])
  .returning(['id'])
  .execute();

// Compiles to (when batch > threshold):
// INSERT INTO "embeddings" ("symbol_id", "vector", "chunk_text")
// SELECT unnest($1::int[]), unnest($2::text[]), unnest($3::text[])
// RETURNING "id"
```

#### Batch UPDATE (new method)
```typescript
orm.update('calls')
  .batchSet(
    'id',  // match column (string or string[] for composite PKs)
    [
      { id: 10, callee_id: 42 },
      { id: 20, callee_id: 43 },
    ]
  )
  .execute();

// Compiles to:
// UPDATE "calls" SET "callee_id" = t."callee_id"
// FROM unnest($1::int[], $2::int[]) AS t("id", "callee_id")
// WHERE "calls"."id" = t."id"
```

#### Batch UPDATE with scalar + array mix
```typescript
orm.update('calls')
  .batchSet(
    'id',
    [{ id: 10, callee_id: 42 }, { id: 20, callee_id: 43 }],
  )
  .set({ confidence: 0.85 })  // scalar applied to all rows
  .execute();

// Compiles to:
// UPDATE "calls" SET "callee_id" = t."callee_id", "confidence" = $3
// FROM unnest($1::int[], $2::int[]) AS t("id", "callee_id")
// WHERE "calls"."id" = t."id"
```

#### ANY() operator
```typescript
import { any } from '@dbsp/core';

orm.select('symbols')
  .where(any('id', [1, 2, 3]))
  .all();

// Compiles to:
// SELECT * FROM "symbols" WHERE "id" = ANY($1::int[])
```

#### NQL syntax for ANY
```nql
SELECT * FROM symbols WHERE id = ANY(:ids)
```
Where `:ids` is bound as an array parameter.

#### Batch UPSERT (enhanced existing)
```typescript
orm.upsert('embeddings')
  .values([...rows])
  .onConflict(['symbol_id', 'chunk_index'])
  .doUpdate(['vector', 'chunk_text', 'body_hash'])
  .returning(['id'])
  .execute();

// Large batch compiles to:
// INSERT INTO "embeddings" (...) SELECT unnest($1::int[]), ...
// ON CONFLICT ("symbol_id", "chunk_index") DO UPDATE SET ...
// RETURNING "id"
```

#### CTE with unnest (new builder)
```typescript
orm.withCte('lookups')
  .fromUnnest({
    parent_file_id: [1, 2, 3],
    parent_name: ['Foo', 'Bar', 'Baz'],
    child_name: ['method1', 'method2', 'method3'],
  })
  .withIndex('idx')  // adds WITH ORDINALITY correlation column
  .query(
    orm.select('symbols')
      .where(/* join to lookups CTE */)
  )
  .all();

// Compiles to (using WITH ORDINALITY — from /llm consensus):
// WITH "lookups" AS (
//   SELECT "parent_file_id", "parent_name", "child_name", (ordinality - 1) AS "idx"
//   FROM unnest($1::int[], $2::text[], $3::text[])
//     WITH ORDINALITY AS t("parent_file_id", "parent_name", "child_name", ordinality)
// )
// SELECT ... FROM "symbols" s JOIN "lookups" l ON ...
```

#### Dual-path CTE
```typescript
// Study: express via raw CTE composition or dedicated builder
// For now: document as supported via executeRaw() escape hatch
// Future: orm.withCte().fastPath(...).fallbackPath(...).select(...)
```

### 4.4 NQL Grammar Extensions

#### ANY operator
```
expression = ... | anyExpression ;
anyExpression = columnRef '=' 'ANY' '(' parameter ')' ;
```

Example: `SELECT * FROM symbols WHERE id = ANY(:ids)`

#### WITH ... AS (non-recursive)
```
withClause = 'WITH' cteDefinition (',' cteDefinition)* selectStatement ;
cteDefinition = identifier 'AS' '(' selectStatement ')' ;
```

Example: `WITH active AS (SELECT * FROM users WHERE active) SELECT * FROM active WHERE role = 'admin'`

## 5. Acceptance Criteria (BDD)

### Scenario Group: Batch INSERT

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Batch insert compiles to unnest for large batches
  Given a table "embeddings" with columns (id, symbol_id, vector, chunk_text)
  When inserting 100 rows via .values([...100 objects])
  Then SQL must use "SELECT unnest($1::int[]), unnest($2::text[]), unnest($3::text[])"
  And parameters must be 3 arrays of length 100

@priority:high @type:nominal
Scenario: SC-02 — Small batch insert uses VALUES syntax
  Given a table "users" with columns (id, name)
  When inserting 3 rows via .values([...3 objects])
  Then SQL must use "VALUES ($1, $2), ($3, $4), ($5, $6)"

@priority:high @type:nominal
Scenario: SC-03 — Batch insert with RETURNING
  Given a table "variable_defs" with columns and RETURNING id
  When inserting 50 rows with .returning(['id'])
  Then SQL must end with "RETURNING \"id\""
  And result must be an array of {id: number}

@priority:medium @type:edge
Scenario: SC-04 — Empty values array rejected
  When inserting 0 rows via .values([])
  Then InvalidOperationError must be thrown with message "No values"
```

### Scenario Group: Batch UPDATE

```gherkin
@priority:high @type:nominal
Scenario: SC-05 — Batch update via unnest FROM
  Given a table "calls" with columns (id, callee_id)
  When batch updating [{id:10, callee_id:42}, {id:20, callee_id:43}]
  Then SQL must use "UPDATE \"calls\" SET \"callee_id\" = t.\"callee_id\" FROM unnest($1::int[], $2::int[]) AS t(\"id\", \"callee_id\") WHERE \"calls\".\"id\" = t.\"id\""
  And parameters must be [[10,20], [42,43]]

@priority:high @type:nominal
Scenario: SC-06 — Batch update with mixed scalar and array
  Given a table "calls" with scalar confidence=0.85
  When batch updating callee_id for 2 rows + set confidence
  Then SQL must include both "t.\"callee_id\"" and "\"confidence\" = $3"
  And $3 must be 0.85 (scalar)

@priority:medium @type:edge
Scenario: SC-07 — Batch update with RETURNING
  Given a table "imports" with RETURNING id
  When batch updating resolved_file_id for 5 rows
  Then SQL must end with "RETURNING \"id\""
```

### Scenario Group: ANY() operator

```gherkin
@priority:high @type:nominal
Scenario: SC-08 — ANY compiles to PostgreSQL ANY($N::type[])
  Given a WHERE clause with any('id', [1, 2, 3])
  When compiling
  Then SQL must contain "\"id\" = ANY($1::int[])"
  And parameter $1 must be [1, 2, 3]

@priority:high @type:nominal
Scenario: SC-09 — ANY with text array
  Given a WHERE clause with any('name', ['alice', 'bob'])
  When compiling
  Then SQL must contain "\"name\" = ANY($1::text[])"

@priority:medium @type:edge
Scenario: SC-10 — ANY with empty array
  Given a WHERE clause with any('id', [])
  When compiling
  Then must compile to "\"id\" = ANY($1::int[])" (PostgreSQL handles empty array correctly — returns no rows)

@priority:medium @type:nominal
Scenario: SC-11 — NQL ANY syntax
  Given NQL query "SELECT * FROM symbols WHERE id = ANY(:ids)"
  When parsing and compiling with ids = [1,2,3]
  Then SQL must contain "\"id\" = ANY($1::int[])"
```

### Scenario Group: Batch UPSERT

```gherkin
@priority:high @type:nominal
Scenario: SC-12 — Batch upsert with unnest + ON CONFLICT
  Given a table "embeddings" with conflict on (symbol_id, chunk_index)
  When upserting 100 rows via .values([...]).onConflict([...]).doUpdate([...])
  Then SQL must use "INSERT INTO ... SELECT unnest(...) ON CONFLICT ... DO UPDATE SET ..."

@priority:medium @type:edge
Scenario: SC-13 — Batch upsert with EXISTS filter
  Given a batch upsert with WHERE EXISTS subquery
  When compiling
  Then subquery must appear in the SELECT source (not after unnest)

@priority:medium @type:edge
Scenario: SC-19 — Threshold=0 forces unnest even for small batches
  Given CompileOptions.batchThreshold = 0
  When inserting 2 rows
  Then SQL must use unnest (not VALUES)
```

### Scenario Group: CTE with unnest

```gherkin
@priority:high @type:nominal
Scenario: SC-14 — CTE with unnest arrays + WITH ORDINALITY index
  Given a withCte('lookups').fromUnnest({col1: [...], col2: [...]}).withIndex('idx')
  When compiling
  Then SQL must use FROM unnest($1::type[], $2::type[]) WITH ORDINALITY AS t("col1", "col2", ordinality)
  And "idx" must be (ordinality - 1)

@priority:high @type:nominal
Scenario: SC-15 — CTE unnest joined with main query
  Given a CTE with unnest lookups joined to a SELECT
  When compiling
  Then outer SELECT must reference CTE alias in JOIN

@priority:medium @type:edge
Scenario: SC-16 — CTE with recursive + unnest batch input
  Given a recursive CTE with unnest-based anchor
  When compiling
  Then anchor CTE must be non-recursive, recursive CTE references it

@priority:medium @type:nominal
Scenario: SC-17 — NQL non-recursive WITH syntax
  Given NQL query "WITH active AS (SELECT * FROM users WHERE active = true) SELECT * FROM active"
  When parsing
  Then AST must contain WithClause with 1 CTE definition

@priority:low @type:nominal
Scenario: SC-18 — Dual-path CTE (study/design only)
  Given two query strategies (fast-path and fallback)
  When composing
  Then design document must describe how to express dual-path via CTE composition
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | ✓ | | | |
| SC-04 | | | ✓ | |
| SC-05 | ✓ | | | |
| SC-06 | ✓ | | | |
| SC-07 | | ✓ | | |
| SC-08 | ✓ | | | |
| SC-09 | ✓ | | | |
| SC-10 | | ✓ | | |
| SC-11 | ✓ | | | |
| SC-12 | ✓ | | | |
| SC-13 | | ✓ | | |
| SC-14 | ✓ | | | |
| SC-15 | ✓ | | | |
| SC-16 | | ✓ | | |
| SC-17 | ✓ | | | |
| SC-18 | ✓ | | | |

## 6. Implementation Plan

### Block 1: ANY() operator + NQL syntax — ~45 min
**Type:** Feature slice (types + core + adapter + nql)
**Dependencies:** None

**Files:**
- `packages/types/src/intent/expression-intent.ts` — Add `AnyExpressionIntent` type
- `packages/core/src/dx/filters.ts` — Add `any(column, values)` helper
- `packages/adapter-pgsql/src/handlers/where/comparison.ts` — Handle ANY compilation
- `packages/adapter-pgsql/src/ast-helpers.ts` — Add `anyExpr()` AST helper
- `packages/nql/src/lexer.ts` — Add ANY keyword token
- `packages/nql/src/parser.ts` — Add anyExpression rule
- `packages/nql/src/compiler/compile-where.ts` — Compile ANY to intent

**Exit criteria:**
- [ ] `any('id', [1,2,3])` compiles to `"id" = ANY($1::int[])`
- [ ] NQL `WHERE id = ANY(:ids)` parses and compiles correctly
- [ ] Tests: SC-08, SC-09, SC-10, SC-11

### Block 2: Batch INSERT via unnest — ~45 min
**Type:** Enhancement (adapter compilation strategy)
**Dependencies:** None (parallel with Block 1)

**Files:**
- `packages/adapter-pgsql/src/pgsql-adapter.ts` — Switch compileInsert to unnest for large batches
- `packages/adapter-pgsql/src/compiler-utils.ts` — Add `buildUnnestSelect()` helper
- `packages/adapter-pgsql/src/type-inference.ts` — Add `inferPgArrayType(values)` utility
- `packages/types/src/adapter.ts` — Add `batchThreshold?: number` to CompileOptions

**Exit criteria:**
- [ ] 100-row insert compiles to `INSERT ... SELECT unnest()`
- [ ] 3-row insert still uses VALUES syntax
- [ ] RETURNING works with unnest strategy
- [ ] Tests: SC-01, SC-02, SC-03, SC-04

### Block 3: Batch UPDATE via unnest FROM — ~60 min
**Type:** New feature (new builder method + adapter compilation)
**Dependencies:** Block 2 (reuses `inferPgArrayType` and `buildUnnestSelect`)

**Files:**
- `packages/types/src/intent/mutation-intent.ts` — Add `BatchUpdateIntent` type
- `packages/core/src/dx/mutation-builders.ts` — Add `.batchSet()` method to UpdateBuilder
- `packages/adapter-pgsql/src/pgsql-adapter.ts` — Add `compileBatchUpdate()` method
- `packages/adapter-pgsql/src/compiler-utils.ts` — Add `buildUnnestFrom()` helper

**Exit criteria:**
- [ ] `.batchSet('id', [{id:10, callee_id:42}])` compiles correctly
- [ ] Mixed scalar + array parameters work
- [ ] RETURNING works with batch update
- [ ] Tests: SC-05, SC-06, SC-07

### Block 4: Batch UPSERT via unnest — ~30 min
**Type:** Enhancement (extends Block 2's unnest compilation)
**Dependencies:** Block 2

**Files:**
- `packages/adapter-pgsql/src/pgsql-adapter.ts` — Extend compileUpsert to use unnest for large batches
- (Reuses `buildUnnestSelect` from Block 2)

**Exit criteria:**
- [ ] 100-row upsert compiles to `INSERT ... SELECT unnest() ON CONFLICT DO UPDATE`
- [ ] EXISTS subquery in source SELECT works
- [ ] Tests: SC-12, SC-13

### Block 5: CTE with unnest builder — ~60 min
**Type:** New feature (new builder + adapter compilation)
**Dependencies:** Block 2 (reuses unnest helpers)

**Files:**
- `packages/types/src/intent/cte-intent.ts` — New file: `CteIntent`, `UnnestCteIntent`
- `packages/core/src/dx/cte-builder.ts` — New file: `withCte().fromUnnest().withIndex().query()`
- `packages/adapter-pgsql/src/pgsql-adapter.ts` — Add `compileCteQuery()` method

**Out of scope:** NQL WITH syntax (grammar extension deferred to separate story)

**Exit criteria:**
- [ ] `withCte('lookups').fromUnnest({...}).withIndex('idx')` compiles correctly
- [ ] CTE referenced in outer query JOIN
- [ ] Recursive CTE with unnest anchor works
- [ ] Tests: SC-14, SC-15, SC-16
- [ ] Dual-path CTE design documented (SC-18)

## 7. Test Strategy

### Test pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 18+ | Compilation output (sql.equals) |
| Integration | 4 | Full pipeline (intent → plan → SQL) |
| E2E | 2 | Real PostgreSQL (batch insert + batch update) |

### Test data requirements
- Fixtures: arrays of 3, 50, 100+ objects for threshold testing
- Type variety: int[], text[], float8[], bool[]
- Edge cases: empty arrays, null values, mixed types

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Type inference wrong for mixed arrays | H | M | Sample first element, fall back to text[] |
| NQL ANY keyword conflicts | L | L | Context-aware lexer (only after `=`) |
| CTE builder API too complex | M | M | Start with simple fromUnnest, iterate |
| Unnest threshold suboptimal | L | M | Make configurable, default 50 |
| Dual-path CTE too specific | M | H | Document as design study, defer impl |

## 9. Definition of Done

- [ ] All 5 blocks implemented
- [ ] Scenarios SC-01 through SC-16, SC-18, SC-19 have passing tests (17 scenarios)
- [ ] SC-17 (NQL WITH syntax) deferred to separate story
- [ ] All tests pass (unit + integration + E2E)
- [ ] Lint/typecheck pass
- [ ] NQL grammar updated for ANY keyword
- [ ] Documentation updated
- [ ] /review clean (no blocking findings)
- [ ] Dual-path CTE design documented (SC-18)
