# TODO: NQL v2.0 Parser (@dbsp/nql)

**Spec:** docs/plans/NQL-SPEC-2026-01.md
**Source:** docs/plans/NQL-PARSER-AUDIT-2026-01.md Section 11
**Status:** ✅ COMPLETE (2026-01-23)

## Summary

| Item | Value |
|------|-------|
| Complexity | ENTERPRISE |
| Blocks | 6 |
| Time Budget | 40h |
| BDD Scenarios | 42 |
| Tests | 179 passing |

## Completed

- [x] ✅ **Block 1:** Package scaffold (`packages/nql/`, build config) (2026-01-23)
- [x] ✅ **Block 2:** Lexer (35+ tokens, quoted identifiers, escape sequences) (2026-01-23)
- [x] ✅ **Block 3:** Parser Core (queries, mutations, let bindings) (2026-01-23)
- [x] ✅ **Block 4:** Semantic Layer (CST→AST visitor) (2026-01-23)
- [x] ✅ **Block 5:** Compiler (NQL AST → IntentAST) - 49 tests (2026-01-23)
- [x] ✅ **Block 6:** Typed expressions, removed raw SQL (2026-01-23)
- [x] ✅ **P2 Fixes:** Unary minus, multi-arg aggregates, EXISTS error (2026-01-23)
- [x] ✅ **Window functions:** OVER, PARTITION BY, ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD (2026-01-23)
- [x] ✅ **Range operators:** overlaps, contains, containedBy + RangeLiteral token (2026-01-23)
- [x] ✅ **UPSERT multi-column:** Fix ON (col1, col2) conflict syntax (2026-01-23)
- [x] ✅ **Range literal grammar refactor:** Regex → grammar-based parsing (2026-01-23)

## Package Structure

```
packages/nql/
├── src/
│   ├── index.ts          # Public API: parse(), validate(), compile()
│   ├── lexer/            # Chevrotain lexer (35+ tokens)
│   ├── parser/           # Grammar + AST types
│   ├── semantic/         # CST→AST visitor
│   ├── compiler/         # NQL AST → IntentAST
│   └── errors/           # Typed error codes
└── tests/                # 179 test cases
    ├── lexer.test.ts     # 32 tests
    ├── parser.test.ts    # 49 tests (+8 window/range)
    ├── visitor.test.ts   # 35 tests
    └── compiler.test.ts  # 63 tests (+4 window/range)
```

## Key Features Implemented

- Pipeline-first syntax: `table | clause | clause`
- Quoted identifiers: `"order"` for reserved words
- String escapes: `'O''Brien'` SQL-style
- Typed expressions: `ColumnAliasIntent`, `AggregateIntent`, `ArithmeticIntent`
- Window functions: `rank() over (partition by x order by y)`
- Range operators: `overlaps`, `contains`, `containedBy` with grammar-based `[start,end)` / `(start,end]` literals
- No raw SQL in output (security)
- Full IntentAST compilation

## Notes

- Chevrotain-based parser (no codegen)
- Pipeline syntax for reads, SQL-familiar mutations
- Position-aware `where` (WHERE before group by, HAVING after)
- CTE support via `let` bindings
- Intent-first joins (planner infers LEFT/INNER from schema)

## Dependencies

- `@dbsp/core` — IntentAST types, ModelIR
- `chevrotain` — Parser framework

## Related

- ADR-003: CLI REPL Framework Selection (Chevrotain)
- NQL v1 parser in `packages/cli/src/repl/parser.ts`

## Backlog (Future Work)

- [x] ✅ **AggregateExpressionIntent adapter integration** (2026-01-23)
  - Added `AggregateExpressionIntent` to `ExpressionIntent` union in core
  - Created `aggregate.ts` handler in `adapter-kysely/src/compiler/handlers/expression/`
  - Supports: `count(*)`, `count(col)`, `sum(col)`, `avg(col)`, `min(col)`, `max(col)`, `count(distinct col)`

- [ ] **WhereSubqueryExistsIntent** — Add new intent type for arbitrary subquery EXISTS
  - NQL supports `exists (subquery)` but IntentAST's WhereExistsIntent requires relation name
  - Need to add `WhereSubqueryExistsIntent` with `subquery: QueryIntent` field to core
  - Then update compiler to emit this intent for EXISTS expressions
  - Priority: LOW (workaround: use relation-based `with` + `where`)

## ⏭️ Out-of-Scope Findings (Codex Review) — OBSOLETE

These were found in adapter-kysely which has been **sunset** (2026-01-30). Verified not applicable to adapter-pgsql:

