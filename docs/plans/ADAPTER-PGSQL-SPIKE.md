---
doc-meta:
  status: complete
  scope: adapter-pgsql
  type: specification
  created: 2026-01-28
  updated: 2026-01-29
  completed: 2026-01-29
  complexity: COMPLEX
  time-budget: 12h (spike only)
  reviewed-by: Multi-LLM consensus (LM Studio, Codex, Gemini)
---

# Specification: adapter-pgsql Spike — Forward Path (Plan → PG AST → SQL)

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | adapter-pgsql (new package) |
| Complexity | COMPLEX |
| Time budget | 12h (spike: forward path only) |
| Blocks | 5 |
| BDD scenarios | 14 |
| Risk level | MEDIUM |
| Key dependency | `@pgsql/deparser` (npm) |
| Comparison baseline | `@dbsp/adapter-kysely` (golden reference) |

## 1. Problem Statement

The current `adapter-kysely` couples the project to Kysely's builder API for both SQL generation and execution. This creates two limitations:

1. **Introspection is limited** — Kysely's introspection capabilities are minimal (no PK, no index, no constraint discovery). PostgreSQL's `pg_catalog` / `information_schema` offer full metadata access, but requires bypassing Kysely entirely.
2. **Builder API duplication** — Our Plan is already a tree; converting it through Kysely's imperative builder API means constructing SQL piece-by-piece rather than doing a direct tree-to-tree transformation.

The spike validates the **forward path**: Plan → PostgreSQL AST → SQL, using `@pgsql/deparser` to serialize the AST. If successful, this proves the architecture for a full native adapter that replaces Kysely over time.

## 2. User Stories

### US-01: Forward compilation without ORM

```
AS A contributor to db-semantic-planner
I WANT to compile a PlanReport into SQL via a native PostgreSQL AST
SO THAT the forward path is proven independent of Kysely
ACCEPTANCE: Same SQL output (semantically equivalent) as adapter-kysely for all covered query shapes
```

### US-02: Parameterized queries via AST

```
AS A contributor to db-semantic-planner
I WANT parameterized queries ($1, $2) produced by the native AST compiler
SO THAT the adapter is safe from SQL injection by construction
ACCEPTANCE: ParamRef nodes produce $N placeholders; parameters array matches Kysely output
```

### US-03: Roundtrip validation

```
AS A contributor to db-semantic-planner
I WANT automated comparison between adapter-kysely and adapter-pgsql output
SO THAT I can detect regressions and semantic drift between the two paths
ACCEPTANCE: Test harness compiles same PlanReport through both adapters, asserts SQL equivalence
```

## 3. Business Rules

### 3.1 Invariants (always true)

- **INV-01**: The PG AST is the ONLY intermediate representation. No string concatenation or SQL template literals.
- **INV-02**: Every user-provided value MUST be a `ParamRef` node in the AST. No literal interpolation.
- **INV-03**: Every identifier (table, column, schema) MUST use the AST's identifier node, which produces double-quoted identifiers via the deparser.
- **INV-04**: The adapter MUST implement the `CompilingAdapter` interface from `@dbsp/core`.
- **INV-05**: The adapter package MUST NOT depend on Kysely.

### 3.2 Preconditions (required before spike dev starts)

- **PRE-01**: `@pgsql/deparser` supports `ParamRef` nodes (produces `$N` placeholders). **BLOCKING — validated in Block 1.**
- **PRE-02**: `@pgsql/deparser` supports all SQL clause types needed: SELECT, FROM, WHERE, JOIN, ORDER BY, LIMIT, OFFSET, GROUP BY, HAVING, CTEs, subqueries, DISTINCT.

### 3.3 Effects (what the spike produces)

- **EFF-01**: New package `packages/adapter-pgsql/` with forward compilation only.
- **EFF-02**: A `compilePgAst(plan: PlanReport, model: ModelIR): PgSelectStmt` function that transforms a PlanReport into a PostgreSQL AST node.
- **EFF-03**: A `deparseToSql(ast: PgSelectStmt): CompiledQuery` function that serializes the AST via `@pgsql/deparser` and collects parameters.
- **EFF-04**: Roundtrip test suite comparing output against adapter-kysely.

### 3.4 Error Handling

- **ERR-01**: If a Plan contains a decision type not yet supported → throw `UnsupportedPlanDecisionError` with decision type and context.
- **ERR-02**: If the AST deparser produces unexpected output → test failure (caught by roundtrip tests, not runtime).
- **ERR-03**: If ParamRef is not supported → **SPIKE ABORT** (documented in Block 1 exit criteria).

