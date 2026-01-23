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
└── tests/                # 167 test cases
    ├── lexer.test.ts     # 32 tests
    ├── parser.test.ts    # 41 tests
    ├── visitor.test.ts   # 35 tests
    └── compiler.test.ts  # 59 tests
```

## Key Features Implemented

- Pipeline-first syntax: `table | clause | clause`
- Quoted identifiers: `"order"` for reserved words
- String escapes: `'O''Brien'` SQL-style
- Typed expressions: `ColumnAliasIntent`, `AggregateIntent`, `ArithmeticIntent`
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

## Out-of-Scope Findings (Codex Review)

These were found during review but are in other packages:

- [ ] `adapter-kysely`: Hard-coded `id` in recursive CTE (compiler.ts:1424)
- [ ] `adapter-kysely`: GROUP BY joins use hardcoded `id` (compiler.ts:2807)
- [ ] `cli`: Cross-table existence ignores sourceRelation (query-executor.ts:453)
- [ ] `adapter-kysely`: columnAlias not in ORDER BY aliases (compiler.ts:2867)

## Bugs from Example Testing (2026-01-23)

Discovered while running `examples/*.dbsp` against pg-demo PostgreSQL.

### P1 — Critical (Blocking Examples)

- [ ] **Nested includes with where clause fail**
  - Example: `categories | with products | where active = true`
  - Error: `column t0.active does not exist`
  - Root cause: After include, `where` clause still references `t0` (parent) instead of joined table alias
  - **Solution:** CLI executor must track active table context after `with` and resolve columns to correct alias
  - Files: `packages/cli/src/repl/query-executor.ts`
  - Ref: `ecommerce.assert.dbsp` query 9

- [ ] **Aggregates fail in CLI executor**
  - Example: `orders | group by status | select sum(total)`
  - Error: `Cannot read properties of undefined (reading 'map')`
  - Root cause: NQL compiler emits `AggregateExpressionIntent` but CLI executor doesn't wire it to adapter
  - **Solution:** Connect NQL's `AggregateExpressionIntent` output to adapter's aggregate handler in query-executor
  - Files: `packages/cli/src/repl/query-executor.ts`, `packages/adapter-kysely/src/compiler/handlers/expression/aggregate.ts`
  - Ref: `ecommerce.assert.dbsp` queries 12-15

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

- [ ] **🏗️ ARCH: camelCase table names not resolved to snake_case**
  - Example: `roomBookings` → should find `room_bookings` table
  - Error: `Unknown table: roomBookings`
  - Current: `defineSchema` uses snake_case table names (`room_bookings`)
  - **Architectural issue:** Schema definition mixes logical and physical naming
  - **Proposed solution:**
    1. `defineSchema` should use **logical** camelCase names (`roomBookings`)
    2. Adapter (Kysely + CamelCasePlugin) transforms to **physical** snake_case
    3. CLI/parser should resolve user input against logical model names
    4. This separates concerns: domain model (logical) vs database implementation (physical)
  - Impact: Schema API change, adapter config, CLI resolution
  - Files: `packages/core/src/dx/schema.ts`, `packages/adapter-kysely/src/`, `packages/cli/src/repl/`
  - Ref: `scheduling.assert.dbsp` queries 6, 8

### P3 — Low (Edge Cases)

- [ ] **Timestamp string becomes $ref wrapper**
  - Example: `update products set deletedAt = "2024-12-01T00:00:00Z" where sku = "OLD-PRODUCT"`
  - Error: `invalid input syntax for type timestamp`
  - Root cause: Quoted strings in SET clause become `{ $ref: "..." }` instead of literal value
  - **Solution:** Compiler should detect ISO 8601 timestamps and emit typed literal, or handle in adapter
  - Files: `packages/nql/src/compiler/`, `packages/adapter-kysely/src/compiler/`
  - Ref: `pimdam.assert.dbsp` query 18

- [ ] **Range literal in INSERT not converted**
  - Example: `insert into priceTiers set quantityRange = "[1,50)"`
  - Error: `malformed range literal`
  - Root cause: Range string value passed as-is instead of PostgreSQL range syntax
  - **Solution:** Detect range pattern in string values for range columns, convert to proper PostgreSQL literal
  - Files: `packages/adapter-kysely/src/compiler/`
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
