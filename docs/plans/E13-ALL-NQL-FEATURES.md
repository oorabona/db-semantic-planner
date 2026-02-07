# E13-ALL: NQL Language Features Batch

**Status:** Draft → Spec
**Created:** 2026-02-06
**Scope:** nql, types, core, adapter-pgsql
**Complexity:** COMPLEX
**Adversarial:** 5/5 perspectives applied, 6 spec hardenings
**Multi-LLM:** Codex + Gemini + Copilot review applied, 13 spec amendments

## Overview

Implement 5 NQL language features in a single batch, following the dialect-agnostic
intent architecture (Ports & Adapters / ARCH-001).

**Architecture principle:** NQL = semantic syntax (not PG grammar copy).
Intent AST is dialect-agnostic. Adapter compiles to native SQL per dialect.

```
NQL (parse) → NQL AST → NQL Compiler → Intent AST → Planner → Adapter → SQL
              ^^^^^^^^^^^^^^^^^^^^      ^^^^^^^^^^^^   ^^^^^     ^^^^^^^
              packages/nql              packages/types  core     adapter-pgsql
```

---

## Items

| ID | Feature | Effort | Gate |
|----|---------|--------|------|
| E13f | Range literal in INSERT — compile | S | `supportsRangeTypes` (exists) |
| E13d | Window lag/lead offset/default in NQL | S | None — standard SQL |
| E13e | IN (dateRange) semantic expansion | M | None — expands to BETWEEN |
| E13 | JSONB operators (dual notation) | M | `supportsJsonOperators` (new) |
| E13b | Set operations (UNION/INTERSECT/EXCEPT + recursive) | M | None — standard SQL |

---

## Block 1: Quick Wins (E13f + E13d)

### E13f — Range Literal in INSERT

**Problem:** `expressionToValue()` in `packages/nql/src/compiler/expression-utils.ts`
throws `"Cannot convert rangeLiteral to value"`.

**Fix:** Add case for `'rangeLiteral'` that returns the PG range string.

```typescript
case 'rangeLiteral': {
  const range = expr as NqlRangeLiteral;
  // Return raw range string for parameterized query: '[2024-01-01,2024-12-31)'
  const lb = range.lowerInclusive ? '[' : '(';
  const ub = range.upperInclusive ? ']' : ')';
  return `${lb}${range.lower},${range.upper}${ub}`;
}
```

**Gate:** Planner checks `DialectCapabilities.supportsRangeTypes` before compiling
range values. Error: `"Range types are not supported by adapter '${name}'"`.

**Files:**
- `packages/nql/src/compiler/expression-utils.ts` — add rangeLiteral case
- `packages/nql/src/compiler/expression-utils.test.ts` — unit test

**Tests:**
- `insert into events set name = 'conf', period = [2024-01-01,2024-12-31)` → INSERT with range param

### E13d — Window lag/lead offset/default

**Problem:** NQL grammar already supports `lag(col, 2, 0)` via funcArgList → exprList.
But the NQL compiler (`compile-select.ts:169-172`) only reads `args[0]` as field,
ignoring args[1] (offset) and args[2] (default). And `WindowIntent` in types has no
`offset`/`defaultValue` properties — comment says "deferred to P3+".

**Fix (3 layers):**

1. **Types:** Add `offset` and `defaultValue` to `WindowIntent`:
   ```typescript
   export interface WindowIntent {
     // ... existing fields ...
     readonly offset?: number | undefined;
     readonly defaultValue?: unknown | undefined;
   }
   ```

2. **NQL compiler:** Extract args[1] as offset, args[2] as defaultValue:
   ```typescript
   // compile-select.ts, window branch
   let offset: number | undefined;
   let defaultValue: unknown;
   if (fn === 'lag' || fn === 'lead') {
     if (windowExpr.args.length > 1) {
       offset = expressionToValue(windowExpr.args[1]!) as number;
     }
     if (windowExpr.args.length > 2) {
       defaultValue = expressionToValue(windowExpr.args[2]!);
     }
   }
   ```

3. **Adapter:** Already handles offset/default in `handlers/expression/window.ts:163-237`.
   Verify it reads from `WindowIntent.offset` / `WindowIntent.defaultValue`.

**Files:**
- `packages/types/src/intent/expression-intent.ts` — add offset/defaultValue to WindowIntent
- `packages/nql/src/compiler/compile-select.ts` — extract args 1-2
- `packages/adapter-pgsql/src/handlers/expression/window.ts` — verify/fix field names