- [x] ⏭️ `adapter-kysely`: Hard-coded `id` in recursive CTE — adapter-pgsql uses parameterized `pkColumn`
- [x] ⏭️ `adapter-kysely`: GROUP BY joins use hardcoded `id` — adapter-pgsql uses `decision.column`
- [x] ⏭️ `cli`: Cross-table existence ignores sourceRelation — properly handled in adapter-pgsql
- [x] ⏭️ `adapter-kysely`: columnAlias not in ORDER BY aliases — adapter-pgsql uses `ResTarget` wrapping

## Bugs from Example Testing (2026-01-23)

Discovered while running `examples/*.dbsp` against pg-demo PostgreSQL.

### P1 — Critical (Blocking Examples)

- [x] ✅ **OBSOLETE: Nested includes with where clause** (2026-01-27)
  - Original: `categories | with products | where active = true`
  - **Status:** OBSOLETE — The `with` keyword was removed in NQL v2.1 (2026-01-24)
  - New syntax: `categories | select *, products.* | where products.active = true`
  - The new include syntax works correctly with where clauses

- [x] ✅ **Aggregates in CLI executor** (2026-01-25)
  - Example: `orders | group by status | select sum(total)`
  - **Status:** FIXED — AggregateExpressionIntent handler added and registered
  - Commits: 8e91c23, ef41f97
  - Files: `packages/adapter-kysely/src/compiler/handlers/expression/aggregate.ts`
  - Tests: All aggregate tests pass (ecommerce.assert.dbsp queries 13-16)

### P2 — Medium (Feature Gaps)

- [x] ✅ **Window functions not parsed** (2026-01-23)
  - Example: `products | select *, rank() over (partition by categoryId order by price desc) as priceRank`
  - **Solution:** Added window function tokens (OVER, PARTITION BY, ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD)
    and grammar rules for window expressions
  - Files: `packages/nql/src/lexer/tokens.ts`, `packages/nql/src/parser/grammar.ts`, `packages/nql/src/compiler/`
  - Added 5 tests for window functions

- [x] ✅ **Range operators not supported** (2026-01-23)
  - Example: `roomBookings | where bookingPeriod overlaps [2024-01-16,2024-01-20)`
  - **Solution:** Added RangeLiteral token, range operators (overlaps, contains, containedBy) to lexer,
    `NqlRangeLiteral` AST type, and `WhereRangeOpIntent` compilation
  - Files: `packages/nql/src/lexer/tokens.ts`, `packages/nql/src/parser/ast.ts`, `packages/nql/src/compiler/`
  - Added 5 tests for range operators
  - **Fixed UPSERT regression:** RangeLiteral regex was matching identifier lists like `(col1, col2)`;
    fixed with lookahead to only match values starting with digits

- [x] ✅ **Range operators in include.where not compiled** (2026-01-24)
  - Example: `rooms | with roomBookings | where bookingPeriod overlaps [2024-01-16,2024-01-20)`
  - Error: WHERE clause was silently ignored, no range operator in SQL
  - Root cause: `addWhereToJoin()` only handled comparison, like, and, or, not range operators
  - **Solution:** Added `kind === 'range'` handling in `addWhereToJoin()` using `compileRangeExpression()`
  - Files: `packages/adapter-kysely/src/recursive-compiler.ts:886-903`
  - Ref: `scheduling.assert.dbsp` Query 14

- [x] ✅ **Scalar contains operator** (2026-01-24)
  - Example: `priceTiers | where quantityRange contains 25`
  - **Problem:** Parser only accepted range literals after `contains` operator
  - **Solution:** Updated grammar `rangeOpSuffix` to accept either `rangeLiteral` OR scalar `literal`
  - **AST change:** `NqlRangeOpExpression` now has optional `range?` and `scalar?` fields
  - **Compiler:** Handle both range and scalar values in `case 'rangeOp'`
  - Files: `packages/nql/src/parser/grammar.ts`, `ast.ts`, `semantic/visitor.ts`, `compiler/index.ts`
  - Tests: All 292 CLI tests pass, 179 NQL tests pass

- [x] ✅ **Intent assertions for semantic verification** (2026-01-24)
  - **Problem:** SQL string assertions are fragile; intent.* assertions verify IntentAST directly
  - **Solution:** Added 6 intent assertion types to assertion parser:
    - `intent.type` — Intent type (query/insert/update/delete/upsert)
    - `intent.table` — Main table name (logical)
    - `intent.with` — Relations joined via `with` keyword
    - `intent.hasWhere` — Has WHERE clause (true/false)
    - `intent.hasGroupBy` — Has GROUP BY (true/false)
    - `intent.hasOrderBy` — Has ORDER BY (true/false)
  - Also improved `sql.join` detection for all JOIN types + CTEs
  - Files: `packages/cli/src/repl/assertion-parser.ts`, `assertion-runner.ts`
  - Updated: `examples/*.assert.dbsp` files with intent.* assertions
  - Tests: All 1895+ tests pass (715 core, 708 adapter, 179 nql, 292 cli, 1 mcp)

