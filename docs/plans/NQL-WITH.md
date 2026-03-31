---
doc-meta:
  status: canonical
  scope: nql
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-03-27
  updated: 2026-03-27
  complexity: COMPLEX
  time-budget: 2h
---

# Specification: NQL-WITH — CTE Syntax in NQL Parser

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | nql (lexer, parser, visitor, compiler) |
| Complexity | COMPLEX |
| Time budget | 2h |
| Blocks | 3 |
| BDD scenarios | 10 |
| Risk level | MEDIUM |

## 1. Problem Statement

NQL has no explicit WITH clause. Users cannot define Common Table Expressions to use as subquery sources. The intent system (`CteQueryIntent`, `RawCteIntent`) and adapter compiler already support CTEs — only the NQL parser layer is missing.

Scope: **non-recursive CTEs only** (WITH RECURSIVE already works via `orm.recursive()` API and pseudo-column includes in NQL).

## 2. User Stories

### US-1: Named CTE in NQL
AS A developer writing complex NQL queries
I WANT `with active_users as (users | where active = true) orders | where userId in (active_users | select id)`
SO THAT I can decompose complex queries into readable named subqueries

ACCEPTANCE: Parser produces `CteQueryIntent` with correct CTE definitions + outer query

### US-2: Multiple CTEs
AS A developer with multi-step data transformations
I WANT `with a as (...), b as (...) table | where ...`
SO THAT I can chain CTEs like in SQL

ACCEPTANCE: Multiple CTEs compile to `CteQueryIntent.ctes[]` array

## 3. Business Rules

### 3.1 Invariants
- INV-01: Existing NQL queries without WITH MUST NOT change behavior
- INV-02: CTE names follow identifier rules (alphanumeric + underscore)
- INV-03: CTE body uses standard NQL pipe syntax
- INV-04: CTE names are available as table references in the outer query

### 3.2 Syntax Definition
```
withQuery     → WITH cteList mainQuery
cteList       → cteItem { "," cteItem }
cteItem       → Identifier AS "(" query ")"
mainQuery     → query (standard pipe syntax)
```

Example:
```nql
with active_products as (products | where active = true | select id, name)
orders | where productId in (active_products | select id) | select *
```

Multiple CTEs:
```nql
with
  active_users as (users | where active = true),
  recent_orders as (orders | where createdAt > '2026-01-01')
recent_orders | where userId in (active_users | select id)
```

### 3.3 Effects
- EFF-01: Parser produces `CteQueryIntent` wrapping the outer `QueryIntent`
- EFF-02: Each CTE becomes a `{ kind: 'simpleCte', name, query: QueryIntent }` entry
- EFF-03: Outer query can reference CTE names as FROM tables

### 3.4 Error Handling
- ERR-01: CTE with no body → parser error "Expected '(' after AS"
- ERR-02: Duplicate CTE name → **hard semantic error** (PostgreSQL rejects; catch early)
- ERR-03: Set operations (`| union`, `| intersect`, `| except`) in CTE body → **not supported** in v1 (parser accepts but compiler rejects with clear error)

### 3.5 Out of Scope (Explicit)
- Nested WITH (`with a as (with b as (...) ...)`) → NOT SUPPORTED
- Forward CTE references (`with a as (b | ...), b as (...)`) → SQL-level error (no dbsp validation)
- WITH RECURSIVE → separate feature (`orm.recursive()` + NQL pseudo-columns already handle this)
- `with` as table/alias name → **BREAKING CHANGE** accepted (reserved keyword now)

## 4. Technical Design

### 4.1 Architecture — 4-layer changes, all in `packages/nql/`

### 4.2 Layer Changes

| Layer | File | Change |
|-------|------|--------|
| Lexer | `lexer/tokens.ts` | Add `With` token (keyword, case-insensitive) |
| Parser | `parser/grammar.ts` | Add `withQuery`, `cteList`, `cteItem` rules |
| AST | `parser/ast.ts` | Add `NqlCteItem`, extend `NqlProgram` |
| Visitor | `semantic/visitor.ts` + `visit-cte.ts` (new) | CST → AST for CTE nodes |
| Compiler | `compiler/compile-query.ts` | NQL CTE AST → `CteQueryIntent` |