**Tests (NQL→SQL):**
- `orders | select lag(amount, 2) over (order by date) as prev2` → `LAG("amount", 2) OVER (ORDER BY "date")`
- `orders | select lead(amount, 1, 0) over (order by date) as next_amount` → `LEAD("amount", 1, 0) OVER (ORDER BY "date")`
- `orders | select lag(amount) over (order by date) as prev` → `LAG("amount") OVER (ORDER BY "date")` (no offset = default 1 in PG)

**Exit criteria Block 1:**
- Range INSERT compiles to parameterized SQL
- lag/lead with 1-3 args compile correctly NQL→SQL
- 0 regressions

---

## Block 2: IN dateRange Expansion (E13e)

**Problem:** NQL `in_check` already accepts `date_range_literal` (EBNF line 169).
The compiler throws `'Date range in IN clause is not yet supported'` (compile-expression.ts:214-218).

**Design:** The NQL compiler detects date range patterns in string literals and expands
them to `BETWEEN`-style `WhereAndIntent` with two comparisons.

**Supported patterns:**

| Pattern | Example | Expansion |
|---------|---------|-----------|
| `YYYY` | `'2024'` | `>= '2024-01-01' AND < '2025-01-01'` |
| `YYYY-QN` | `'2024-Q1'` | `>= '2024-01-01' AND < '2024-04-01'` |
| `YYYY-MM` | `'2024-06'` | `>= '2024-06-01' AND < '2024-07-01'` |
| `YYYY-WNN` | `'2024-W01'` | `>= '2024-01-01' AND < '2024-01-08'` |

**Half-open intervals (security hardening):** Always `>= start AND < exclusive_end`.
Never `BETWEEN` (inclusive on both sides) — prevents off-by-one boundary leaks.

**Validation (adversarial hardening):**
- Quarter: 1-4, else `InvalidDateRangeError("Invalid quarter 'Q5' — must be Q1-Q4")`
- Week: 1-53, validated against ISO week count for the year
- Month: 1-12

**Implementation:**

1. **Date pattern constants:** `packages/nql/src/compiler/date-range-patterns.ts`
   ```typescript
   export const DATE_RANGE_YEAR = /^(\d{4})$/;
   export const DATE_RANGE_QUARTER = /^(\d{4})-Q([1-4])$/;
   export const DATE_RANGE_MONTH = /^(\d{4})-(\d{2})$/;
   export const DATE_RANGE_WEEK = /^(\d{4})-W(\d{2})$/;

   export function expandDateRange(pattern: string): { start: string; end: string };
   ```

2. **NQL compiler:** Replace the throw with call to `expandDateRange()`, produce
   `WhereAndIntent` with two comparisons (`gte` + `lt`).

3. **No adapter changes** — expands to standard comparison intents.

**Files:**
- `packages/nql/src/compiler/date-range-patterns.ts` — NEW (patterns + expansion)
- `packages/nql/src/compiler/date-range-patterns.test.ts` — NEW (unit tests)
- `packages/nql/src/compiler/compile-expression.ts` — replace throw with expansion
- Update `packages/nql/src/compiler/index.ts` barrel if needed

**Tests:**
- `orders | where date in '2024-Q1'` → `WHERE "date" >= '2024-01-01' AND "date" < '2024-04-01'`
- `orders | where date in '2024'` → `WHERE "date" >= '2024-01-01' AND "date" < '2025-01-01'`
- `orders | where date in '2024-W01'` → week boundaries
- `orders | where date in '2024-Q5'` → throws `InvalidDateRangeError`
- `orders | where date in '2024-W54'` → throws `InvalidDateRangeError`

**Exit criteria Block 2:**
- All 4 date patterns expand correctly
- Invalid patterns throw with descriptive errors
- Half-open intervals verified (exclusive end)
- 0 regressions

---

## Block 3: JSONB Operators (E13)

### Architecture