- [x] ✅ **Range literal grammar refactor** (2026-01-23)
  - **Problem:** Complex RangeLiteral regex caused conflicts with NumberLiteral (matched `99.99`)
    and UPSERT ON clause `(col1, col2)`
  - **Solution:** Refactored from single regex token to grammar-based parsing:
    1. Replaced `RangeLiteral` regex with simpler tokens: `LBracket`, `RBracket`, `RangeValue`
    2. Created dedicated grammar rules: `rangeLiteral`, `rangeOp`, `rangeOpSuffix`
    3. Range operators separated from `compOp` (avoids `(` ambiguity with grouped expressions)
    4. Range literals ONLY valid after range operators (context-sensitive parsing)
    5. Full PostgreSQL range bound support: `[` inclusive, `(` exclusive
  - Files modified:
    - `packages/nql/src/lexer/tokens.ts` — Simplified token set
    - `packages/nql/src/parser/grammar.ts` — New `rangeOpSuffix` rule
    - `packages/nql/src/parser/ast.ts` — Added `NqlRangeOpExpression` type
    - `packages/nql/src/semantic/visitor.ts` — `rangeOp`, `rangeOpSuffix` methods
    - `packages/nql/src/compiler/index.ts` — `rangeOp` case
  - EBNF documentation updated:
    - `docs/plans/CLI-NQL-natural-query-language.md`
    - `docs/plans/NQL-PARSER-AUDIT-2026-01.md`
  - Tests: 179 passing (no regressions)

- [x] ✅ **🏗️ ARCH: camelCase table names not resolved to snake_case** (2026-01-23)
  - Example: `roomBookings` → should find `room_bookings` table
  - **Solution (ARCH-003):** Implemented logical/physical naming separation
    1. Schema uses **logical** camelCase names (`roomBookings`)
    2. Adapter transforms to **physical** snake_case via CamelCasePlugin
    3. CLI resolves user input against logical model names
  - Commit: `d16779e feat(cli,examples): implement logical/physical naming separation (ARCH-003)`
  - Files: `packages/core/src/dx/schema.ts`, `packages/adapter-kysely/src/`, `packages/cli/src/repl/`

### P3 — Low (Edge Cases)

- [x] ⏭️ **Timestamp string becomes $ref wrapper** — adapter-kysely specific, NQL compiler now handles string literals correctly (2026-01-31)

- [ ] **Range literal in INSERT not converted**
  - Example: `insert into priceTiers set quantityRange = "[1,50)"`
  - Error: `malformed range literal`
  - Root cause: Range string value passed as-is instead of PostgreSQL range syntax
  - **Solution:** Detect range pattern in mutation-compiler `valueToNode()` for range columns
  - Files: `packages/adapter-pgsql/src/mutations/mutation-compiler.ts`
  - Ref: `scheduling.assert.dbsp` query 16

### Config/Doc (Not Bugs)

- [x] ✅ **Upsert requires UNIQUE constraint** — Documented in assert files
  - Example: `upsert into rooms on name` fails if `name` has no UNIQUE constraint
  - **Not a bug:** PostgreSQL requires unique/exclusion constraint for ON CONFLICT
  - **Action:** Document this requirement in QUICKSTART.md and error message
  - Ref: `scheduling.assert.dbsp` query 20

---

## Future Enhancements

### JSONB Operators Support (Priority: MEDIUM)

**Status:** 🟡 Backlog
**Effort:** M (~4h)
**Ref:** ARCH-003 risk assessment

The NQL grammar currently doesn't support PostgreSQL JSONB operators.

**Required operators:**
| Operator | Description | Example |
|----------|-------------|---------|
| `->` | Get JSON object field (returns json) | `metadata->'status'` |
| `->>` | Get JSON object field as text | `metadata->>'name'` |
| `@>` | Contains | `metadata @> '{"active": true}'` |
| `<@` | Contained by | `'{"a":1}' <@ metadata` |
| `?` | Key exists | `metadata ? 'status'` |
| `#>` | Get JSON at path (returns json) | `metadata#>'{user,name}'` |
| `#>>` | Get JSON at path as text | `metadata#>>'{user,name}'` |

**Implementation tasks:**
- [ ] Add lexer tokens for JSONB operators (`->`, `->>`, `@>`, `<@`, `?`, `#>`, `#>>`)
- [ ] Extend parser grammar for JSONB expressions
- [ ] Add AST node types for JSONB operations
- [ ] Implement compiler to IntentAST (likely `RawExpressionIntent` or new `JsonbIntent`)
- [ ] Add tests (lexer + parser + compiler)

**Workaround:** Use `raw()` escape hatch in DX layer until implemented.

### CamelCasePlugin + JSONB Consideration

**Status:** ⚠️ Documented
**Ref:** ARCH-003 risk assessment