### 4.3 Design Decisions

1. **`As` token**: Already exists in the lexer (used for aliases). Reuse it.
2. **`With` token**: Hard reserved keyword. Must be ordered BEFORE `Where` in allTokens. **Breaking change**: identifiers named `with` no longer parse without quoting.
3. **`Recursive` token**: NOT added in this spec (non-recursive only). Future scope.
4. **CTE Intent type**: Use existing `CteQueryIntent` from `@dbsp/types`. CTE entries need a new `SimpleCteIntent` variant (non-unnest, non-recursive — just a named subquery).
5. **CompileResult extension** (Codex P1): `CompileResult.query` type must be widened from `QueryIntent` to `QueryIntent | CteQueryIntent`. Update `compiler/types.ts` + `compiler/index.ts` + public re-exports.
6. **ColumnValidator bypass** (Codex P1): Pass CTE names as `knownCteTables: Set<string>` to `ColumnValidator.validateTable()` so it skips validation for CTE references in outer query + subqueries.
7. **Set ops in CTE body** (Codex P2): `SimpleCteIntent.query` stays `QueryIntent` (not `SetOperationIntent`). If parser encounters `| union` in CTE body, compiler throws "Set operations in CTE body not supported yet".

### 4.4 New Intent Type

```typescript
// In packages/types/src/intent/cte-intent.ts — ADD:
export interface SimpleCteIntent {
  readonly kind: 'simpleCte';
  readonly name: string;
  readonly query: QueryIntent;
}

// Update CteQueryIntent.ctes union:
readonly ctes: readonly (UnnestCteIntent | RawCteIntent | SimpleCteIntent)[];
```

### 4.5 Adapter Compiler Change

The adapter's `compileCteQuery()` needs a new `case 'simpleCte'` handler:
```typescript
case 'simpleCte': {
  // Compile inner query to SQL AST
  const innerAst = this.compileSelect(cte.query, ...);
  // Wrap in CommonTableExpr { ctename, ctequery }
}
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: NQL WITH Syntax

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Single CTE
  Given NQL: with active as (users | where active = true) active | select *
  When parsed and compiled
  Then intent has CteQueryIntent with 1 SimpleCteIntent + outer QueryIntent from 'active'

@priority:high @type:nominal
Scenario: SC-02 — Multiple CTEs
  Given NQL: with a as (users | where x = 1), b as (orders | where y = 2) b | select *
  When parsed and compiled
  Then intent has CteQueryIntent with 2 SimpleCteIntents

@priority:high @type:nominal
Scenario: SC-03 — CTE used in WHERE IN subquery
  Given NQL: with recent as (orders | where date > '2026-01-01') products | where id in (recent | select productId)
  When compiled to SQL
  Then SQL has WITH recent AS (SELECT ... FROM orders WHERE ...) SELECT ... FROM products WHERE id IN (SELECT productId FROM recent)

@priority:high @type:nominal
Scenario: SC-04 — CTE with pipe clauses (where, select, order, limit)
  Given NQL: with top5 as (users | where active = true | order by score desc | limit 5) top5 | select *
  When parsed
  Then CTE inner query has where + orderBy + limit clauses

@priority:medium @type:edge
Scenario: SC-05 — CTE name used as FROM table in outer query
  Given NQL: with filtered as (products | where active = true) filtered | select name, price
  When compiled
  Then outer query FROM = 'filtered' (references CTE, not a physical table)

@priority:medium @type:edge
Scenario: SC-06 — Non-WITH query unchanged (regression)
  Given NQL: users | where active = true | select *
  When parsed
  Then produces standard QueryIntent (no CteQueryIntent wrapper)

@priority:medium @type:edge
Scenario: SC-07 — CTE with nested include
  Given NQL: with enriched as (users | select *, posts.* | flat) enriched | where id = 1
  When parsed
  Then CTE inner query includes flat include clause

@priority:low @type:error
Scenario: SC-08 — Missing CTE body
  Given NQL: with broken as users | select *
  When parsed
  Then parser error (missing parentheses)

@priority:low @type:error
Scenario: SC-09 — Empty CTE body
  Given NQL: with empty as () users | select *
  When parsed
  Then parser error (no query in parentheses)

@priority:medium @type:nominal
Scenario: SC-10 — Full SQL compilation
  Given NQL: with active as (products | where active = true | select id, name) orders | where productId in (active | select id) | select *
  When compiled to SQL via adapter
  Then SQL = WITH active AS (SELECT products.id, products.name FROM products WHERE products.active = $1) SELECT orders.* FROM orders WHERE orders.product_id IN (SELECT active.id FROM active)
```