```
NQL dual notation          Intent AST (semantic)         SQL (per dialect)
─────────────────────  →  ────────────────────────  →  ──────────────────
col->'key'             →  JsonExtractIntent          →  PG: "col"->'key'
col->>'key'            →  {field,path,mode:'text'}   →  MySQL: JSON_UNQUOTE(JSON_EXTRACT("col",'$.key'))
jsonb(col,'key')       →                             →  SQLite: json_extract("col",'$.key')
col->'a'->'b'->>'c'   →  {path:['a','b','c'],       →  PG: "col"->'a'->'b'->>'c'
                           mode:'text'}
col @> '{"k":1}'      →  JsonContainsIntent         →  PG: "col" @> $1
col ? 'key'           →  JsonExistsIntent           →  PG: "col" ? $1
col #> '{a,b}'        →  JsonPathExtractIntent       →  PG: "col" #> $1
col #>> '{a,b}'       →  {path,mode:'text'}          →  PG: "col" #>> $1
```

### DialectCapabilities

New flag: `supportsJsonOperators: boolean`

```typescript
// packages/types/src/dialects.ts
/** Supports JSON path/extract/contains operators (PG: ->, ->>, @>, <@, ?, #>, #>>) */
readonly supportsJsonOperators: boolean;
```

POSTGRESQL_CAPABILITIES: `supportsJsonOperators: true`.

**Error message:** `"JSON operators are not supported by adapter '${capabilities.name}'"`

### NQL Syntax (dual notation)

**Operator notation:**
```
col->'key'           -- extract JSON (returns jsonb)
col->>'key'          -- extract text (returns text)
col#>'{a,b}'         -- path extract JSON
col#>>'{a,b}'        -- path extract text
col @> '{"k":1}'     -- contains
col <@ '{"k":1}'     -- contained by
col ? 'key'          -- key exists
```

**Function notation (portable):**
```
json_extract(col, 'key')       -- same as ->
json_extract_text(col, 'key')  -- same as ->>
json_path(col, '{a,b}')        -- same as #>
json_path_text(col, '{a,b}')   -- same as #>>
json_contains(col, '{"k":1}')  -- same as @>
json_contained_by(col, '{"k":1}') -- same as <@
json_exists(col, 'key')        -- same as ?
```

**Chained operators (adversarial 2.1):**
```
col->'a'->'b'->>'c'  →  JsonExtractIntent { field:'col', path:['a','b','c'], mode:'text' }
```
Last operator determines mode: `->` = json, `->>` = text.

### Intent AST Types

```typescript
// packages/types/src/intent/expression-intent.ts

export interface JsonExtractIntent {
  readonly kind: 'jsonExtract';
  readonly field: string;
  readonly path: readonly string[];
  /** 'json' = returns JSON value, 'text' = returns text */
  readonly mode: 'json' | 'text';
  readonly as?: string;
}

export interface JsonContainsIntent {
  readonly kind: 'jsonContains';
  readonly field: string;
  readonly value: unknown;
  /** true = @> (contains), false = <@ (contained by) */
  readonly reversed: boolean;
}

export interface JsonExistsIntent {
  readonly kind: 'jsonExists';
  readonly field: string;
  readonly key: string;
}

export interface JsonPathExtractIntent {
  readonly kind: 'jsonPathExtract';
  readonly field: string;
  readonly path: string; // PG array literal '{a,b,c}'
  readonly mode: 'json' | 'text';
  readonly as?: string;
}
```

### NQL Tokens (new)

```typescript
// packages/nql/src/lexer/tokens.ts
JsonArrow       = /->(?!>)/     // -> (extract JSON)
JsonArrowText   = /->>/ ;      // ->> (extract text)
JsonContains    = /@>/ ;       // @> (contains)
JsonContainedBy = /<@/ ;       // <@ (contained by)
JsonExists      = /\?/ ;       // ? (key exists) — ONLY in JSONB context
JsonPathArrow   = /#>(?!>)/ ;  // #> (path extract JSON)
JsonPathText    = /#>>/ ;      // #>> (path extract text)
```

**Lexer ambiguity `?`:** The `?` token only appears after a column ref in JSONB context.
Not ambiguous with parameter style (NQL uses `$name`, not `?`).

**Lexer ambiguity `<@`:** Could conflict with `<` followed by `@`. Use longest-match
rule — `<@` is a single token.

### Files (Block 3)