When using `CamelCasePlugin` with JSONB columns, keys inside JSON data are transformed by default.

**Recommendation:** Use `maintainNestedObjectKeys: true` if JSONB columns contain data with keys that must be preserved:
```typescript
new CamelCasePlugin({ maintainNestedObjectKeys: true })
```

**Documented in:** `examples/QUICKSTART.md`

---

## ✅ NQL v2.1 — Grammar Simplification (COMPLETED 2026-01-24)

**Spec:** `docs/specs/NQL-V2.1-SIMPLIFICATION-SPEC.md`
**Status:** ✅ COMPLETE
**Effort:** L (~4h actual)
**Breaking:** YES (removed `with` keyword)
**Adversarial Review:** Completed (Codex + Gemini + Claude consensus)

### Summary

Removed `with` keyword, json_agg by default for relation includes via path expressions.

### Changes

| Before (v2.0) | After (v2.1) |
|---------------|--------------|
| `authors \| with posts` | `authors \| select *, posts.*` |
| N/A | `authors \| select *, posts.* \| flat` (force JOIN) |
| N/A | `.output json\|table\|csv` (REPL command) |

### Implementation Blocks

- [x] ✅ **Block 1:** Grammar changes — Add `FLAT` token, remove `with` (2026-01-24)
- [x] ✅ **Block 2:** Compiler — Relation path detection, `| flat` clause (2026-01-24)
- [x] ✅ **Block 3:** Adapter — Strategy enforcement (json_agg default) (2026-01-24)
- [x] ✅ **Block 4:** REPL `.output` command + output-formatter.ts (2026-01-24)
- [x] ✅ **Block 5:** E2E tests + documentation + examples migration (2026-01-24)

### Deferred to v2.2+

- [ ] `batch(N)` streaming — Database-dependent cursor support
- [ ] Per-relation pagination — Requires subquery strategy

### Known Parser Limitations (2026-01-25)

Discovered while validating `examples/*.dbsp` files:

| Syntax | Status | Workaround |
|--------|--------|------------|
| `count(distinct col)` | ✅ Implemented (2026-01-27, NQL-DIVERGE) | — |
| `select distinct` (no columns) | ❌ Not parsed | Use `select distinct *` or explicit columns |

**Priority:** LOW — `select distinct` without columns is the only remaining limitation

---

## 📋 BACKLOG: CASE Expression Enhancements (2026-01-27)

Discovered during NQL-ALIGN Block 2 implementation. Current CASE supports "Searched CASE" only.

### Deferred Features

| Feature | Syntax | Priority | Effort |
|---------|--------|----------|--------|
| Simple CASE | `case status when 'active' then 1 when 'inactive' then 0 end` | LOW | M |
| Nested CASE | `case when x then case when y then a else b end else c end` | LOW | S |
| Column in THEN/ELSE | `case when active then name else 'N/A' end` | MEDIUM | S |
| Function in THEN/ELSE | `case when x then upper(name) else name end` | MEDIUM | M |
| CASE in WHERE | `where case when x then y else z end = value` | LOW | M |

### What's Already Working (v2.1)

- ✅ Searched CASE: `case when condition then result end`
- ✅ Multiple WHEN clauses
- ✅ ELSE clause
- ✅ All comparison operators in conditions (=, !=, <, >, <=, >=, like)
- ✅ Boolean operators in conditions (and, or, not)
- ✅ Alias: `case ... end as alias`
- ✅ String/number literals in THEN/ELSE

**Note:** Column refs and functions in THEN/ELSE may already work via `expression` rule — needs testing.

---

## ✅ NQL-ALIGN: Spec/Implementation Alignment (2026-01-27)

**Spec:** docs/plans/NQL-ALIGN-SPEC.md
**Status:** ✅ COMPLETE
**Divergences:** docs/specs/NQL-DIVERGENCES.md

### Completed Blocks

| Block | Description | Status |
|-------|-------------|--------|
| 1 | CASE Expression Lexer + AST | ✅ |
| 2 | CASE Compiler + INSERT FROM | ✅ |
| 3 | Global Limits (maxDepth, maxTableHops, maxNestedCase) | ✅ |
| 4 | Relation Alias (semantic table names) | ✅ |
| 5 | SEPARATE Optimization (subquery strategy) | ✅ |
| 6 | Warnings + Documentation | ✅ |

### Deferred Features

| Feature | Reason | Documented |
|---------|--------|------------|
| ~~Scoped traversal `[N]`~~ | ✅ Implemented (2026-01-27, NQL-DIVERGE) | ✅ NQL-DIVERGENCES.md |
| HAVING keyword | WHERE after GROUP BY works | ✅ NQL-DIVERGENCES.md |
| ~~count(distinct col)~~ | ✅ Implemented (2026-01-27, NQL-DIVERGE) | ✅ NQL-DIVERGENCES.md |
