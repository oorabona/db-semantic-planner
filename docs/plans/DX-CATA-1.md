# DX-CATA-1: `.exists()` Query Shortcut + NQL Multi-Row INSERT

## Objective

Add two DX features to the ORM and NQL:
1. `.exists()` — boolean existence check on QueryBuilder
2. NQL multi-row INSERT — dual syntax for batch inserts

## Feature A: `.exists()` Query Shortcut

### API

```typescript
// Basic existence check
const hasActive = await orm.select('users').where(eq('active', true)).exists();
// → true | false

// Schema-scoped
const exists = await orm.withSchema('tenant_42').select('users').exists();

// Dump for inspection
const dump = orm.select('users').where(eq('active', true)).existsDump();
// → { sql: 'SELECT EXISTS(SELECT 1 FROM "users" AS "t0" WHERE ...)', params: [...], plan }
```

### Intent Changes

Add optional `existsWrap` flag to `QueryIntent`:

```typescript
// In packages/types/src/intent-ast.ts
export interface QueryIntent {
  // ... existing fields ...
  readonly existsWrap?: boolean; // When true, adapter wraps in SELECT EXISTS(...)
}
```

### Adapter Compilation

When `existsWrap === true`, the adapter:
1. Compiles the inner SELECT normally (with limit 1 optimization)
2. Strips the SELECT list → replaces with `SELECT 1`
3. Wraps in `SELECT EXISTS(...)`
4. Result type: `{ exists: boolean }`

**SQL output:**
```sql
SELECT EXISTS(SELECT 1 FROM "users" AS "t0" WHERE "t0"."active" = $1)
```

### QueryBuilder Implementation

In `packages/core/src/dx/typed-query-builder.ts` **and** `packages/core/src/dx/orm.ts` (`QueryBuilderImpl`):

Both query builder implementations must expose `.exists()` and `.existsDump()`.

```typescript
async exists(): Promise<boolean> {
  const adapter = this.requireAdapter();
  const baseIntent = this.buildIntent();
  // Clone intent (readonly) — strip unnecessary fields for existence check
  const intent: QueryIntent = {
    ...baseIntent,
    existsWrap: true,
    limit: 1,
    include: undefined,   // Includes not needed
    orderBy: undefined,   // ORDER BY irrelevant for EXISTS
    // Preserve: groupBy, having, offset (they affect result set)
  };
  const planReport = this.planWith(intent);
  const compiled = adapter.compile(planReport, { model: this.model, schemaName: this.schemaName });
  const rows = await adapter.execute(compiled);
  return rows.length > 0 && (rows[0] as any).exists === true;
}

existsDump(): Dump {
  // Same as exists() but returns Dump instead of executing
}
```

**Notes:**
- Intent is readonly — always spread-clone before mutating
- `orderBy` stripped (irrelevant for EXISTS, avoids sorting cost)
- `groupBy`/`having`/`offset` preserved (they change the result set)
- Compile options (`model`, `schemaName`) must be passed for correct schema resolution

### Acceptance Criteria

| ID | Scenario | Expected |
|----|----------|----------|
| A1 | `select('users').exists()` on non-empty table | `true` |
| A2 | `select('users').where(eq('id', 999)).exists()` no match | `false` |
| A3 | `select('users').exists()` on empty table | `false` |
| A4 | `withSchema('s').select('users').exists()` | schema-scoped SQL |
| A5 | `.existsDump()` | returns Dump with EXISTS SQL |
| A6 | `.exists()` with `.include('posts')` | includes ignored |
| A7 | `.exists()` with `.groupBy('role').having(...)` | groupBy/having preserved in inner query |
| A8 | `.exists()` with `.orderBy('name')` | orderBy stripped (irrelevant) |
| A9 | `.exists()` with `.offset(5)` | offset preserved |

---

## Feature B: NQL Multi-Row INSERT

### Syntax

**Syntax 1 — SQL-style (`values`):**
```
insert into users values (name = 'Alice', email = 'a@b'), (name = 'Bob', email = 'b@b')
```

**Syntax 2 — NQL-style (pipe `| set`):**
```
insert into users set name = 'Alice', email = 'a@b' | set name = 'Bob', email = 'b@b'
```

Both produce the same `InsertIntent`:
```typescript
{
  type: 'insert',
  table: 'users',
  values: [
    { name: 'Alice', email: 'a@b' },
    { name: 'Bob', email: 'b@b' },
  ]
}
```

### Grammar Changes

In `packages/nql/src/parser/grammar.ts`:

**New soft keyword:** `Values` in `tokens.ts` (case-insensitive, does NOT reserve `values` as identifier)

**Modified `insertStmt` rule:**
```
insertStmt = "insert" "into" identSegment (
    "set" assignmentList { GATE("|" "set") "|" "set" assignmentList }    // NQL-style: set ... | set ...
  | "values" valuesTuple { "," valuesTuple }                             // SQL-style: values (...), (...)
)

valuesTuple = "(" assignmentList ")"
```

**GATE required:** The `| set` continuation needs a GATE (lookahead) to disambiguate from `| select` / `| bind` in the mutation pipeline. The parser only consumes `|` if the next token is `set`.

The original single-row `insert into X set a = 1, b = 2` remains valid (1 row, no pipe).

### AST Changes

In `packages/nql/src/parser/ast.ts`:

```typescript
export interface NqlInsert {
  type: 'insert';
  table: string;
  rows: NqlAssignment[][]; // Changed: array of rows (was: assignments: NqlAssignment[])
}
```

### Visitor Changes