## 4. Technical Design

### 4.1 Architecture Decision

**Tree-to-tree transformation**, not a builder API.

```
PlanReport (semantic tree)
    │
    ▼  compilePgAst()
PostgreSQL AST (libpg_query format)
    │
    ▼  @pgsql/deparser
SQL string + parameters array
```

**Why tree-to-tree:**
- Plan is already a tree. PostgreSQL AST is a tree. Direct mapping avoids imperative builder overhead.
- The AST format is battle-tested (libpg_query powers pganalyze, Supabase, DBeaver).
- The deparser handles all SQL serialization edge cases (quoting, operator precedence, parenthesization).

**Why NOT a builder API (Kysely-style):**
- Duplicates Kysely's builder without benefit. Our Plan already has the structure; converting to imperative calls adds complexity.
- A builder hides the AST, making it harder to inspect, test, and transform.

### 4.2 Package Structure

```
packages/adapter-pgsql/
├── package.json                    # deps: @pgsql/deparser, @pgsql/types (existing AST types)
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts                    # Public exports
│   ├── pg-compiler.ts              # compilePgAst(): PlanReport → PG AST
│   ├── pg-ast-helpers.ts           # Typed helper functions wrapping @pgsql/types
│   ├── pg-deparse.ts               # deparseToSql(): PG AST → CompiledQuery
│   ├── pg-compiling-adapter.ts     # CompilingAdapter implementation
│   ├── pg-naming-plugin.ts         # NamingPlugin interface + CamelCaseNamingPlugin
│   ├── pg-mutation-compiler.ts     # INSERT/UPDATE/DELETE/UPSERT → PG AST (Phase 2)
│   ├── pg-ddl-compiler.ts          # DDL generation → PG AST (Phase 2)
│   └── __tests__/
│       ├── param-ref.test.ts       # Block 1: ParamRef validation
│       ├── ast-snapshot.test.ts    # Block 2: AST structure snapshots
│       ├── golden-sql.test.ts      # Block 3: SQL golden tests
│       └── roundtrip.test.ts       # Block 4: Roundtrip comparison vs Kysely
└── vitest.config.ts
```

**Key dependency decisions:**
- **`@pgsql/types`** — Use existing AST type definitions (DO NOT reinvent)
- **`@pgsql/deparser`** — Use existing serializer (version-locked)
- **`@pgsql/parser`** — For roundtrip AST comparison tests

### 4.3 AST Helper Design (Security Layer)

Rather than constructing raw AST objects (error-prone, verbose), we provide typed helper functions:

```typescript
// pg-ast-helpers.ts — typed constructors for PG AST nodes

/** Column reference: "table"."column" */
export function columnRef(table: string, column: string): PgColumnRef;

/** All columns: "table".* */
export function columnRefStar(table: string): PgColumnRef;

/** String value (creates ParamRef + tracks parameter) */
export function paramRef(ctx: CompilerContext): PgParamRef;

/** Table with alias: "schema"."table" AS "alias" */
export function rangeVar(schema: string | undefined, table: string, alias?: string): PgRangeVar;

/** SQL function call: fn(args...) */
export function funcCall(name: string, args: PgNode[]): PgFuncCall;

/** Binary operator: left op right */
export function aExpr(left: PgNode, op: string, right: PgNode): PgAExpr;

/** Boolean AND/OR */
export function boolExpr(type: 'AND' | 'OR' | 'NOT', args: PgNode[]): PgBoolExpr;

/** Subquery in various positions */
export function subLink(type: 'EXISTS' | 'ANY' | 'ALL' | 'EXPR', subquery: PgSelectStmt): PgSubLink;

/** JOIN clause */
export function joinExpr(
  left: PgNode, right: PgNode, type: 'JOIN_INNER' | 'JOIN_LEFT' | 'JOIN_RIGHT',
  quals: PgNode
): PgJoinExpr;

/** CTE (WITH clause) */
export function commonTableExpr(name: string, query: PgSelectStmt): PgCommonTableExpr;
```

**Security benefit**: These helpers enforce that values always go through `paramRef()`, making SQL injection structurally impossible. There is no `rawSql()` helper — by design.

### 4.4 Compiler Context