| Layer | File | Changes |
|-------|------|---------|
| Types | `packages/types/src/intent/expression-intent.ts` | Add 4 JSON intent types |
| Types | `packages/types/src/intent/index.ts` | Export new types |
| Types | `packages/types/src/dialects.ts` | Add `supportsJsonOperators` |
| Core | `packages/core/src/dialects/index.ts` | Set `supportsJsonOperators: true` |
| NQL | `packages/nql/src/lexer/tokens.ts` | Add JSON operator tokens |
| NQL | `packages/nql/src/parser/grammar.ts` | Add JSON operator rules in expr |
| NQL | `packages/nql/src/semantic/visit-expression.ts` | Visit JSON operators |
| NQL | `packages/nql/src/compiler/compile-expression.ts` | Compile to JSON intents |
| NQL | `packages/nql/src/compiler/compile-select.ts` | Handle JSON extract in SELECT |
| Adapter | `packages/adapter-pgsql/src/handlers/expression/json.ts` | NEW — JSON SQL handlers |
| Adapter | `packages/adapter-pgsql/src/handlers/expression/index.ts` | Register JSON handlers |
| Docs | `docs/specs/NQL-EBNF.md` | Add JSON operator grammar |

**Tests (NQL→SQL):**
- `users | where data->'name' = 'Alice'` → `WHERE "data"->'name' = $1`
- `users | select data->>'email' as email` → `SELECT "data"->>'email' AS "email"`
- `users | where data->'a'->'b'->>'c' = 'x'` → chained
- `users | where json_extract_text(data, 'email') = 'x'` → same SQL as `->>` form
- `users | where data @> '{"active":true}'` → `WHERE "data" @> $1`
- `users | where data ? 'email'` → `WHERE "data" ? $1`
- Capability gate test: adapter without `supportsJsonOperators` → error with adapter name

**Exit criteria Block 3:**
- Both notations (operator + function) produce same intent AST
- Chained paths compile correctly
- Capability gate works with descriptive error
- 0 regressions

---

## Block 4: Set Operations (E13b)

### Architecture

```
NQL                                 Intent AST                SQL
────────────────────────────  →  ─────────────────────  →  ──────────
q1 | union q2                →  SetOperationIntent      →  (q1) UNION (q2)
q1 | union all q2            →  { all: true }           →  (q1) UNION ALL (q2)
q1 | union (q2 | intersect q3)                          →  (q1) UNION ((q2) INTERSECT (q3))
q1 | union boundName         →  resolves bound CTE      →  (q1) UNION (SELECT * FROM cte)
```

### NQL Syntax

**Right operand is either parenthesized inline query or bound name:**

```ebnf
set_clause        = set_op [ "all" ] set_operand ;
set_op            = "union" | "intersect" | "except" ;
set_operand       = "(" query ")"       (* inline sub-query *)
                  | ident_segment ;     (* bound reference via | bind *)
```

**Examples:**
```sql
-- Simple
users | where active = true | select name | union (admins | select name)

-- With ALL (no dedup)
users | select name | union all (admins | select name)

-- Recursive / nested (adversarial 2.5)
users | select name | union (admins | select name | intersect (mods | select name))

-- Via bind (multi-statement)
admins | select name | bind a
mods | select name | bind m
a | intersect m | bind admin_mods
users | select name | union admin_mods
```

**Grammar integration:** `set_clause` is added to `query_clause`:
```ebnf
query_clause      = where_clause
                  | select_clause
                  | ... existing clauses ...
                  | set_clause ;       (* NEW *)
```

### Intent AST

```typescript
// packages/types/src/intent/query-intent.ts

export interface SetOperationIntent {
  readonly kind: 'setOperation';
  readonly op: 'union' | 'intersect' | 'except';
  readonly all: boolean;
  readonly left: QueryIntent;
  readonly right: QueryIntent;  // recursive: can itself be SetOperationIntent's query
}
```

**The SetOperationIntent wraps two QueryIntents.** For recursive nesting, the right
side's query is itself a set operation, producing a tree:

```
        union
       /     \
    q1        intersect
             /          \
           q2            q3
```

### Column Count Validation (adversarial 2.3)

**Planner validates:** left and right queries must produce the same number of columns.

```typescript
if (leftColumnCount !== rightColumnCount) {
  throw new SetOperationColumnMismatchError(op, leftColumnCount, rightColumnCount);
}
```

Error: `"UNION requires both queries to have the same number of columns (left: 3, right: 2)"`

### NQL Tokens (new)

```typescript
Union     = /union/i ;
Intersect = /intersect/i ;
Except    = /except/i ;
All       = /all/i ;       // already exists? check
```

### Files (Block 4)

