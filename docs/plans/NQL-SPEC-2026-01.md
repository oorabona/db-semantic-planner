---
doc-meta:
  status: draft
  scope: nql
  type: specification
  created: 2026-01-23
  updated: 2026-01-23
  complexity: ENTERPRISE
  time-budget: 40h
---

# Specification: NQL v2.0 Parser (`@dbsp/nql`)

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | nql |
| Complexity | ENTERPRISE |
| Time budget | 40h |
| Blocks | 6 |
| BDD scenarios | 42 |
| Risk level | MEDIUM |
| Source spec | `docs/plans/NQL-PARSER-AUDIT-2026-01.md` Section 11 |
| Package | `packages/nql` |

## 1. Problem Statement

The current NQL v1 parser in `packages/cli` has architectural limitations: hand-rolled recursive descent parser with limited error recovery, no schema validation, and inconsistent syntax. NQL v2.0 introduces a robust Chevrotain-based parser with:

- Pipeline syntax for reads (`table | where | select`)
- SQL-familiar mutations (`insert into`, `update`, `delete from`)
- Position-aware `where` (pre-group → WHERE, post-group → HAVING)
- CTE support via `let` bindings
- Intent-first joins (planner infers LEFT/INNER from schema)
- LLM-friendly features (strict mode, suggestions, multi-error reporting)

## 2. User Stories

### US-1: Query Authoring (Developer)

**AS A** developer using the REPL
**I WANT** to write type-safe queries with pipeline syntax
**SO THAT** I can explore data interactively with good error messages

**ACCEPTANCE:**
- Pipeline syntax works: `products | where active = true | select name, price`
- Typos get suggestions: "Column 'stauts' not found. Did you mean 'status'?"
- Multiple errors reported at once (not just first error)

### US-2: Mutation Safety (Developer)

**AS A** developer performing data mutations
**I WANT** SQL-familiar mutation syntax with type safety
**SO THAT** I can safely insert/update/delete with compile-time validation

**ACCEPTANCE:**
- INSERT: `insert into products set name = 'X', price = 99`
- UPDATE with FK traversal: `update products set price = price * 0.9 where category.name = 'Sale'`
- DELETE requires WHERE: `delete from products where id = 5`
- RETURNING via pipeline: `insert into products set ... | select id, name`

### US-3: LLM Integration (AI Agent)

**AS A** LLM agent generating database queries
**I WANT** deterministic syntax with strict mode
**SO THAT** I can generate valid queries without guessing intent

**ACCEPTANCE:**
- Strict mode rejects aliases (`filter` → must use `where`)
- Canonical pretty-printer normalizes output
- Schema introspection commands (`.schema`, `.tables`, `.columns`)
- Error messages include fix suggestions

## 3. Business Rules

### 3.1 Invariants (always true)

- **INV-01:** All identifiers are validated against injection patterns (no `--`, `/*`, `;`)
- **INV-02:** String literals are always parameterized, never interpolated
- **INV-03:** Parse errors include source position (line, column)
- **INV-04:** AST is schema-agnostic (semantic layer validates against schema)
- **INV-05:** `let` bindings have CTE semantics (lazy, not materialized unless reused)

### 3.2 Preconditions (required before action)

- **PRE-01:** Schema must be provided for semantic validation
- **PRE-02:** `delete` statement MUST have `where` clause (no accidental mass delete)
- **PRE-03:** Scalar subquery MUST have at least one pipe (`(table | ...)`)

### 3.3 Effects (what changes)

- **EFF-01:** Parse produces NQL AST nodes
- **EFF-02:** Semantic validation resolves names and types
- **EFF-03:** Compilation transforms NQL AST → IntentAST (from `@dbsp/core`)
- **EFF-04:** `let` bindings create CTE nodes in IntentAST

### 3.4 Error Handling