```typescript
interface CompilerContext {
  /** Parameter collector: each paramRef() call appends a value and returns $N */
  readonly params: unknown[];
  /** Alias counter for deterministic aliasing */
  aliasCounter: number;
  /** Model reference for schema lookups */
  readonly model: ModelIR;
  /** Optional PostgreSQL schema name */
  readonly schemaName?: string;
  /** Naming convention for identifier transformation */
  readonly namingConvention: NamingConvention;
}
```

### 4.5 Naming Plugin Architecture (Inspired by Kysely)

Kysely uses `CamelCasePlugin` to transform identifiers during query building. We replicate this pattern at the AST level:

```typescript
// pg-naming-plugin.ts — Plugin interface inspired by Kysely

/** Plugin that transforms identifiers during AST construction */
export interface NamingPlugin {
  /** Transform a model identifier to database identifier */
  toDatabase(identifier: string): string;
  /** Transform a database identifier to model identifier (for introspection) */
  toModel(identifier: string): string;
}

/** Reuses the same transformation logic as Kysely's CamelCasePlugin */
export class CamelCaseNamingPlugin implements NamingPlugin {
  toDatabase(identifier: string): string {
    // Same regex as Kysely: camelCase → snake_case
    return identifier.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  toModel(identifier: string): string {
    // snake_case → camelCase
    return identifier.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }
}

/** No transformation */
export class PreserveNamingPlugin implements NamingPlugin {
  toDatabase(identifier: string): string { return identifier; }
  toModel(identifier: string): string { return identifier; }
}
```

**Usage in AST helpers:**
```typescript
// columnRef applies naming transformation
export function columnRef(ctx: CompilerContext, table: string, column: string): PgColumnRef {
  const dbColumn = ctx.namingPlugin.toDatabase(column);
  return { ColumnRef: { fields: [{ String: { sval: table } }, { String: { sval: dbColumn } }] } };
}
```

**Why plugin architecture:**
- Same pattern as Kysely — familiar to users
- Centralized transformation logic — single point of change
- Testable — can unit test plugin in isolation
- Future: could extract to `@dbsp/core` for shared use across adapters

### 4.6 Query Shapes Covered in Spike

The spike covers the **core SELECT compilation path**. These map to the most common PlanReport structures:

| Shape | PlanReport features used | Priority |
|-------|--------------------------|----------|
| Simple SELECT * | rootTable, select.type='all' | P0 |
| SELECT fields | select.type='fields' | P0 |
| WHERE (comparison, null, in, like) | where clause variants | P0 |
| ORDER BY + LIMIT + OFFSET | orderBy, limit, offset | P0 |
| JOIN (LEFT/INNER) | decisions with join-type | P0 |
| GROUP BY + HAVING | groupBy, having | P1 |
| DISTINCT | distinct: true | P1 |
| Aggregates (COUNT, SUM, AVG, MIN, MAX) | select.type='aggregate' | P1 |
| CTE (WITH clause) | ctes array | P1 |
| Subquery include (json_agg) | include with json_agg strategy | P2 |
| EXISTS subquery filter | where.kind='exists' | P2 |
| WITH RECURSIVE | ctes with recursive=true | P2 |
| Window functions | expressions with window | P3 (out of spike) |
| LATERAL JOIN | lateral include strategy | P3 (out of spike) |

### 4.7 Mutation Shapes (Phase 2 — NOT in spike but architecture must support)

| Shape | Intent type | Priority |
|-------|-------------|----------|
| INSERT single row | InsertIntent | P0 |
| INSERT multiple rows | InsertIntent (batch) | P0 |
| INSERT ... RETURNING | InsertIntent + returning | P1 |
| INSERT ... ON CONFLICT | UpsertIntent | P1 |
| UPDATE with WHERE | UpdateIntent | P0 |
| UPDATE ... RETURNING | UpdateIntent + returning | P1 |
| DELETE with WHERE | DeleteIntent | P0 |
| DELETE ... RETURNING | DeleteIntent + returning | P1 |

### 4.8 DDL Shapes (Phase 2 — NOT in spike but architecture must support)

| Shape | DDL type | Priority |
|-------|----------|----------|
| CREATE TABLE | TableIR → CreateStmt | P0 |
| CREATE INDEX | IndexIR → IndexStmt | P0 |
| ALTER TABLE ADD CONSTRAINT | ForeignKeyIR → AlterTableStmt | P1 |
| DROP TABLE | — | P2 |
| ALTER TABLE ADD/DROP COLUMN | — | P2 |

**Note:** DDL uses same AST format (`@pgsql/types`) — `CreateStmt`, `IndexStmt`, `AlterTableStmt` nodes.