| Layer | File | Changes |
|-------|------|---------|
| Types | `packages/types/src/intent/query-intent.ts` | Add `SetOperationIntent` |
| Types | `packages/types/src/intent/index.ts` | Export |
| NQL | `packages/nql/src/lexer/tokens.ts` | Add Union/Intersect/Except tokens |
| NQL | `packages/nql/src/parser/grammar.ts` | Add `setClause` rule in query_clause |
| NQL | `packages/nql/src/parser/ast.ts` | Add `NqlSetOperation` AST type |
| NQL | `packages/nql/src/semantic/` | Visit set operation |
| NQL | `packages/nql/src/compiler/compile-set-operation.ts` | NEW — compile to SetOperationIntent |
| NQL | `packages/nql/src/compiler/index.ts` | Wire compile-set-operation |
| Core | `packages/core/src/planner.ts` | Column count validation for set ops |
| Adapter | `packages/adapter-pgsql/src/handlers/set-operation.ts` | NEW — SQL compilation |
| Adapter | `packages/adapter-pgsql/src/compiler.ts` | Route SetOperationIntent |
| Docs | `docs/specs/NQL-EBNF.md` | Add set operation grammar |

**Tests (NQL→SQL):**
- `users | select name | union (admins | select name)` → `(SELECT "name" FROM "users") UNION (SELECT "name" FROM "admins")`
- `users | select name | union all (admins | select name)` → `... UNION ALL ...`
- `users | select name | intersect (admins | select name)` → `... INTERSECT ...`
- `users | select name | except (admins | select name)` → `... EXCEPT ...`
- Recursive: `a | union (b | intersect c)` → proper nesting
- Via bind: multi-statement with `| bind` references
- Column mismatch: `users | select name | union (admins | select name, role)` → error
- Parenthesized sub-query with WHERE: `users | select name | union (admins | where active = true | select name)`

**Exit criteria Block 4:**
- Simple set ops compile correctly
- `ALL` variant works
- Recursive/nested set ops compile correctly
- Bind references resolve
- Column count mismatch throws descriptive error
- 0 regressions

---

## Block 5: Documentation & EBNF Update

### NQL-EBNF.md Updates

Add to Section 2 (Queries):
```ebnf
query_clause      = ... | set_clause ;

(* Set operations *)
set_clause        = set_op [ "all" ] set_operand ;
set_op            = "union" | "intersect" | "except" ;
set_operand       = "(" query ")" | ident_segment ;
```

Add to Section 3 (Expressions):
```ebnf
(* JSON operators *)
json_op           = json_extract | json_contains | json_exists | json_path ;
json_extract      = expr ( "->" | "->>" ) STRING ;
json_contains     = expr ( "@>" | "<@" ) expr ;
json_exists       = expr "?" STRING ;
json_path         = expr ( "#>" | "#>>" ) STRING ;

(* JSON functions — portable notation *)
json_func         = ( "json_extract" | "json_extract_text" | "json_path"
                    | "json_path_text" | "json_contains" | "json_contained_by"
                    | "json_exists" ) "(" expr "," expr ")" ;

(* IN date range expansion *)
date_range_literal = STRING ;  (* 'YYYY', 'YYYY-QN', 'YYYY-MM', 'YYYY-WNN' *)
```

Add to window function section:
```ebnf
window_only_function = ( "rank" | "dense_rank" | "row_number" ) "(" ")"
                     | ( "lag" | "lead" ) "(" path_expr [ "," NUMBER [ "," literal ] ] ")" ;
```
(Already correct in EBNF — just verify it matches implementation.)

Bump version to 6.0 with changelog entry.

---

## Acceptance Criteria (BDD)

### E13f — Range Literal
```gherkin
Given a table "events" with column "period" of type "daterange"
When I execute: insert into events set name = 'conf', period = [2024-01-01,2024-12-31)
Then SQL contains: INSERT INTO "events" ("name", "period") VALUES ($1, $2)
And parameter $2 is '[2024-01-01,2024-12-31)'
```

### E13d — Window lag/lead
```gherkin
Given a table "orders" with columns "amount", "date"
When I execute: orders | select lag(amount, 2, 0) over (order by date) as prev2
Then SQL contains: LAG("amount", 2, 0) OVER (ORDER BY "date") AS "prev2"
```