## 6. Implementation Plan

### Block 1: Types + Lexer + Parser — 45min

**Type:** Infrastructure
**Dependencies:** None
**Files:**
- `packages/types/src/intent/cte-intent.ts` — add `SimpleCteIntent`
- `packages/nql/src/lexer/tokens.ts` — add `With` token
- `packages/nql/src/parser/grammar.ts` — add `withQuery`, `cteList`, `cteItem` rules
- `packages/nql/src/parser/ast.ts` — add `NqlCteItem` type, extend top-level AST

**Exit criteria:**
- [ ] `With` token lexes correctly
- [ ] Parser accepts `with name as (...) query` syntax
- [ ] Parser rejects malformed WITH (SC-08, SC-09)

### Block 2: Visitor + Compiler — 45min

**Type:** Feature
**Dependencies:** Block 1
**Files:**
- `packages/nql/src/semantic/visitor.ts` — add `withQuery` visitor method
- `packages/nql/src/semantic/visit-cte.ts` — new domain module for CTE CST→AST
- `packages/nql/src/compiler/compile-query.ts` — add CTE compilation to `CteQueryIntent`

**Exit criteria:**
- [ ] CST → AST correctly produces `NqlCteItem[]` + outer query
- [ ] NQL AST → IntentAST produces `CteQueryIntent` with `SimpleCteIntent[]`
- [ ] Non-WITH queries unchanged (SC-06)

### Block 3: Adapter + Tests + Docs — 30min

**Type:** Integration
**Dependencies:** Block 2
**Files:**
- `packages/adapter-pgsql/src/compiler.ts` — add `case 'simpleCte'` in `compileCteQuery()`
- `packages/nql/src/__tests__/nql-with.test.ts` — 10 test cases
- `docs/guides/nql-reference.md` — add WITH section

**Exit criteria:**
- [ ] Full SQL compilation works (SC-10)
- [ ] All 10 BDD scenarios pass
- [ ] All existing NQL tests pass (regression)
- [ ] NQL reference guide updated

## 7. Test Strategy

| Level | Count | Focus |
|-------|-------|-------|
| Unit (parser) | 4 | Lexing + parsing correctness |
| Unit (compiler) | 4 | Intent generation |
| Integration (SQL) | 2 | Full NQL → SQL compilation |
| E2E | 0 | Covered by existing E2E when used |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| `With` token conflicts with identifiers starting with "with" | H | L | Keyword tokens have higher priority than Identifier in Chevrotain |
| CTE name resolution in outer query | M | M | CTE names treated as regular table names by planner — planner doesn't validate table existence |
| Chevrotain ambiguity with existing grammar | M | L | `GATE` with lookahead to distinguish `with` keyword from potential table name |
| Visitor stub methods needed | L | H | Chevrotain requires ALL rules to have visitor methods — add stubs |

## 9. Definition of Done

- [ ] All 3 blocks implemented
- [ ] All 10 BDD scenarios passing
- [ ] All NQL tests pass (regression)
- [ ] All adapter tests pass
- [ ] Lint/typecheck pass
- [ ] NQL reference guide updated