### 4.9 API Contract

**Public API (spike):**

```typescript
import { createPgsqlCompilingAdapter } from '@dbsp/adapter-pgsql';

const compiler = createPgsqlCompilingAdapter({
  namingConvention: 'camelCase', // matches CamelCasePlugin behavior
  schemaName: 'public',         // optional PostgreSQL schema
});

// CompilingAdapter.compile()
const compiled = compiler.compile(planReport);
// → { sql: 'SELECT ...', parameters: [...] }
```

**NOT in spike scope:**
- `ExecutingAdapter` (no pg driver execution)
- `StreamingAdapter` (no streaming)
- `IntrospectingAdapter` (backward path — future phase)
- `TransactionalAdapter` (no transaction management)
- `DDLGeneratingAdapter` (no DDL)
- `RawSqlAdapter` (no raw SQL passthrough)

## 5. Acceptance Criteria (BDD)

### Scenario Group A: ParamRef Validation (BLOCKING)

```gherkin
@priority:critical @type:validation @block:1
Scenario: SC-01 — ParamRef produces $N placeholders
  Given a PG AST with ParamRef nodes at positions 1, 2, 3
  When deparsed via @pgsql/deparser
  Then the SQL contains $1, $2, $3 at the correct positions
  And the parameters array has 3 entries in order

@priority:critical @type:edge @block:1
Scenario: SC-02 — Empty query has no parameters
  Given a PG AST with SELECT * FROM "table" (no ParamRef)
  When deparsed via @pgsql/deparser
  Then the SQL contains no $N placeholders
  And the parameters array is empty
```

### Scenario Group B: AST Construction

```gherkin
@priority:high @type:nominal @block:2
Scenario: SC-03 — Simple SELECT produces correct AST structure
  Given a PlanReport with rootTable='users', select.type='all'
  When compiled to PG AST via compilePgAst()
  Then the AST has a SelectStmt with targetList=[ColumnRef{fields:['*']}]
  And fromClause contains RangeVar{relname:'users'}

@priority:high @type:nominal @block:2
Scenario: SC-04 — WHERE comparison produces AExpr node
  Given a PlanReport with where={kind:'comparison', field:'status', operator:'eq', value:'active'}
  When compiled to PG AST
  Then whereClause contains A_Expr{kind:'AEXPR_OP', name:['='], lexpr:ColumnRef, rexpr:ParamRef}
  And parameters contains ['active']

@priority:high @type:nominal @block:2
Scenario: SC-05 — JOIN produces JoinExpr node
  Given a PlanReport with a join-type decision (LEFT JOIN users→posts)
  When compiled to PG AST
  Then fromClause contains JoinExpr{jointype:'JOIN_LEFT', larg:RangeVar, rarg:RangeVar, quals:A_Expr}
```

### Scenario Group C: SQL Golden Tests

```gherkin
@priority:high @type:nominal @block:3
Scenario: SC-06 — Simple SELECT * FROM table
  Given PlanReport: {rootTable:'users', intent:{type:'select', from:'users'}}
  When compiled and deparsed
  Then SQL equals: SELECT * FROM "public"."users" AS "_users"

@priority:high @type:nominal @block:3
Scenario: SC-07 — SELECT with WHERE and ORDER BY
  Given PlanReport for: users WHERE status='active' ORDER BY name ASC LIMIT 10
  When compiled and deparsed
  Then SQL equals: SELECT * FROM "public"."users" AS "_users" WHERE "_users"."status" = $1 ORDER BY "_users"."name" ASC LIMIT $2
  And parameters = ['active', 10]

@priority:high @type:nominal @block:3
Scenario: SC-08 — SELECT with LEFT JOIN
  Given PlanReport for: posts with author (LEFT JOIN)
  When compiled and deparsed
  Then SQL contains LEFT JOIN "public"."users" AS "_author" ON "_author"."id" = "_posts"."author_id"

@priority:high @type:nominal @block:3
Scenario: SC-09 — SELECT with GROUP BY and aggregate
  Given PlanReport for: posts GROUP BY status, COUNT(*)
  When compiled and deparsed
  Then SQL contains GROUP BY "_posts"."status"
  And SQL contains count(*) as "count"

@priority:high @type:edge @block:3
Scenario: SC-10 — CTE (WITH clause)
  Given PlanReport with a CTE definition
  When compiled and deparsed
  Then SQL starts with WITH "cte_name" AS (...)
```