### E13e — IN dateRange
```gherkin
Given a table "orders" with column "date"
When I execute: orders | where date in '2024-Q1'
Then SQL contains: WHERE "date" >= '2024-01-01' AND "date" < '2024-04-01'

Given an invalid date range '2024-Q5'
When I execute: orders | where date in '2024-Q5'
Then it throws InvalidDateRangeError with message containing 'Q5'
```

### E13 — JSONB
```gherkin
Given a table "users" with JSONB column "data"
When I execute: users | where data->>'email' = 'alice@example.com'
Then SQL contains: WHERE "data"->>'email' = $1

When I execute: users | where json_extract_text(data, 'email') = 'alice@example.com'
Then the SAME SQL is produced (dual notation → same intent)

Given an adapter with supportsJsonOperators = false
When I execute any JSONB operator query
Then it throws with message containing the adapter name
```

### E13b — Set Operations
```gherkin
Given tables "users" and "admins" with column "name"
When I execute: users | select name | union (admins | select name)
Then SQL is: (SELECT "name" FROM "users") UNION (SELECT "name" FROM "admins")

When I execute: users | select name | union (admins | select name | intersect (mods | select name))
Then SQL is: (SELECT "name" FROM "users") UNION ((SELECT "name" FROM "admins") INTERSECT (SELECT "name" FROM "mods"))

Given mismatched columns
When I execute: users | select name | union (admins | select name, role)
Then it throws SetOperationColumnMismatchError
```

---

## Implementation Order

| Block | Items | Est. | Dependencies |
|-------|-------|------|-------------|
| 1 | E13f + E13d | 30 min | None |
| 2 | E13e | 45 min | None |
| 3 | E13 | 60 min | None |
| 4 | E13b | 60 min | None |
| 5 | EBNF + docs | 15 min | Blocks 1-4 |

Blocks 1-4 are independent — could theoretically parallelize, but sequential is safer
for the grammar/token additions that accumulate.

---

## Error Types (new)

| Error | Package | Message Pattern |
|-------|---------|----------------|
| `InvalidDateRangeError` | nql | `"Invalid date range 'X' — Y"` |
| `SetOperationColumnMismatchError` | core | `"UNION requires both queries to have the same number of columns (left: N, right: M)"` |
| `UnsupportedJsonOperatorError` | core | `"JSON operators are not supported by adapter 'X'"` |

---

## DialectCapabilities Changes

```typescript
// packages/types/src/dialects.ts — ADD:
readonly supportsJsonOperators: boolean;

// packages/core/src/dialects/index.ts — POSTGRESQL_CAPABILITIES:
supportsJsonOperators: true,
```

---

## Risks

| Risk | Mitigation |
|------|-----------|
| JSONB tokens conflict with existing operators | Longest-match lexer rules; `<@` before `<` |
| Set op grammar ambiguity with `(query)` | Reuse existing H2 disambiguation (scan for `\|`) |
| Week number validation complexity | Use ISO 8601 week rules, test edge cases |
| Large grammar changes → parser regen | Chevrotain handles at runtime, test thoroughly |
| Mixed JSON chaining `col->'a'->>'b'->'c'` | Semantic validation: after `->>` (text), no further `->` |
| Set op keywords as identifiers | Reserve `union`/`intersect`/`except` as keywords in set op context |
| `select *` in set ops → can't count columns | Skip column count validation when either side is `select *` |

---

## Multi-LLM Review Amendments (Codex)

### Amendment 1: SetOperationIntent in QueryIntent union (CRITICAL)

`SetOperationIntent` must be part of the `QueryIntent` union type, otherwise
recursive set ops can't nest. The `left` and `right` fields reference `QueryIntent`
which must include set operations.

```typescript
// QueryIntent union must include:
export type QueryIntent = BaseQueryIntent | SetOperationIntent;
// Or SetOperationIntent wraps two BaseQueryIntent
```

### Amendment 2: Column count validation with `select *`

When either side of a set operation uses `select *` (no explicit column list),
column count is unknown at planning time (schema-dependent). In this case:
- **Skip validation** — let the database catch mismatches
- **Document** — note that explicit `select` is recommended for set operations

### Amendment 3: Mixed JSON operator chaining validation

After `->>` (returns text), further `->` is invalid (text is not JSON).
Add semantic validation in NQL compiler:

```
col->'a'->'b'->>'c'     ✅  (json→json→text)
col->'a'->>'b'->'c'     ❌  "Cannot apply JSON operator after ->> (returns text, not JSON)"
```

### Amendment 4: Set op keywords reservation