| Error Code | When | Response |
|------------|------|----------|
| **ERR-LEX-001** | Unrecognized token | "Unexpected character 'X' at line Y, column Z" |
| **ERR-PARSE-001** | Syntax error | "Expected 'where' or 'select' after table name" |
| **ERR-PARSE-002** | Missing WHERE on DELETE | "DELETE requires WHERE clause to prevent accidental data loss" |
| **ERR-SEM-001** | Unknown column | "Column 'X' not found in table 'Y'. Did you mean 'Z'?" |
| **ERR-SEM-002** | Aggregate before GROUP BY | "Aggregate function not allowed before GROUP BY" |
| **ERR-SEM-003** | Circular let reference | "Circular reference: X → Y → X" |
| **ERR-SEM-004** | Duplicate let name | "Variable 'X' already defined" |
| **ERR-LIMIT-001** | Query too complex | "Query exceeds maximum subquery depth (10)" |

## 4. Technical Design

### 4.1 Architecture Decision

**Choice:** Chevrotain (embedded DSL parser)

**Why:**
- No codegen step (unlike ANTLR, PEG.js)
- Excellent error recovery and messages
- TypeScript-native
- Proven at scale (Monaco editor, CosmosDBADR selected in ADR-003)

**Alternatives rejected:**
- ANTLR: Java-based, codegen friction
- PEG.js: Limited error recovery
- Tree-sitter: Overkill for embedded DSL, C dependency

### 4.2 Package Structure

```
packages/nql/
├── package.json            # @dbsp/nql
├── tsconfig.json
├── src/
│   ├── index.ts            # Public API: parse(), validate(), compile()
│   ├── lexer/
│   │   ├── tokens.ts       # Chevrotain token definitions
│   │   └── index.ts        # NqlLexer export
│   ├── parser/
│   │   ├── grammar.ts      # Chevrotain grammar (CstParser)
│   │   ├── ast.ts          # NQL AST types (NqlQuery, NqlMutation, etc.)
│   │   └── visitor.ts      # CST → AST transformer
│   ├── semantic/
│   │   ├── validator.ts    # Schema validation
│   │   ├── resolver.ts     # Name resolution, type checking
│   │   └── suggestions.ts  # Fuzzy matching for typos
│   ├── compiler/
│   │   └── to-intent.ts    # NQL AST → IntentAST
│   ├── features/
│   │   ├── dates.ts        # Relative date parsing ('last 7 days')
│   │   ├── strict.ts       # Strict mode enforcement
│   │   └── pretty.ts       # Pretty printer / normalizer
│   └── errors/
│       ├── types.ts        # NqlError, NqlParseError, NqlSemanticError
│       └── formatter.ts    # Error message formatting
└── tests/
    ├── lexer.test.ts
    ├── parser.test.ts
    ├── semantic.test.ts
    ├── compiler.test.ts
    └── e2e.test.ts
```

### 4.3 Data Flow

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌───────────┐
│  Input  │───►│  Lexer  │───►│ Parser  │───►│Semantic │───►│ Compiler  │
│ (string)│    │(tokens) │    │  (AST)  │    │(checked)│    │(IntentAST)│
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └───────────┘
                                                │
                                                ▼
                                          ┌─────────┐
                                          │ @dbsp/  │
                                          │  core   │
                                          │ planner │
                                          └─────────┘
```

### 4.4 Public API

```typescript
// packages/nql/src/index.ts

export interface ParseOptions {
  strictMode?: boolean;        // Reject aliases (default: true)
  maxSubqueryDepth?: number;   // Default: 10
  maxClauses?: number;         // Default: 20
}

export interface ParseResult<T> {
  success: boolean;
  ast?: T;
  errors: NqlError[];
  warnings: NqlWarning[];
}

// Parse only (no schema validation)
export function parse(input: string, options?: ParseOptions): ParseResult<NqlProgram>;

// Parse + validate against schema
export function validate(
  input: string,
  schema: ModelIR,
  options?: ParseOptions
): ParseResult<NqlProgram>;

// Parse + validate + compile to IntentAST
export function compile(
  input: string,
  schema: ModelIR,
  options?: ParseOptions
): ParseResult<QueryIntent | MutationIntent>;

// Pretty print NQL AST
export function format(ast: NqlProgram): string;