`insertStmt()` in `visitor.ts`:
- Collects all assignment lists (from `set ... | set ...` or `values (...), (...)`)
- Returns `NqlInsert` with `rows: NqlAssignment[][]`

### Compiler Changes

`compileInsert()` in `compiler/index.ts`:
- Iterates all rows
- Collects union of all column names across ALL rows (not just first row)
- **Normalizes**: every row object gets ALL union keys — missing keys set to `undefined`
- For each row, validates columns against model
- Missing columns → `undefined` → adapter compiles as `NULL` (not `DEFAULT`)
- Returns `InsertIntent` with `values: Record[]`

**Note on NULL vs DEFAULT:** Missing columns produce SQL `NULL`, not `DEFAULT`. This is a deliberate simplification. If users need DB defaults, they should omit the column from ALL rows. Mixed-column inserts with NOT NULL + DEFAULT columns will fail at the DB level — this is documented behavior, not a bug.

### SQL Output

```sql
INSERT INTO "users" ("name", "email") VALUES ($1, $2), ($3, $4)
```

Already supported by adapter (`compileInsert` in `pgsql-adapter.ts:856-886`).

### Acceptance Criteria

| ID | Scenario | Expected |
|----|----------|----------|
| B1 | SQL-style: `insert into users values (name = 'A'), (name = 'B')` | 2 rows in InsertIntent.values |
| B2 | NQL-style: `insert into users set name = 'A' \| set name = 'B'` | 2 rows in InsertIntent.values |
| B3 | Mixed columns: row1 has `name`, row2 has `name, email` | union columns, row1.email = undefined |
| B4 | Single row `values (name = 'A')` | equivalent to `set name = 'A'` |
| B5 | Single row `set name = 'A'` (no pipe) | backward compatible |
| B6 | With RETURNING: `values (...), (...) \| select id` | InsertIntent.returning = ['id'] |
| B7 | Empty values `values ()` | parse error |
| B8 | NQL → SQL end-to-end | `INSERT INTO "users" ("name") VALUES ($1), ($2)` |
| B9 | Column validation: invalid column name | compile error |
| B10 | 3+ rows | works |

---

## Implementation Blocks

### Block 1: `.exists()` (vertical slice: types → core → adapter → tests)

**Files:**
- `packages/types/src/intent-ast.ts` — add `existsWrap?: boolean` to QueryIntent
- `packages/core/src/dx/typed-query-builder.ts` — add `.exists()` and `.existsDump()` methods
- `packages/core/src/dx/orm.ts` — add `.exists()` and `.existsDump()` to `QueryBuilderImpl`
- `packages/core/src/dx/types.ts` — add `.exists()` and `.existsDump()` to QueryBuilder interface
- `packages/core/src/dx/query-executor.ts` — add exists execution path if needed
- `packages/adapter-pgsql/src/pgsql-adapter.ts` — handle `existsWrap` in compile
- `packages/adapter-pgsql/src/compiler.ts` — wrap SELECT in EXISTS

**Tests:**
- `packages/core/src/dx/__tests__/typed-query-builder.test.ts` — unit tests A1-A9
- `packages/adapter-pgsql/src/__tests__/nql-to-sql.test.ts` — SQL output test

**Exit criteria:** A1-A9 pass, typecheck clean, all existing tests pass

### Block 2: NQL multi-row INSERT grammar + parser + compiler

**Files:**
- `packages/nql/src/lexer/tokens.ts` — add `Values` token
- `packages/nql/src/parser/grammar.ts` — modify `insertStmt`, add `valuesTuple`
- `packages/nql/src/parser/ast.ts` — change `NqlInsert.assignments` → `NqlInsert.rows`
- `packages/nql/src/semantic/visitor.ts` — update `insertStmt()` for both syntaxes
- `packages/nql/src/compiler/index.ts` — update `compileInsert()` for multi-row

**Tests:**
- `packages/nql/tests/lexer.test.ts` — Values token
- `packages/nql/tests/parser.test.ts` — both syntaxes parse
- `packages/nql/tests/visitor.test.ts` — AST output
- `packages/nql/tests/mutation-advanced.test.ts` — B1-B10 compile tests

**Exit criteria:** B1-B10 pass, backward compat with single-row, typecheck clean

### Block 3: NQL → SQL end-to-end + documentation

**Files:**
- `packages/adapter-pgsql/src/__tests__/nql-to-sql.test.ts` — E2E NQL → SQL tests
- `docs/guides/orm-api.md` — document `.exists()`
- `docs/guides/nql-reference.md` — document multi-row INSERT syntax

**Exit criteria:** E2E SQL tests pass with `sql.equals`, docs updated

---

## Verification

```bash
# After each block:
pnpm -C packages/types build
pnpm -C packages/core build
pnpm -C packages/nql build
pnpm -C packages/adapter-pgsql build
pnpm test
pnpm tsc --noEmit
```

## Risks

1. **AST breaking change**: Renaming `NqlInsert.assignments` to `rows` will break existing tests AND all downstream consumers (visitor, compiler, CLI if applicable) — must update all references
2. **Grammar ambiguity**: `set` keyword used for both INSERT and UPDATE — the `| set` continuation requires GATE (lookahead) to disambiguate from mutation pipeline `| select` / `| bind` (RESOLVED: GATE added to grammar)
3. **Column normalization**: Union of all keys, missing → `undefined` → NULL. NOT DEFAULT. (RESOLVED: documented behavior)
4. **PostgreSQL parameter limit**: ~65,535 parameters. Large multi-row inserts may hit this. (DOCUMENTED: known limitation, no chunking in v1)
5. **`values` soft keyword**: Must not break existing `values` identifiers in user NQL queries