`union`, `intersect`, `except` become **contextual keywords** — reserved only
after `|` in query pipeline context. Using them as column names still works
when quoted: `"union"`.

### Amendment 5: `set_operand` ident resolution

When `set_operand` is `ident_segment` (not parenthesized), the NQL compiler
resolves it against **bound names only** (from `| bind`). If unbound:
```
"Unbound reference 'X' in set operation. Use '| bind X' to capture a query result."
```
This prevents confusion between table names and bound query references.

### Amendment 6: JSON `->` supports numeric index

Grammar allows `NUMBER` as well as `STRING` after `->` / `->>` for array access:
```
col->0     -- JSON array element at index 0
col->>0    -- JSON array element as text
```

### Amendment 7: ISO 8601 week calculation

Week boundaries must use proper ISO 8601 computation (week starts Monday,
W01 contains January 4th). Not simple `Jan 1 + 7 * (week - 1)`.
Use `Date` or a helper function that handles the ISO calendar correctly.

### Amendment 8: `?|` and `?&` out of scope

Only `?` (single key exists) is supported in v6.0. Array key operators
(`?|`, `?&`) are deferred. Document in EBNF changelog.

### Amendment 9: Set operations are TERMINAL in pipeline (Copilot — CRITICAL)

After a set operation clause, no further query clauses (`where`, `select`, `order by`)
are allowed in the same pipeline. Set ops produce a combined result — further
filtering requires wrapping in a subquery or binding.

```
users | select name | union (admins | select name)              ✅ terminal
users | select name | union (admins | select name) | where ...  ❌ error
users | select name | union (admins | select name) | bind result
result | where ...                                               ✅ via bind
```

Grammar change: set_clause MUST be the last clause in a query pipeline.
```ebnf
query = table_ref { "|" query_clause } [ "|" set_clause ] ;
```

### Amendment 10: Rename "recursive" → "nested" set operations (Gemini)

Avoid confusion with `WITH RECURSIVE` (graph traversal). "Recursive set operations"
→ "Nested set operations" throughout the spec.

### Amendment 11: IN with multiple date ranges → OR expansion (Gemini+Copilot — CRITICAL)

`date in ('2024-Q1', '2024-Q3')` must expand to:
```sql
(date >= '2024-01-01' AND date < '2024-04-01') OR (date >= '2024-07-01' AND date < '2024-10-01')
```

Produces `WhereOrIntent` containing N `WhereAndIntent` children (one per range).
Mixed literal + range in same IN list: reject for v6.0 (must be all ranges or all literals).

### Amendment 12: WindowIntent.defaultValue typed as ExpressionIntent (Gemini)

`lag(amount, 1, other_col)` — default value can be a column reference, not just a literal.
`defaultValue` should be `ExpressionIntent | unknown` (literal or expression).
The adapter must handle both cases: literal → parameterized value, expression → compiled SQL.

### Amendment 13: dateRange expansion restricted to WHERE context (Copilot — CRITICAL)

Date range expansion ONLY happens in `where ... in '2024-Q1'` context.
NOT in SELECT expressions, NOT in INSERT values. Prevents false positives
on text columns containing date-like strings (e.g., product code `'2024-Q1'`).

### Additional Test Scenarios (from 3-LLM review)

**Codex:**
- `col->'a'->>'b'->'c'` → error (text then JSON)
- `col->0` → array index access
- `users | select name | union admins` where `admins` is not bound → error
- `orders | where date in '2024-Q0'` → error
- `orders | where date in '2024-13'` → error (month validation)
- `lag(col, 2, null)` → handle null default
- `a | union b | intersect c` → left-to-right pipeline precedence (document)
- `users | select * | union (admins | select *)` → skip column validation

**Gemini:**
- `date in ('2024-Q1', '2024-Q3')` → OR expansion of multiple ranges
- `date in ('2024', 'not-a-date')` → error (mixed valid/invalid)
- `lag(x, 1, other_col)` → column ref as default value
- Set op precedence: `a | union b | intersect c` → `(a UNION b) INTERSECT c` (pipeline order)

**Copilot:**
- `q1 | union q2 | where x = 1` → error (set op is terminal)
- `withSchema('tenant')` + set op subqueries → both inherit schema
- `date in ('2024-Q1', '2024-Q3')` → OR expansion
- `col #> '{a}' -> 'b'` → mixed path+arrow chain (clarify if supported)