// Type exports
export * from './parser/ast';
export * from './errors/types';
```

### 4.5 Dependencies

| Dependency | Type | Version | Purpose |
|------------|------|---------|---------|
| `chevrotain` | prod | `^11.0.0` | Parser framework |
| `@dbsp/core` | prod | `workspace:*` | IntentAST types, ModelIR |
| `vitest` | dev | `catalog:` | Testing |
| `tsup` | dev | `catalog:` | Build |

## 5. Acceptance Criteria (BDD)

### Scenario Group: Lexer

```gherkin
@priority:high @type:nominal
Scenario: LEX-01 Tokenize simple query
  Given input "products | where active = true"
  When lexer tokenizes
  Then tokens are [Identifier("products"), Pipe, Where, Identifier("active"), Equals, True]

@priority:high @type:edge
Scenario: LEX-02 Quoted identifier with reserved word
  Given input '"order" | where id = 1'
  When lexer tokenizes
  Then tokens include QuotedIdentifier("order")

@priority:high @type:edge
Scenario: LEX-03 String with escaped quote
  Given input "where name = 'O''Brien'"
  When lexer tokenizes
  Then string literal value is "O'Brien"

@priority:medium @type:error
Scenario: LEX-04 Invalid character
  Given input "products | where @ = 1"
  When lexer tokenizes
  Then error contains "Unexpected character '@'"
```

### Scenario Group: Parser - Queries

```gherkin
@priority:high @type:nominal
Scenario: PARSE-Q01 Simple table reference
  Given input "products"
  When parser parses
  Then AST is Query { table: "products", clauses: [] }

@priority:high @type:nominal
Scenario: PARSE-Q02 Filter with comparison
  Given input "products | where price > 100"
  When parser parses
  Then AST has WhereClause with Comparison { left: "price", op: ">", right: 100 }

@priority:high @type:nominal
Scenario: PARSE-Q03 Multiple where clauses (ANDed)
  Given input "products | where active = true | where price > 100"
  When parser parses
  Then AST has 2 WhereClause nodes

@priority:high @type:nominal
Scenario: PARSE-Q04 Select with alias
  Given input "products | select name, price * 0.9 as discounted"
  When parser parses
  Then AST has SelectClause with 2 items, second has alias "discounted"

@priority:high @type:nominal
Scenario: PARSE-Q05 Join with `with`
  Given input "products | with category | select name, category.name"
  When parser parses
  Then AST has WithClause { joins: [{ relation: "category" }] }

@priority:high @type:nominal
Scenario: PARSE-Q06 Join with `via` disambiguation
  Given input "orders | with users via created_by | select id, users.name"
  When parser parses
  Then AST has WithClause { joins: [{ relation: "users", via: "created_by" }] }

@priority:high @type:nominal
Scenario: PARSE-Q07 Aggregation with group by
  Given input "orders | group by customer_id | select customer_id, sum(amount)"
  When parser parses
  Then AST has GroupByClause and SelectClause with FunctionCall("sum")

@priority:high @type:nominal
Scenario: PARSE-Q08 Order by with direction
  Given input "products | order by price desc, name asc"
  When parser parses
  Then AST has OrderByClause with 2 items

@priority:high @type:nominal
Scenario: PARSE-Q09 Limit and offset
  Given input "products | limit 10 | offset 20"
  When parser parses
  Then AST has LimitClause(10) and OffsetClause(20)

@priority:high @type:nominal
Scenario: PARSE-Q10 BETWEEN expression
  Given input "products | where price between 100 and 500"
  When parser parses
  Then AST has BetweenExpression { expr: "price", low: 100, high: 500 }

@priority:high @type:nominal
Scenario: PARSE-Q11 IN with value list
  Given input "products | where status in ('active', 'pending')"
  When parser parses
  Then AST has InExpression with values ["active", "pending"]

@priority:high @type:nominal
Scenario: PARSE-Q12 IN with date range literal
  Given input "orders | where created in 'last 7 days'"
  When parser parses
  Then AST has InExpression with DateRangeLiteral("last 7 days")

@priority:high @type:nominal
Scenario: PARSE-Q13 EXISTS subquery
  Given input "products | where exists (images | where product_id = id)"
  When parser parses
  Then AST has ExistsExpression with Subquery

@priority:high @type:nominal
Scenario: PARSE-Q14 IS NULL check
  Given input "products | where deleted_at is null"
  When parser parses
  Then AST has IsNullExpression { negated: false }

@priority:high @type:nominal
Scenario: PARSE-Q15 IS NOT NULL check
  Given input "products | where deleted_at is not null"
  When parser parses
  Then AST has IsNullExpression { negated: true }