### Scenario Group D: Roundtrip Comparison

```gherkin
@priority:high @type:validation @block:4
Scenario: SC-11 — Roundtrip: simple SELECT matches Kysely
  Given a PlanReport compiled by both adapter-kysely and adapter-pgsql
  When comparing SQL output (normalized whitespace, alias mapping)
  Then both produce semantically equivalent SQL

@priority:high @type:validation @block:4
Scenario: SC-12 — Roundtrip: filtered query matches Kysely
  Given a filtered PlanReport compiled by both adapters
  When comparing SQL and parameters
  Then both produce same WHERE clause structure and same parameter values

@priority:high @type:validation @block:4
Scenario: SC-13 — Roundtrip: JOIN query matches Kysely
  Given a JOIN PlanReport compiled by both adapters
  When comparing SQL output
  Then both produce equivalent JOIN clauses (alias names may differ)

@priority:high @type:error @block:4
Scenario: SC-14 — Unsupported decision type throws
  Given a PlanReport with a decision type not yet implemented (e.g. window function)
  When compiled via adapter-pgsql
  Then UnsupportedPlanDecisionError is thrown with the decision type
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security | Validation |
|----------|---------|------|-------|----------|------------|
| SC-01 | | | | ✓ | ✓ |
| SC-02 | | ✓ | | | ✓ |
| SC-03 | ✓ | | | | |
| SC-04 | ✓ | | | | |
| SC-05 | ✓ | | | | |
| SC-06 | ✓ | | | | |
| SC-07 | ✓ | | | | |
| SC-08 | ✓ | | | | |
| SC-09 | ✓ | | | | |
| SC-10 | | ✓ | | | |
| SC-11 | | | | | ✓ |
| SC-12 | | | | | ✓ |
| SC-13 | | | | | ✓ |
| SC-14 | | | ✓ | | |

## 6. Implementation Plan

### Block 1: ParamRef Validation (BLOCKING GATE) — EXTENDED

**Type:** Validation / Proof-of-concept
**Dependencies:** None
**Files:**
- `packages/adapter-pgsql/package.json` — Create package with `@pgsql/deparser` dependency (version-locked)
- `packages/adapter-pgsql/tsconfig.json` — TypeScript config
- `packages/adapter-pgsql/vitest.config.ts` — Vitest config
- `packages/adapter-pgsql/src/__tests__/param-ref.test.ts` — Extended ParamRef validation tests

**Work:**
1. Scaffold `packages/adapter-pgsql/` package
2. Install dependencies with exact version lock:
   - `@pgsql/deparser` — AST → SQL serializer
   - `@pgsql/types` — AST type definitions (DO NOT recreate types)
   - `@pgsql/parser` — SQL → AST for roundtrip tests
3. Write validation tests for ParamRef in multiple contexts:
   - Basic WHERE clause: `WHERE col = $1`
   - LIMIT/OFFSET: `LIMIT $1 OFFSET $2`
   - IN clause with array: `WHERE col = ANY($1)`
   - TypeCast with param: `$1::integer`, `$1::text[]`
   - JSON/JSONB operators with params
4. Verify deterministic parameter ordering (stable traversal)
5. Document AST schema version compatibility

**Exit criteria:**
- [ ] `@pgsql/deparser` installed and importable (exact version pinned)
- [ ] ParamRef produces `$N` placeholders in WHERE (SC-01 passes)
- [ ] ParamRef works in LIMIT/OFFSET context
- [ ] ParamRef works with TypeCast nodes (arrays, JSON, dates)
- [ ] Empty query has no parameters (SC-02 passes)
- [ ] Schema contract test: AST nodes match deparser expectations
- [ ] **If ParamRef NOT supported in any critical context → STOP. Document finding. Evaluate alternatives.**

### Block 2: AST Helpers + Core Compiler + NamingPlugin

**Type:** Feature slice
**Dependencies:** Block 1 (ParamRef confirmed)
**Files:**
- `packages/adapter-pgsql/src/pg-ast-helpers.ts` — Typed AST node constructors (wrapping `@pgsql/types`)
- `packages/adapter-pgsql/src/pg-naming-plugin.ts` — NamingPlugin interface + CamelCase/Preserve implementations
- `packages/adapter-pgsql/src/pg-compiler.ts` — `compilePgAst()` implementation
- `packages/adapter-pgsql/src/__tests__/ast-snapshot.test.ts` — AST structure tests

**Work:**
1. **Import AST types from `@pgsql/types`** — DO NOT recreate type definitions
2. Implement NamingPlugin architecture (see section 4.5):
   - `NamingPlugin` interface with `toDatabase()` / `toModel()`
   - `CamelCaseNamingPlugin` — same logic as Kysely's plugin
   - `PreserveNamingPlugin` — passthrough
3. Implement AST helper functions that apply NamingPlugin:
   - `columnRef(ctx, table, column)` — applies `ctx.namingPlugin.toDatabase(column)`
   - `paramRef`, `rangeVar`, `aExpr`, `boolExpr`, `funcCall`, `joinExpr`, `subLink`, `commonTableExpr`
4. Implement `compilePgAst()` — the core tree-to-tree transformer:
   - Handle `rootTable` → `RangeVar` in `fromClause`
   - Handle `select` → `targetList` (all, fields, aggregate, expressions)
   - Handle `where` → `whereClause` (comparison, null, in, like, range, and, or, not, exists)
   - Handle `orderBy` → `sortClause`
   - Handle `limit`/`offset` → `limitCount`/`limitOffset`
   - Handle JOIN decisions → `JoinExpr` in `fromClause`
   - Handle `groupBy` → `groupClause`
   - Handle `having` → `havingClause`
   - Handle `distinct` → `distinctClause`
   - Handle CTEs → `withClause`
4. Write AST snapshot tests for each query shape

**Exit criteria:**
- [ ] All AST helpers produce valid PG AST nodes (using `@pgsql/types`)
- [ ] NamingPlugin transforms identifiers correctly (camelCase ↔ snake_case)
- [ ] `compilePgAst()` handles P0 and P1 query shapes
- [ ] SC-03, SC-04, SC-05 pass

### Block 3: Deparse + Golden SQL Tests

**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `packages/adapter-pgsql/src/pg-deparse.ts` — `deparseToSql()` implementation
- `packages/adapter-pgsql/src/__tests__/golden-sql.test.ts` — SQL golden tests

**Work:**
1. Implement `deparseToSql()`:
   - Accept PG AST + CompilerContext
   - Call `@pgsql/deparser` to serialize
   - Return `CompiledQuery { sql, parameters }`
2. Write golden SQL tests that compile PlanReport end-to-end and assert exact SQL output
3. Handle naming convention (camelCase → snake_case identifier transformation)
4. Handle schema prefix (`"public"."table"` via RangeVar.schemaname)

**Exit criteria:**
- [ ] `deparseToSql()` produces valid SQL from PG AST
- [ ] SC-06, SC-07, SC-08, SC-09, SC-10 pass
- [ ] Parameters are correctly ordered and collected

### Block 4: Roundtrip Comparison + CompilingAdapter — AST-BASED

**Type:** Validation + Integration
**Dependencies:** Block 3
**Files:**
- `packages/adapter-pgsql/src/pg-compiling-adapter.ts` — CompilingAdapter implementation
- `packages/adapter-pgsql/src/index.ts` — Public exports
- `packages/adapter-pgsql/src/__tests__/roundtrip.test.ts` — Roundtrip comparison tests (AST-based)

**Work:**
1. Implement `PgsqlCompilingAdapter` class implementing `CompilingAdapter`:
   - `compile()` — delegates to `compilePgAst()` + `deparseToSql()`
   - `compileWithIncludes()` — handles include strategy detection
   - Other compile methods — throw `UnsupportedPlanDecisionError` for now
   - `createDump()` — standard dump creation
2. Create roundtrip test harness (AST-based comparison, NOT string comparison):
   - Import both `createKyselyAdapter` and `createPgsqlCompilingAdapter`
   - For each test case, compile same PlanReport through both adapters
   - **Parse BOTH SQL outputs back to AST** using `@pgsql/parser` (libpg_query)
   - Compare AST structures (ignores whitespace, quoting differences)
   - Assert parameter arrays match (order + values)
   - Optionally: run `EXPLAIN` on both against test DB, compare plans
3. Export public API from `index.ts`
4. Define strict identifier policy (whitelist per table/column in helpers)

**Exit criteria:**
- [ ] `PgsqlCompilingAdapter` satisfies `CompilingAdapter` interface (type-checks)
- [ ] SC-11, SC-12, SC-13 pass (AST-based roundtrip comparison)
- [ ] SC-14 passes (unsupported decision error)
- [ ] Identifier whitelisting enforced in AST helpers
- [ ] `createPgsqlCompilingAdapter()` factory works

### Block 5: Integration + Documentation

**Type:** Polish + docs
**Dependencies:** Block 4
**Files:**
- `packages/adapter-pgsql/tsup.config.ts` — Build config
- `packages/adapter-pgsql/README.md` — Package README (spike status)
- `TODO.md` — Update ADAPTER-PGSQL-001 status
- `docs/DOCUMENTATION_INDEX.md` — Add reference

**Work:**
1. Add `tsup.config.ts` for ESM build
2. Verify package builds: `pnpm --filter @dbsp/adapter-pgsql build`
3. Add to workspace: update root `pnpm-workspace.yaml`
4. Run full test suite: `pnpm test`
5. Update TODO.md: mark spike phase as complete
6. Update DOCUMENTATION_INDEX.md: add adapter-pgsql reference

**Exit criteria:**
- [ ] Package builds successfully
- [ ] All unit tests pass (existing + new)
- [ ] E2E tests still pass (no regressions)
- [ ] TODO.md updated

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit (AST snapshot) | ~15 | AST node structure for each query shape |
| Unit (golden SQL) | ~10 | Exact SQL output validation |
| Integration (roundtrip) | ~8 | Comparison against adapter-kysely |
| E2E | 0 | Not in spike (no execution) |

### Test data requirements:

- **Fixtures:** PlanReport objects for each query shape. Can reuse/adapt existing unit test plans from adapter-kysely tests.
- **ModelIR fixtures:** Blog schema (users, posts, comments), PIM schema (products, variants, categories) — already exist in test suites.
- **Mocks:** None — pure compilation, no I/O.
- **Comparison baseline:** adapter-kysely's `compile()` output for same PlanReport inputs.

### 3-level test strategy (from /adversarial + Multi-LLM Review):

1. **AST snapshots** — verify tree structure (Block 2)
2. **SQL golden tests** — verify serialized output (Block 3)
3. **Roundtrip comparison (AST-based)** — parse both outputs to AST, compare structures (Block 4)

### Additional validation (from Multi-LLM consensus):

4. **Extended ParamRef contexts** — LIMIT/OFFSET, arrays, TypeCast nodes (Block 1)
5. **Schema contract test** — AST nodes match deparser expectations (Block 1)
6. **Identifier whitelisting** — strict policy per table/column (Block 4)

## 8. Risks & Mitigations (Updated from Multi-LLM Review)

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| `@pgsql/deparser` doesn't support ParamRef | HIGH | LOW | Block 1 validates this FIRST. Abort path: manual $N injection as post-processing. |
| ParamRef fails in LIMIT/OFFSET/array contexts | HIGH | MEDIUM | Extended Block 1 validation covers these contexts explicitly. |
| Type casting required for params (arrays, JSON, dates) | MEDIUM | HIGH | Build typed param subsystem; inject TypeCast nodes where needed. |
| PG AST format is poorly documented | MEDIUM | MEDIUM | Use `@pgsql/types` for TypeScript types. Reference libpg_query test suite for AST examples. |
| AST format changes between deparser versions | LOW | LOW | Pin exact version. Add schema contract test to detect breaking changes. |
| Naming convention mismatch (camelCase ↔ snake_case) | MEDIUM | MEDIUM | Apply same transformation as CamelCasePlugin during AST construction. Test with roundtrip comparison. |
| Complex query shapes differ from Kysely output | LOW | HIGH | Use AST-based comparison (parse both outputs), not string equality. |
| Deterministic parameter ordering | MEDIUM | MEDIUM | Define stable traversal order. Enforce in tests. |
| Name collision (CTE, aliases, columns) | MEDIUM | LOW | Systematic naming strategy (already in adapter-kysely, reuse patterns). |
| Reserved keywords as identifiers | MEDIUM | MEDIUM | columnRef() must auto-quote reserved words (`user`, `select`, etc.). |
| User-supplied identifiers (orderBy, select) | MEDIUM | LOW | Strict whitelist per table/column. Quoting alone doesn't prevent catalog injection. |
| Error UX degradation | LOW | MEDIUM | Maintain PlanReport node → AST node source mapping for actionable errors. |
| Maintenance burden (code size growth) | LOW | MEDIUM | Monitor LOC; spike validates effort before full commitment. |
| Package size / dependency bloat from deparser | LOW | LOW | `@pgsql/deparser` is ~50KB, pure TS, no native deps. |

## 9. Scope Boundaries

### Phase 1: Spike — SELECT Forward Path (THIS SPEC)
**IN scope:**
- `CompilingAdapter.compile()` — SELECT queries only
- SELECT shapes: simple, filtered, joined, grouped, CTEs, EXISTS, json_agg
- ParamRef-based parameterization (all contexts validated)
- NamingPlugin architecture (CamelCase, Preserve)
- AST-based roundtrip comparison test harness
- `createDump()` for observability

**OUT of scope (spike):**
- INSERT / UPDATE / DELETE / UPSERT compilation (Phase 2)
- DDL generation (Phase 2)
- Window functions, LATERAL JOIN (Phase 2)
- Execution, streaming, transactions (Phase 3)
- Introspection (Phase 3)

### Phase 2: Full Forward (after spike validated)
**Mutations:**
- [ ] `compileInsert()` — INSERT single/batch + RETURNING
- [ ] `compileUpdate()` — UPDATE + WHERE + RETURNING
- [ ] `compileDelete()` — DELETE + WHERE + RETURNING
- [ ] `compileUpsert()` — INSERT ON CONFLICT

**DDL:**
- [ ] `generateDDL()` — CREATE TABLE, CREATE INDEX, ALTER TABLE
- [ ] Implements `DDLGeneratingAdapter` interface

**Advanced SELECT:**
- [ ] Window functions (OVER, PARTITION BY)
- [ ] LATERAL JOIN

### Phase 3: Backward + Execution
**Introspection:**
- [ ] `introspect()` — pg_catalog → ModelIR
- [ ] Full PK, FK, indexes, constraints discovery
- [ ] Implements `IntrospectingAdapter` interface

**Execution:**
- [ ] `pg` driver integration
- [ ] `execute()`, `stream()`, `transaction()`
- [ ] Implements `ExecutingAdapter`, `StreamingAdapter`, `TransactionalAdapter`

### Phase 4: Sunset adapter-kysely
- [ ] Migrate all tests to adapter-pgsql
- [ ] Deprecation notices
- [ ] Remove adapter-kysely dependency for PostgreSQL

## 10. Definition of Done

- [ ] Block 1: ParamRef validated in ALL contexts (WHERE, LIMIT, OFFSET, arrays, TypeCast)
- [ ] Block 1: Schema contract test passing (AST nodes match deparser expectations)
- [ ] Block 2: AST helpers + core compiler with snapshot tests
- [ ] Block 3: Deparse integration with golden SQL tests
- [ ] Block 4: CompilingAdapter + AST-based roundtrip comparison passing
- [ ] Block 4: Identifier whitelisting enforced
- [ ] Block 5: Package builds, full test suite passes, docs updated
- [ ] All BDD scenarios (14) have passing tests
- [ ] All existing tests pass (2164 unit + 291 E2E = 0 regressions)
- [ ] TypeScript strict mode — no `any` except AST node generics
- [ ] No Kysely dependency in adapter-pgsql package.json
- [ ] Deterministic parameter ordering verified

---

## Appendix A: Multi-LLM Review Summary (2026-01-29)

**Reviewers:** LM Studio, OpenAI Codex (gpt-5.2-codex), Google Gemini

### Consensus Points (HIGH CONFIDENCE)

| Finding | Action Taken |
|---------|--------------|
| String comparison insufficient for roundtrip | ✅ Block 4 updated: AST-based comparison |
| ParamRef validation must cover LIMIT/OFFSET/arrays/casts | ✅ Block 1 extended |
| Deterministic parameter ordering non-negotiable | ✅ Added to Definition of Done |
| Type casting needed for arrays, JSON, dates | ✅ Added to risks, TypeCast validation in Block 1 |
| Identifier whitelisting required | ✅ Block 4 updated |

### Divergent Opinions

| Topic | LM Studio | Codex | Gemini | Resolution |
|-------|-----------|-------|--------|------------|
| Architecture viability | "Too risky" | "Sound overall" | "Feasible" | Proceed with spike (2/3 positive) |
| @pgsql/deparser choice | "Create own" | "Best-in-class" | "Verify package" | Keep, but version-lock + schema contract test |
| Keep Kysely internally | No | No | Yes | No — spike validates independence |

### New Risks Added

- Type inference for params (arrays, JSON, dates, enums)
- Name collision (CTE, aliases)
- Reserved keywords as identifiers
- Error UX / source mapping
- Maintenance burden (monitor LOC)

**Agreement level:** MEDIUM — Architecture validated, implementation details refined.
