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
| Tests | 167 passing |

## Completed

- [x] ✅ **Block 1:** Package scaffold (`packages/nql/`, build config) (2026-01-23)
- [x] ✅ **Block 2:** Lexer (35+ tokens, quoted identifiers, escape sequences) (2026-01-23)
- [x] ✅ **Block 3:** Parser Core (queries, mutations, let bindings) (2026-01-23)
- [x] ✅ **Block 4:** Semantic Layer (CST→AST visitor) (2026-01-23)
- [x] ✅ **Block 5:** Compiler (NQL AST → IntentAST) - 49 tests (2026-01-23)
- [x] ✅ **Block 6:** Typed expressions, removed raw SQL (2026-01-23)
- [x] ✅ **P2 Fixes:** Unary minus, multi-arg aggregates, EXISTS error (2026-01-23)

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