@priority:high @type:nominal
Scenario: PARSE-Q16 Scalar subquery in expression
  Given input "products | where category_id = (categories | where name = 'Phones' | select id)"
  When parser parses
  Then AST has Comparison with Subquery on right side

@priority:medium @type:edge
Scenario: PARSE-Q17 Relation star
  Given input "products | select name, category.*"
  When parser parses
  Then AST has SelectItem { type: "relationStar", relation: ["category"] }

@priority:high @type:nominal
Scenario: PARSE-Q18 Let binding (CTE)
  Given input "let active = users | where active = true\nactive | select name"
  When parser parses
  Then AST is Program { bindings: [LetBinding("active")], statement: Query }
```

### Scenario Group: Parser - Mutations

```gherkin
@priority:high @type:nominal
Scenario: PARSE-M01 INSERT
  Given input "insert into products set name = 'iPhone', price = 999"
  When parser parses
  Then AST is MutationPipeline { mutation: Insert { table: "products", assignments: [...] } }

@priority:high @type:nominal
Scenario: PARSE-M02 UPDATE with WHERE
  Given input "update products set price = price * 0.9 where category_id = 5"
  When parser parses
  Then AST has Update with assignments and where condition

@priority:high @type:nominal
Scenario: PARSE-M03 DELETE with WHERE
  Given input "delete from products where id = 5"
  When parser parses
  Then AST has Delete with where condition

@priority:high @type:error
Scenario: PARSE-M04 DELETE without WHERE is error
  Given input "delete from products"
  When parser parses
  Then error is "DELETE requires WHERE clause"

@priority:high @type:nominal
Scenario: PARSE-M05 UPSERT
  Given input "upsert into products on (sku) set name = 'X', sku = 'ABC'"
  When parser parses
  Then AST has Upsert { conflictColumns: ["sku"] }

@priority:high @type:nominal
Scenario: PARSE-M06 INSERT with RETURNING (pipeline)
  Given input "insert into products set name = 'X' | select id, name"
  When parser parses
  Then AST is MutationPipeline with SelectClause

@priority:high @type:nominal
Scenario: PARSE-M07 Mutation with bind for chaining
  Given input "insert into products set name = 'X' | bind product"
  When parser parses
  Then AST has MutationPipeline with BindClause { name: "product" }
```

### Scenario Group: Semantic Validation

```gherkin
@priority:high @type:error
Scenario: SEM-01 Unknown column suggests similar
  Given schema with table "products" columns ["name", "status", "price"]
  And input "products | where stauts = 'active'"
  When validator runs
  Then error contains "Did you mean 'status'?"

@priority:high @type:error
Scenario: SEM-02 Aggregate before GROUP BY
  Given input "products | where count(*) > 5 | group by category_id"
  When validator runs
  Then error is "Aggregate function not allowed before GROUP BY"

@priority:high @type:nominal
Scenario: SEM-03 Aggregate after GROUP BY (valid)
  Given input "products | group by category_id | where count(*) > 5"
  When validator runs
  Then validation passes

@priority:high @type:error
Scenario: SEM-04 Duplicate let binding
  Given input "let x = a | where true\nlet x = b | where true"
  When validator runs
  Then error is "Variable 'x' already defined"

@priority:high @type:error
Scenario: SEM-05 Circular let reference
  Given input "let x = y | select *\nlet y = x | select *"
  When validator runs
  Then error is "Circular reference detected"

@priority:high @type:security
Scenario: SEM-06 Injection pattern in identifier
  Given input 'products | where "col--drop" = 1'
  When validator runs
  Then error is "Invalid identifier pattern"
```

### Scenario Group: Compiler (NQL → IntentAST)

```gherkin
@priority:high @type:nominal
Scenario: COMP-01 Simple query to SelectIntent
  Given validated NQL "products | where active = true | select name"
  When compiler runs
  Then IntentAST is SelectIntent { from: "products", where: {...}, columns: ["name"] }

@priority:high @type:nominal
Scenario: COMP-02 Position-aware WHERE/HAVING
  Given validated NQL "orders | where status = 'done' | group by customer_id | where count(*) > 5"
  When compiler runs
  Then IntentAST has where condition AND having condition

@priority:high @type:nominal
Scenario: COMP-03 Let binding to CTE
  Given validated NQL "let active = users | where active = true\norders | where user_id in (active | select id)"
  When compiler runs
  Then IntentAST includes CTE definition for "active"

@priority:high @type:nominal
Scenario: COMP-04 Join via `with` to IncludeIntent
  Given validated NQL "products | with category | select name, category.name"
  When compiler runs
  Then IntentAST has include { relation: "category" }
```

### Scenario Group: Strict Mode

```gherkin
@priority:high @type:nominal
Scenario: STRICT-01 Reject alias in strict mode
  Given strictMode = true
  And input "products | filter active = true"
  When parser parses
  Then error is "Unknown keyword 'filter'. Did you mean 'where'?"

@priority:medium @type:nominal
Scenario: STRICT-02 Accept alias in permissive mode
  Given strictMode = false
  And input "products | filter active = true"
  When parser parses
  Then AST has WhereClause (alias accepted)
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| LEX-01 | ✓ | | | |
| LEX-02 | | ✓ | | |
| LEX-03 | | ✓ | | |
| LEX-04 | | | ✓ | |
| PARSE-Q01-Q18 | ✓ | ✓ | | |
| PARSE-M01-M07 | ✓ | | ✓ | |
| SEM-01-05 | | | ✓ | |
| SEM-06 | | | | ✓ |
| COMP-01-04 | ✓ | | | |
| STRICT-01-02 | ✓ | | ✓ | |

**Total: 42 scenarios** (30 nominal, 4 edge, 7 error, 1 security)

## 6. Implementation Plan

### Block 1: Package Scaffold (~4h)

**Type:** Infrastructure
**Dependencies:** None
**Files:**
- `packages/nql/package.json` — new package
- `packages/nql/tsconfig.json` — TypeScript config
- `packages/nql/tsup.config.ts` — Build config
- `packages/nql/src/index.ts` — Entry point stub
- `pnpm-workspace.yaml` — Add nql package (already done)

**Exit criteria:**
- [ ] `pnpm install` succeeds
- [ ] `pnpm -F @dbsp/nql build` succeeds
- [ ] Empty package exports from index

### Block 2: Lexer (~6h)

**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/nql/src/lexer/tokens.ts` — All token definitions (already started)
- `packages/nql/src/lexer/index.ts` — NqlLexer export
- `packages/nql/tests/lexer.test.ts` — Lexer tests

**Scenarios covered:** LEX-01, LEX-02, LEX-03, LEX-04

**Exit criteria:**
- [ ] All 35+ tokens defined
- [ ] Quoted identifiers tokenized correctly
- [ ] String escape sequences handled
- [ ] 4 lexer tests pass

### Block 3: Parser Core (~12h)

**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `packages/nql/src/parser/ast.ts` — AST types (already started)
- `packages/nql/src/parser/grammar.ts` — Chevrotain grammar
- `packages/nql/src/parser/visitor.ts` — CST → AST visitor
- `packages/nql/tests/parser.test.ts` — Parser tests

**Scenarios covered:** PARSE-Q01 to PARSE-Q18, PARSE-M01 to PARSE-M07

**Exit criteria:**
- [ ] Query pipeline parsing works
- [ ] All mutation types parse
- [ ] Let bindings parse
- [ ] 25 parser tests pass

### Block 4: Semantic Layer (~10h)

**Type:** Feature slice
**Dependencies:** Block 3
**Files:**
- `packages/nql/src/semantic/validator.ts` — Schema validation
- `packages/nql/src/semantic/resolver.ts` — Name resolution
- `packages/nql/src/semantic/suggestions.ts` — Fuzzy matching
- `packages/nql/src/errors/types.ts` — Error types
- `packages/nql/src/errors/formatter.ts` — Error formatting
- `packages/nql/tests/semantic.test.ts` — Semantic tests

**Scenarios covered:** SEM-01 to SEM-06

**Exit criteria:**
- [ ] Column name validation against schema
- [ ] Aggregate position validation (WHERE vs HAVING)
- [ ] Let binding cycle detection
- [ ] Fuzzy suggestions for typos
- [ ] 6 semantic tests pass

### Block 5: Compiler (NQL → IntentAST) (~6h)

**Type:** Feature slice
**Dependencies:** Block 4
**Files:**
- `packages/nql/src/compiler/to-intent.ts` — NQL → IntentAST
- `packages/nql/tests/compiler.test.ts` — Compiler tests

**Scenarios covered:** COMP-01 to COMP-04

**Exit criteria:**
- [ ] Query compiles to SelectIntent
- [ ] Position-aware where → WHERE/HAVING
- [ ] Let bindings → CTEs
- [ ] Joins → IncludeIntent
- [ ] 4 compiler tests pass

### Block 6: Features & Integration (~6h)

**Type:** Feature slice + Integration
**Dependencies:** Block 5
**Files:**
- `packages/nql/src/features/dates.ts` — Relative date parsing
- `packages/nql/src/features/strict.ts` — Strict mode
- `packages/nql/src/features/pretty.ts` — Pretty printer
- `packages/nql/src/index.ts` — Public API (finalize)
- `packages/nql/tests/e2e.test.ts` — E2E tests
- `packages/cli/src/repl/parser.ts` — Use @dbsp/nql (if time permits)

**Scenarios covered:** STRICT-01, STRICT-02, plus E2E integration

**Exit criteria:**
- [ ] Strict mode enforced
- [ ] Pretty printer produces canonical output
- [ ] Relative dates parse ('last 7 days')
- [ ] Public API complete (`parse`, `validate`, `compile`, `format`)
- [ ] E2E tests pass

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~30 | Lexer tokens, parser rules, individual validators |
| Integration | ~10 | End-to-end parse → compile flows |
| E2E | ~5 | Full pipeline with real schema |

### Test Data Requirements

**Fixtures:**
- `test-schema.ts` — Minimal schema (products, categories, orders, users)
- `queries.txt` — Sample valid queries
- `invalid-queries.txt` — Sample invalid queries with expected errors

**Mocks:**
- None needed (pure parsing, no external dependencies)

### Test Configuration

```typescript
// packages/nql/vitest.config.ts
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
      },
    },
  },
});
```

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Chevrotain learning curve | M | L | Team has ANTLR experience, concepts transfer |
| Grammar ambiguity discovered late | H | M | Early prototyping in Block 3, /adversarial completed |
| Performance on large queries | M | L | Chevrotain is optimized; add benchmarks in Block 6 |
| Integration with existing CLI | M | M | Defer CLI integration to separate PR if needed |
| Date parsing complexity | L | M | Use battle-tested chrono-node or similar |

## 9. Definition of Done

- [ ] All 6 blocks implemented
- [ ] All 42 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + E2E)
- [ ] `pnpm lint` and `pnpm typecheck` pass
- [ ] Documentation updated:
  - [ ] `docs/DOCUMENTATION_INDEX.md` updated with NQL spec
  - [ ] `README.md` in `packages/nql/`
- [ ] `/review` clean (no blocking findings)
- [ ] Package exports work: `import { parse, compile } from '@dbsp/nql'`

---

## Appendix A: AST Type Reference

See `packages/nql/src/parser/ast.ts` for full type definitions.

Key types:
- `NqlProgram` — Top-level with bindings + statement
- `NqlQuery` — Table + clauses pipeline
- `NqlMutationPipeline` — Mutation + optional RETURNING
- `NqlClause` — where, select, with, group by, order by, limit, offset
- `NqlExpression` — Binary, unary, comparison, function call, path, literal, subquery

## Appendix B: Token Reference

See `packages/nql/src/lexer/tokens.ts` for full token definitions.

Key token groups:
- Keywords: select, where, with, via, let, bind, group by, order by, etc.
- Operators: =, !=, <, >, <=, >=, like, and, or, not, in, between
- Literals: StringLiteral, NumberLiteral, True, False, Null
- Punctuation: Pipe, Comma, Dot, Star, LParen, RParen

## Appendix C: Error Code Reference

| Code | Category | Description |
|------|----------|-------------|
| ERR-LEX-* | Lexer | Tokenization errors |
| ERR-PARSE-* | Parser | Syntax errors |
| ERR-SEM-* | Semantic | Validation errors |
| ERR-LIMIT-* | Limits | Complexity exceeded |
